import 'server-only';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getAdminClient } from '@synapcores/app-framework/db/server';
import { invalidateReports, reportDb } from './report-db';
import { ensureEventsTable, eventsReadTable, lit, visitorContext, windowStart } from './event-store';
import { TOUCH_EVENTS } from './collector';
import { sqlTs } from './visitor/events';
import {
  DOWNLOADS_FILE,
  DOWNLOADS_RECORD_TYPES,
  DOWNLOADS_SCHEMA,
  INSTALLS_FILE,
  INSTALLS_RECORD_TYPES,
  INSTALLS_SCHEMA,
  MAX_FEED_BYTES,
  downloadsRecords,
  emptyImportResult,
  importIntervalMinutes,
  installsRecords,
  metaPayload,
  metaRowId,
  parseDeleteFraction,
  parseDownloadsFeed,
  parseInstallsFeed,
  parseStoredMeta,
  parseStoredRow,
  planImport,
  rowHash,
  type DownloadsHeader,
  type FeedKind,
  type FeedMeta,
  type FeedRecord,
  type ImportResult,
  type InstallationRow,
  type InstallsHeader,
  type PersonRow,
  type PlannedRow,
  type RecordType,
  type SnapshotRow,
} from './installs/feed';

/**
 * Installs feed — import + reads (`pm_install_feed`).
 *
 * The telemetry export job (not this app) writes sanitized JSONL drop files
 * into INSTALLS_FEED_DIR (prod: /var/lib/synapcores-installs-feed/). This app
 * never holds the telemetry key: it only reads those files, validates them
 * strictly (lib/installs/feed.ts — fail closed: a bad file is logged and the
 * stored rows stay) and keeps them in its own database, one row per
 * installation / person / daily download snapshot plus a meta row per file.
 *
 * Engine constraints (SynapCores CE): DDL leaks memory, so the table + index
 * are ensured once per process and never dropped; steady-state imports write
 * only what changed — one UPDATE per changed row, ≤ 100-row INSERT / DELETE
 * batches — and nothing at all when the file's size + mtime are unchanged.
 *
 * Env: INSTALLS_FEED_DIR (unset = feature off), INSTALLS_FEED_TENANT_ID (the
 * workspace that owns the rows and sees the Installs page; required when on),
 * INSTALLS_FEED_MAX_DELETE_FRACTION (default 0.5), INSTALLS_FEED_IMPORT_MINUTES
 * (default 5, see instrumentation.ts), INSTALLS_DOWNLOAD_SITES (default
 * "synapcores.com,www.synapcores.com").
 */

const db = () => getAdminClient();
type Row = Record<string, unknown>;

export const PM_INSTALL_FEED_DDL = `CREATE TABLE IF NOT EXISTS pm_install_feed (
  row_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, record_type TEXT NOT NULL, record_id TEXT NOT NULL,
  class TEXT, first_seen TIMESTAMP, last_seen TIMESTAMP, payload TEXT NOT NULL, row_hash TEXT NOT NULL, imported_at TIMESTAMP)`;
const PM_INSTALL_FEED_INDEX = `CREATE INDEX IF NOT EXISTS idx_pm_install_feed_tenant ON pm_install_feed(tenant_id)`;
const COLUMNS = 'row_id, tenant_id, record_type, record_id, class, first_seen, last_seen, payload, row_hash, imported_at';
const BATCH = 100;
/** One installs file (≤ 20,000 lines) + ≤ 400 snapshots + 2 meta rows. */
const MAX_STORED_ROWS = 20_500;

// ── config ───────────────────────────────────────────────────────────────────
export interface InstallsFeedConfig {
  dir: string | null;
  tenantId: string | null;
  enabled: boolean;
}

export function installsFeedConfig(env: NodeJS.ProcessEnv = process.env): InstallsFeedConfig {
  const dir = env.INSTALLS_FEED_DIR?.trim() || null;
  const tenantId = env.INSTALLS_FEED_TENANT_ID?.trim() || null;
  return { dir, tenantId, enabled: !!dir && !!tenantId };
}

/** Feature on and this workspace is the one the feed belongs to. */
export function installsFeedEnabledFor(tenantId: string | null | undefined): boolean {
  const c = installsFeedConfig();
  return c.enabled && !!tenantId && c.tenantId === tenantId;
}

export const importIntervalMs = () => importIntervalMinutes(process.env.INSTALLS_FEED_IMPORT_MINUTES) * 60_000;

// ── process-wide state (pages and instrumentation are separate module instances) ──
interface FeedState {
  ensured: Promise<void> | null;
  inflight: Promise<ImportResult[]> | null;
  /** file → "size:mtimeMs" of the last version handled in this process. */
  seen: Map<string, string>;
  logged: Set<string>;
}

const STATE_KEY = Symbol.for('synapcores.marketing-performance.installs-feed');

function state(): FeedState {
  const g = globalThis as unknown as Record<symbol, FeedState | undefined>;
  let s = g[STATE_KEY];
  if (!s) {
    s = { ensured: null, inflight: null, seen: new Map(), logged: new Set() };
    g[STATE_KEY] = s;
  }
  return s;
}

function logOnce(key: string, msg: string): void {
  const s = state();
  if (s.logged.has(key)) return;
  s.logged.add(key);
  console.log(msg);
}

/** CREATE TABLE / INDEX IF NOT EXISTS — once per process (DDL leaks memory on the engine; never DROP). */
export function ensureInstallsTable(): Promise<void> {
  const s = state();
  if (!s.ensured) {
    s.ensured = (async () => {
      await db().sql(PM_INSTALL_FEED_DDL);
      await db().sql(PM_INSTALL_FEED_INDEX);
    })().catch((e) => {
      s.ensured = null;
      throw e;
    });
  }
  return s.ensured;
}

// ── import ───────────────────────────────────────────────────────────────────
interface FileSpec {
  kind: FeedKind;
  file: string;
  types: readonly RecordType[];
  optional: boolean;
}

const FILES: readonly FileSpec[] = [
  { kind: 'installs', file: INSTALLS_FILE, types: INSTALLS_RECORD_TYPES, optional: false },
  { kind: 'downloads', file: DOWNLOADS_FILE, types: DOWNLOADS_RECORD_TYPES, optional: true },
];

/**
 * Import both drop files (installs, then GitHub downloads). Overlapping calls
 * share the run in flight. Returns one result per file; a file that failed
 * with a DB error is logged here and retried on the next run.
 */
export function importInstallsFeed(): Promise<ImportResult[]> {
  const s = state();
  if (s.inflight) return s.inflight;
  const p = runImport().finally(() => {
    s.inflight = null;
  });
  s.inflight = p;
  return p;
}

async function runImport(): Promise<ImportResult[]> {
  const cfg = installsFeedConfig();
  if (!cfg.dir) return [];
  if (!cfg.tenantId) {
    logOnce('no-tenant', '[installs-feed] INSTALLS_FEED_TENANT_ID is not set; not importing');
    return [];
  }
  const out: ImportResult[] = [];
  for (const spec of FILES) {
    try {
      out.push(await importFile(path.resolve(cfg.dir), cfg.tenantId, spec));
    } catch (e) {
      console.error(`[installs-feed] import of ${spec.file} failed:`, (e as Error).message);
    }
  }
  return out;
}

const sqlTime = (iso: string | null) => (iso ? iso.slice(0, 19).replace('T', ' ') : null);

async function importFile(dir: string, tenantId: string, spec: FileSpec): Promise<ImportResult> {
  const s = state();
  const res = emptyImportResult(spec.file);
  const full = path.join(dir, spec.file);
  let st;
  try {
    st = await fs.stat(full);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'error';
    if (code === 'ENOENT') {
      logOnce(`missing:${spec.file}`, `[installs-feed] ${spec.file} not found in ${dir}${spec.optional ? ' (optional)' : ''}; it is imported once the export job writes it`);
    } else {
      logOnce(`stat:${spec.file}:${code}`, `[installs-feed] cannot read ${spec.file} in ${dir}: ${code}`);
    }
    res.skipped = true;
    return res;
  }
  s.logged.delete(`missing:${spec.file}`); // log again if it disappears later
  const sig = `${st.size}:${st.mtimeMs}`;
  if (s.seen.get(spec.file) === sig) {
    res.skipped = true;
    return res;
  }
  const reject = (why: string) => {
    console.warn(`[installs-feed] rejected ${spec.file}: ${why}`);
    res.rejected = why;
    s.seen.set(spec.file, sig); // don't re-validate (and re-log) the same bad version every run
    return res;
  };
  if (!st.isFile()) return reject('not a regular file');
  if (st.size > MAX_FEED_BYTES) return reject(`file is larger than ${MAX_FEED_BYTES / 1048576} MB`);
  const buf = await fs.readFile(full);
  if (buf.length > MAX_FEED_BYTES) return reject(`file is larger than ${MAX_FEED_BYTES / 1048576} MB`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return reject('file is not valid UTF-8');
  }

  let header: InstallsHeader | DownloadsHeader;
  let records: FeedRecord[];
  let saltId: string | null = null;
  if (spec.kind === 'installs') {
    const p = parseInstallsFeed(text);
    if (!p.ok) return reject(p.error);
    header = p.feed.header;
    saltId = p.feed.header.salt_id;
    records = installsRecords(p.feed);
    res.blanked = p.blankedValues;
  } else {
    const p = parseDownloadsFeed(text);
    if (!p.ok) return reject(p.error);
    header = p.feed.header;
    records = downloadsRecords(p.feed);
    res.blanked = p.blankedValues;
  }
  res.generated_at = header.generated_at;

  await ensureInstallsTable();
  const typeList = spec.types.map(lit).join(',');
  const [existing, metaRows] = await Promise.all([
    db().sql<Row>(`SELECT row_id, row_hash, record_type FROM pm_install_feed WHERE tenant_id = $1 AND record_type IN (${typeList}) LIMIT 50000`, [tenantId]),
    db().sql<Row>(`SELECT payload FROM pm_install_feed WHERE tenant_id = $1 AND row_id = $2 LIMIT 1`, [tenantId, metaRowId(tenantId, spec.kind)]),
  ]);
  const metaRow = metaRows.rows[0];
  const meta = metaRow ? parseStoredMeta(String(metaRow.payload ?? '')) : null;
  const storedSalt = meta && meta.header.schema === INSTALLS_SCHEMA ? meta.header.salt_id : null;
  const plan = planImport(
    existing.rows.map((r) => ({ row_id: String(r.row_id), row_hash: String(r.row_hash ?? ''), record_type: String(r.record_type) })),
    records,
    { tenantId, recordTypes: spec.types, maxDeleteFraction: parseDeleteFraction(process.env.INSTALLS_FEED_MAX_DELETE_FRACTION), saltId, storedSaltId: storedSalt },
  );
  if (plan.refused) {
    res.refused = plan.refused;
    s.seen.set(spec.file, sig);
    return res;
  }

  const now = sqlTs(new Date());
  const t = lit(tenantId);
  let wrote = false;
  const write = async (sql: string) => {
    wrote = true;
    await db().sql(sql);
  };
  try {
    for (const r of plan.update) {
      await write(
        `UPDATE pm_install_feed SET payload = ${lit(r.payload)}, class = ${lit(r.class)}, first_seen = ${lit(sqlTime(r.first_seen))}, last_seen = ${lit(sqlTime(r.last_seen))},
                row_hash = ${lit(r.row_hash)}, imported_at = ${lit(now)} WHERE tenant_id = ${t} AND row_id = ${lit(r.row_id)}`,
      );
    }
    for (let i = 0; i < plan.insert.length; i += BATCH) {
      const values = plan.insert.slice(i, i + BATCH).map((r: PlannedRow) => `(${[r.row_id, tenantId, r.record_type, r.record_id, r.class, sqlTime(r.first_seen), sqlTime(r.last_seen), r.payload, r.row_hash, now].map(lit).join(',')})`);
      await write(`INSERT INTO pm_install_feed (${COLUMNS}) VALUES ${values.join(',')}`);
    }
    for (let i = 0; i < plan.delete.length; i += BATCH) {
      await write(`DELETE FROM pm_install_feed WHERE tenant_id = ${t} AND row_id IN (${plan.delete.slice(i, i + BATCH).map(lit).join(',')})`);
    }
    // Meta row: last header + import time + file hash, only when a new generation arrived.
    if (!meta || meta.header.generated_at !== header.generated_at) {
      const payload = metaPayload(spec.file, header, new Date().toISOString().slice(0, 19) + 'Z', createHash('sha256').update(buf).digest('hex'));
      const gen = sqlTime(header.generated_at);
      if (metaRow) {
        await write(
          `UPDATE pm_install_feed SET payload = ${lit(payload)}, first_seen = ${lit(gen)}, last_seen = ${lit(gen)}, row_hash = ${lit(rowHash(payload))}, imported_at = ${lit(now)}
            WHERE tenant_id = ${t} AND row_id = ${lit(metaRowId(tenantId, spec.kind))}`,
        );
      } else {
        await write(
          `INSERT INTO pm_install_feed (${COLUMNS}) VALUES (${[metaRowId(tenantId, spec.kind), tenantId, 'meta', spec.kind, null, gen, gen, payload, rowHash(payload), now].map(lit).join(',')})`,
        );
      }
      res.meta_updated = true;
    }
  } finally {
    if (wrote) invalidateReports(tenantId);
  }
  res.inserted = plan.insert.length;
  res.updated = plan.update.length;
  res.deleted = plan.delete.length;
  res.unchanged = plan.unchanged;
  res.salt_rotated = plan.saltRotated;
  s.seen.set(spec.file, sig);
  return res;
}

// ── reads (Installs page) ────────────────────────────────────────────────────
export interface StoredFeed {
  installations: InstallationRow[];
  people: PersonRow[];
  snapshots: SnapshotRow[];
  meta: { installs: FeedMeta<InstallsHeader> | null; downloads: FeedMeta<DownloadsHeader> | null };
  /** Stored rows that failed re-validation (skipped). */
  invalid: number;
  truncated: boolean;
}

/** Every stored row of the workspace, re-validated (one cached SELECT). */
export async function loadInstallsFeed(tenantId: string): Promise<StoredFeed> {
  await ensureInstallsTable();
  const r = await reportDb(tenantId).sql<Row>(`SELECT record_type, payload FROM pm_install_feed WHERE tenant_id = $1 LIMIT ${MAX_STORED_ROWS}`, [tenantId]);
  const out: StoredFeed = { installations: [], people: [], snapshots: [], meta: { installs: null, downloads: null }, invalid: 0, truncated: r.rows.length >= MAX_STORED_ROWS };
  for (const x of r.rows) {
    const type = String(x.record_type ?? '');
    const payload = String(x.payload ?? '');
    if (type === 'meta') {
      const m = parseStoredMeta(payload);
      if (!m) out.invalid++;
      else if (m.header.schema === INSTALLS_SCHEMA) out.meta.installs = { ...m, header: m.header };
      else if (m.header.schema === DOWNLOADS_SCHEMA) out.meta.downloads = { ...m, header: m.header };
      continue;
    }
    const row = parseStoredRow(type, payload);
    if (!row) out.invalid++;
    else if (row.type === 'installation') out.installations.push(row);
    else if (row.type === 'person') out.people.push(row);
    else out.snapshots.push(row);
  }
  return out;
}

// ── /download funnel (pm_events) ─────────────────────────────────────────────
export interface DownloadFunnel {
  since: string;
  sites: string[];
  /** Human visitors with a page view (touch event) on /download. */
  visitors: number;
  pageviews: number;
  /** Human visitors who sent install_command_copy / download_cta_click. */
  cta_visitors: number;
  /** Any such event ever (on these sites); false = not tracked yet. */
  cta_tracked: boolean;
  truncated: boolean;
}

const DEFAULT_DOWNLOAD_SITES = ['synapcores.com', 'www.synapcores.com'];
const DOWNLOAD_PATHS = ['/download', '/download/'];
export const CTA_EVENTS = ['install_command_copy', 'download_cta_click'];

/** INSTALLS_DOWNLOAD_SITES: comma-separated hostnames; default synapcores.com + www. */
export function downloadSites(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = (env.INSTALLS_DOWNLOAD_SITES ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^[a-z0-9][a-z0-9.-]{0,252}$/.test(x));
  return list.length ? [...new Set(list)] : DEFAULT_DOWNLOAD_SITES;
}

const TOUCH_LIST = [...TOUCH_EVENTS].map(lit).join(',');

export async function downloadFunnel(tenantId: string, days: number): Promise<DownloadFunnel> {
  await ensureEventsTable();
  const since = windowStart(days);
  const sites = downloadSites();
  const siteList = sites.map(lit).join(',');
  const ctaList = CTA_EVENTS.map(lit).join(',');
  const cap = 50_000;
  const rdb = reportDb(tenantId);
  const [visits, cta, ever, ctx] = await Promise.all([
    rdb.sql<Row>(
      `SELECT anonymous_id, SUM(CASE WHEN event_type = 'pageview' OR event_type = 'page_view' THEN 1 ELSE 0 END) AS pageviews
         FROM ${eventsReadTable()}
        WHERE tenant_id = $1 AND occurred_at >= $2 AND is_bot = FALSE AND site IN (${siteList})
          AND page_path IN (${DOWNLOAD_PATHS.map(lit).join(',')}) AND event_type IN (${TOUCH_LIST})
        GROUP BY anonymous_id LIMIT ${cap}`,
      [tenantId, since],
    ),
    rdb.sql<Row>(
      `SELECT anonymous_id FROM ${eventsReadTable()}
        WHERE tenant_id = $1 AND occurred_at >= $2 AND is_bot = FALSE AND site IN (${siteList}) AND event_type IN (${ctaList})
        GROUP BY anonymous_id LIMIT ${cap}`,
      [tenantId, since],
    ),
    rdb.sql<Row>(`SELECT anonymous_id FROM ${eventsReadTable()} WHERE tenant_id = $1 AND site IN (${siteList}) AND event_type IN (${ctaList}) LIMIT 1`, [tenantId]),
    visitorContext(tenantId),
  ]);
  // Humans only: bots, internal and suspected visitors are left out (like the conversion funnel).
  const human = (r: Row) => (ctx.kinds.get(String(r.anonymous_id))?.kind ?? 'human') === 'human';
  const v = visits.rows.filter(human);
  return {
    since,
    sites,
    visitors: v.length,
    pageviews: v.reduce((a, r) => a + Number(r.pageviews ?? 0), 0),
    cta_visitors: cta.rows.filter(human).length,
    cta_tracked: ever.rows.length > 0,
    truncated: visits.rows.length >= cap || cta.rows.length >= cap,
  };
}
