import 'server-only';
import { getAdminClient } from '@synapcores/app-framework/db/server';
import { PM_EVENTS_ADDED_COLUMNS, PM_EVENTS_DDL, PM_EVENT_COLUMNS, sqlTs, type PmEventRow } from './visitor/events';
import { CLASSIFIER_VERSION, classifyVisitor, type Classification } from './visitor/classify';
import type { CrawlerMatcher } from './visitor/crawler-ranges';
import { retentionCutoff, retentionDays, truncationSql } from './visitor/retention';
import { visitorSource } from './visitor/source';
import { buildFunnel, FUNNEL_EVENT_TYPES, type FunnelReport } from './visitor/funnel';

/**
 * Raw visitor events (`pm_events`) — writes from the collector, retention
 * sweep, and the tenant-scoped reads behind the Visitors pages + dashboard.
 *
 * Every read takes the workspace's tenant id and filters on it; values from the
 * request go through bound parameters ($n), never string concatenation.
 */

const db = () => getAdminClient();
type Row = Record<string, unknown>;

let ensured: Promise<void> | null = null;
export function ensureEventsTable(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      for (const ddl of PM_EVENTS_DDL) await db().sql(ddl);
      for (const [col, type] of PM_EVENTS_ADDED_COLUMNS) {
        try {
          await db().sql(`SELECT ${col} FROM pm_events LIMIT 1`);
        } catch {
          await db().sql(`ALTER TABLE pm_events ADD COLUMN ${col} ${type}`);
        }
      }
    })().catch((e) => {
      ensured = null;
      throw e;
    });
  }
  return ensured;
}

function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  // Standard SQL literal: the engine treats backslash literally, so doubling
  // single quotes is a complete escape. NULs are stripped.
  return `'${String(v).replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}

/** Insert enriched rows in one multi-row statement. Returns rows written. */
export async function insertEvents(rows: PmEventRow[]): Promise<number> {
  if (!rows.length) return 0;
  await ensureEventsTable();
  const values = rows.map((r) => '(' + PM_EVENT_COLUMNS.map((c) => lit(r[c])).join(',') + ')').join(',');
  await db().sql(`INSERT INTO pm_events (${PM_EVENT_COLUMNS.join(',')}) VALUES ${values}`);
  return rows.length;
}

/** Retention sweep: full IP → /24 or /48 prefix for events older than the window. */
export async function truncateExpiredIps(now = new Date()): Promise<{ cutoff: string; days: number; updated: number }> {
  await ensureEventsTable();
  const days = retentionDays();
  const cutoff = retentionCutoff(now, days);
  const res = await db().sql(truncationSql(cutoff));
  // The engine answers an UPDATE with a single [[count]] row.
  const first = res.rows[0] ? Object.values(res.rows[0] as Row)[0] : undefined;
  const updated = Number(typeof first === 'number' ? first : res.rowCount) || 0;
  return { cutoff, days, updated };
}

// ── reads ────────────────────────────────────────────────────────────────────
export interface VisitorFilters {
  kind?: 'all' | 'human' | 'bot';
  site?: string | null;
  country?: string | null;
  from?: string | null; // YYYY-MM-DD
  to?: string | null; // YYYY-MM-DD (inclusive)
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function whereClause(tenantId: string, f: VisitorFilters): { sql: string; params: unknown[] } {
  const params: unknown[] = [tenantId];
  const parts = ['tenant_id = $1'];
  const add = (cond: string, v: unknown) => {
    params.push(v);
    parts.push(cond.replace('?', `$${params.length}`));
  };
  if (f.site) add('site = ?', f.site);
  if (f.country) add('country = ?', f.country.toUpperCase());
  if (f.from && DAY.test(f.from)) add('occurred_at >= ?', `${f.from} 00:00:00`);
  if (f.to && DAY.test(f.to)) add('occurred_at <= ?', `${f.to} 23:59:59`);
  return { sql: parts.join(' AND '), params };
}

export interface VisitorSummary {
  anonymous_id: string;
  first_seen: string;
  last_seen: string;
  events: number;
  sessions: number;
  pageviews: number;
  pages: number;
  is_bot: boolean;
  bot_name: string | null;
  bot_category: string | null;
  bot_verified: string | null;
  ip: string | null;
  ip_truncated: boolean;
  country: string | null;
  country_name: string | null;
  region: string | null;
  city: string | null;
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  device_type: string | null;
  site: string | null;
  landing_path: string | null;
  source: string;
}

function placeholders(start: number, n: number): string {
  return Array.from({ length: n }, (_, i) => `$${start + i}`).join(',');
}

const asStr = (v: unknown) => (v == null ? null : String(v));
const asBool = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

export async function listVisitors(tenantId: string, f: VisitorFilters, limit = 200): Promise<VisitorSummary[]> {
  await ensureEventsTable();
  const w = whereClause(tenantId, f);
  const lim = Math.max(1, Math.min(500, Math.floor(limit)));
  // A visitor is a bot if ANY of its events is (a crawler that once sent a
  // browser-looking UA must not show up under "humans").
  const anyBot = 'MAX(CASE WHEN is_bot = TRUE THEN 1 ELSE 0 END)';
  const having = f.kind === 'bot' ? ` HAVING ${anyBot} = 1` : f.kind === 'human' ? ` HAVING ${anyBot} = 0` : '';
  const agg = await db().sql<Row>(
    `SELECT anonymous_id, MIN(occurred_at) AS first_seen, MAX(occurred_at) AS last_seen, COUNT(*) AS events,
            COUNT(DISTINCT session_id) AS sessions,
            SUM(CASE WHEN event_type = 'pageview' OR event_type = 'page_view' THEN 1 ELSE 0 END) AS pageviews,
            COUNT(DISTINCT page_path) AS pages,
            MAX(CASE WHEN is_bot = TRUE THEN 1 ELSE 0 END) AS any_bot
       FROM pm_events WHERE ${w.sql}
      GROUP BY anonymous_id${having} ORDER BY last_seen DESC LIMIT ${lim}`,
    w.params,
  );
  const ids = agg.rows.map((r) => String(r.anonymous_id));
  if (!ids.length) return [];
  const inList = placeholders(2, ids.length);
  // NB: tenant_id must be in the inner projection — SynapCores CE applies the
  // inner WHERE after projecting a window-function subquery.
  const latest = await db().sql<Row>(
    `SELECT * FROM (SELECT tenant_id, anonymous_id, ip, ip_truncated, country, country_name, region, city, browser, browser_version, os,
            device_type, is_bot, bot_name, bot_category, bot_verified, site,
            ROW_NUMBER() OVER (PARTITION BY anonymous_id ORDER BY is_bot DESC, occurred_at DESC) AS rn
       FROM pm_events WHERE tenant_id = $1 AND anonymous_id IN (${inList})) z WHERE rn = 1`,
    [tenantId, ...ids],
  );
  const first = await db().sql<Row>(
    `SELECT * FROM (SELECT tenant_id, anonymous_id, site, page_path, referrer_domain, utm_source, utm_medium, gclid, fbclid, ttclid, msclkid,
            ROW_NUMBER() OVER (PARTITION BY anonymous_id ORDER BY occurred_at ASC) AS rn
       FROM pm_events WHERE tenant_id = $1 AND anonymous_id IN (${inList})) z WHERE rn = 1`,
    [tenantId, ...ids],
  );
  const L = new Map(latest.rows.map((r) => [String(r.anonymous_id), r]));
  const F = new Map(first.rows.map((r) => [String(r.anonymous_id), r]));
  return agg.rows.map((a) => {
    const id = String(a.anonymous_id);
    const l = L.get(id) ?? {};
    const fr = F.get(id) ?? {};
    return {
      anonymous_id: id,
      first_seen: String(a.first_seen ?? ''),
      last_seen: String(a.last_seen ?? ''),
      events: Number(a.events ?? 0),
      sessions: Number(a.sessions ?? 0),
      pageviews: Number(a.pageviews ?? 0),
      pages: Number(a.pages ?? 0),
      is_bot: Number(a.any_bot ?? 0) > 0,
      bot_name: asStr(l.bot_name),
      bot_category: asStr(l.bot_category),
      bot_verified: asStr(l.bot_verified),
      ip: asStr(l.ip),
      ip_truncated: asBool(l.ip_truncated),
      country: asStr(l.country),
      country_name: asStr(l.country_name),
      region: asStr(l.region),
      city: asStr(l.city),
      browser: asStr(l.browser),
      browser_version: asStr(l.browser_version),
      os: asStr(l.os),
      device_type: asStr(l.device_type),
      site: asStr(l.site) ?? asStr(fr.site),
      landing_path: asStr(fr.page_path),
      source: visitorSource(fr),
    };
  });
}

export async function visitorEvents(tenantId: string, anonymousId: string, limit = 2000): Promise<Row[]> {
  await ensureEventsTable();
  const lim = Math.max(1, Math.min(5000, Math.floor(limit)));
  const res = await db().sql<Row>(
    `SELECT * FROM pm_events WHERE tenant_id = $1 AND anonymous_id = $2 ORDER BY occurred_at ASC LIMIT ${lim}`,
    [tenantId, anonymousId],
  );
  return res.rows;
}

export async function filterOptions(tenantId: string): Promise<{ sites: string[]; countries: Array<{ code: string; name: string }> }> {
  await ensureEventsTable();
  const sites = await db().sql<Row>(
    `SELECT site, COUNT(*) AS n FROM pm_events WHERE tenant_id = $1 AND site IS NOT NULL GROUP BY site ORDER BY n DESC LIMIT 50`,
    [tenantId],
  );
  const countries = await db().sql<Row>(
    `SELECT country, country_name, COUNT(*) AS n FROM pm_events WHERE tenant_id = $1 AND country IS NOT NULL
      GROUP BY country, country_name ORDER BY n DESC LIMIT 100`,
    [tenantId],
  );
  return {
    sites: sites.rows.map((r) => String(r.site)),
    countries: countries.rows.map((r) => ({ code: String(r.country), name: String(r.country_name ?? r.country) })),
  };
}

export interface VisitorBreakdown {
  since: string;
  humans: { visitors: number; events: number };
  bots: { visitors: number; events: number };
  countries: Array<{ country: string; country_name: string; visitors: number }>;
  bots_by_name: Array<{ bot_name: string; bot_category: string; bot_verified: string | null; events: number }>;
}

export async function visitorBreakdown(tenantId: string, days = 30): Promise<VisitorBreakdown> {
  await ensureEventsTable();
  const since = sqlTs(new Date(Date.now() - days * 86400_000));
  const split = await db().sql<Row>(
    `SELECT is_bot, COUNT(DISTINCT anonymous_id) AS visitors, COUNT(*) AS events
       FROM pm_events WHERE tenant_id = $1 AND occurred_at >= $2 GROUP BY is_bot`,
    [tenantId, since],
  );
  const countries = await db().sql<Row>(
    `SELECT country, country_name, COUNT(DISTINCT anonymous_id) AS visitors
       FROM pm_events WHERE tenant_id = $1 AND occurred_at >= $2 AND is_bot = FALSE AND country IS NOT NULL
      GROUP BY country, country_name ORDER BY visitors DESC LIMIT 10`,
    [tenantId, since],
  );
  const bots = await db().sql<Row>(
    `SELECT bot_name, bot_category, bot_verified, COUNT(*) AS events
       FROM pm_events WHERE tenant_id = $1 AND occurred_at >= $2 AND is_bot = TRUE
      GROUP BY bot_name, bot_category, bot_verified ORDER BY events DESC LIMIT 10`,
    [tenantId, since],
  );
  // A visitor with any bot event is a bot; humans = everyone else (no double count).
  const totals = await db().sql<Row>(
    `SELECT COUNT(DISTINCT anonymous_id) AS visitors FROM pm_events WHERE tenant_id = $1 AND occurred_at >= $2`,
    [tenantId, since],
  );
  const events = (bot: boolean) => Number(split.rows.find((x) => asBool(x.is_bot) === bot)?.events ?? 0);
  const botVisitors = Number(split.rows.find((x) => asBool(x.is_bot))?.visitors ?? 0);
  const allVisitors = Number(totals.rows[0]?.visitors ?? 0);
  return {
    since,
    humans: { visitors: Math.max(0, allVisitors - botVisitors), events: events(false) },
    bots: { visitors: botVisitors, events: events(true) },
    countries: countries.rows.map((r) => ({ country: String(r.country), country_name: String(r.country_name ?? r.country), visitors: Number(r.visitors ?? 0) })),
    bots_by_name: bots.rows.map((r) => ({ bot_name: String(r.bot_name ?? 'Unknown'), bot_category: String(r.bot_category ?? 'other'), bot_verified: asStr(r.bot_verified), events: Number(r.events ?? 0) })),
  };
}

/**
 * Conversion funnel (visit → pricing → lead → sign-up → checkout → purchase)
 * for human visitors in the last `days` days. Reads distinct (site, event,
 * visitor) triples — bounded by the LIMIT — and counts per step in JS so a
 * visitor is counted once per step even when a step has several event names.
 */
export async function conversionFunnel(tenantId: string, days = 30): Promise<FunnelReport & { since: string; truncated: boolean }> {
  await ensureEventsTable();
  const since = sqlTs(new Date(Date.now() - days * 86400_000));
  const cap = 50_000;
  const r = await db().sql<Row>(
    `SELECT site, event_type, anonymous_id, COUNT(*) AS events
       FROM pm_events
      WHERE tenant_id = $1 AND occurred_at >= $2 AND is_bot = FALSE
        AND event_type IN (${FUNNEL_EVENT_TYPES.map(lit).join(',')})
      GROUP BY site, event_type, anonymous_id
      LIMIT ${cap}`,
    [tenantId, since],
  );
  const report = buildFunnel(r.rows.map((x) => ({
    site: asStr(x.site),
    event_type: asStr(x.event_type),
    anonymous_id: asStr(x.anonymous_id),
    events: Number(x.events ?? 1),
  })));
  return { ...report, since, truncated: r.rows.length >= cap };
}

// ── reclassification (backfill) ──────────────────────────────────────────────
export interface ReclassifyResult {
  scanned: number;
  changed: number;
  before: { human: number; bot: number };
  after: { human: number; bot: number };
}

async function botSplit(): Promise<{ human: number; bot: number }> {
  const r = await db().sql<Row>(`SELECT is_bot, COUNT(*) AS n FROM pm_events GROUP BY is_bot`);
  const n = (b: boolean) => Number(r.rows.find((x) => asBool(x.is_bot) === b)?.n ?? 0);
  return { human: n(false), bot: n(true) };
}

const sameVerdict = (r: Row, c: Classification) =>
  asBool(r.is_bot) === c.isBot && asStr(r.bot_name) === c.botName && asStr(r.bot_category) === c.botCategory &&
  asStr(r.bot_verified) === c.botVerified && asStr(r.device_type) === c.deviceType;

/**
 * Re-run the classifier (UA + crawler IP ranges) over stored events whose
 * `bot_rules_version` is older than CLASSIFIER_VERSION (or missing). Rows are
 * grouped by verdict and updated with one statement per verdict per batch.
 * Idempotent: every scanned row is stamped with the current version.
 */
export async function reclassifyEvents(matcher: CrawlerMatcher, batchSize = 500): Promise<ReclassifyResult> {
  await ensureEventsTable();
  const before = await botSplit();
  let scanned = 0;
  let changed = 0;
  const seen = new Set<string>();
  for (let guard = 0; guard < 10_000; guard++) {
    const res = await db().sql<Row>(
      `SELECT event_id, user_agent, ip, is_bot, bot_name, bot_category, bot_verified, device_type
         FROM pm_events WHERE bot_rules_version IS NULL OR bot_rules_version < ${CLASSIFIER_VERSION} LIMIT ${batchSize}`,
    );
    if (!res.rows.length) break;
    if (res.rows.some((r) => seen.has(String(r.event_id)))) throw new Error('reclassify: UPDATE did not persist; stopping');
    for (const r of res.rows) seen.add(String(r.event_id));
    const groups = new Map<string, { c: Classification; ids: string[] }>();
    const stampOnly: string[] = [];
    for (const r of res.rows) {
      const c = classifyVisitor(asStr(r.user_agent), asStr(r.ip), matcher);
      if (sameVerdict(r, c)) {
        stampOnly.push(String(r.event_id));
        continue;
      }
      const k = JSON.stringify([c.isBot, c.botName, c.botCategory, c.botVerified, c.deviceType]);
      const g = groups.get(k) ?? { c, ids: [] };
      g.ids.push(String(r.event_id));
      groups.set(k, g);
    }
    for (const { c, ids } of groups.values()) {
      await db().sql(
        `UPDATE pm_events SET is_bot = ${lit(c.isBot)}, bot_name = ${lit(c.botName)}, bot_category = ${lit(c.botCategory)},
                bot_verified = ${lit(c.botVerified)}, device_type = ${lit(c.deviceType)}, bot_rules_version = ${CLASSIFIER_VERSION}
          WHERE event_id IN (${ids.map(lit).join(',')})`,
      );
      changed += ids.length;
    }
    if (stampOnly.length) {
      await db().sql(`UPDATE pm_events SET bot_rules_version = ${CLASSIFIER_VERSION} WHERE event_id IN (${stampOnly.map(lit).join(',')})`);
    }
    scanned += res.rows.length;
  }
  return { scanned, changed, before, after: await botSplit() };
}
