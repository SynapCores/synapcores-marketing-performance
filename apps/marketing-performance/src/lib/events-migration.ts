import 'server-only';
import { getAdminClient } from '@synapcores/app-framework/db/server';
import { invalidateReports } from './report-db';
import { PM_EVENTS_ADDED_COLUMNS, PM_EVENTS_TABLE } from './visitor/events';
import {
  PM_EVENTS_META_DDL,
  PM_EVENTS_V2_TABLE,
  beginBackfill,
  classifyFailure,
  metaSaveSql,
  metaSelectSql,
  pickStoreMeta,
  pmEventsV2Ddl,
  pmEventsV2Enabled,
  retryDelayMs,
  tablesFor,
  type StoreMeta,
} from './visitor/events-v2';
import { runBackfill, runCatchUp, type BackfillDeps } from './visitor/events-backfill';

/**
 * pm_events → pm_events_v2 (no primary key, no index): process-wide state and
 * the background runner. visitor/events-v2.ts explains the why and the states;
 * visitor/events-backfill.ts is the copy itself. Everything here is a no-op
 * unless PM_EVENTS_V2 is on.
 *
 * The state lives on globalThis: route handlers, pages, server actions and the
 * instrumentation hook can be separate module instances, and all of them must
 * switch tables at the same moment.
 */

type Row = Record<string, unknown>;
const db = () => getAdminClient();
const TAG = '[pm-events-v2]';

interface Shared {
  meta: StoreMeta | null;
  metaExists: boolean;
  loading: Promise<StoreMeta> | null;
  runner: Promise<void> | null;
  /** Why the last run stopped (null after a clean end). */
  stopped: { name: string; message: string; at: string } | null;
}
const KEY = Symbol.for('mktperf.pm-events-store');
function shared(): Shared {
  const g = globalThis as unknown as Record<symbol, Shared | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { meta: null, metaExists: false, loading: null, runner: null, stopped: null };
    g[KEY] = s;
  }
  return s;
}

/** Tables for reads and writes right now (flag off: pm_events for both). */
export function eventsTables(): { read: string; write: string | null } {
  return tablesFor(pmEventsV2Enabled(), shared().meta?.state ?? null);
}

/** The migration state as last loaded or saved by this process (null = not loaded / flag off). */
export function pmEventsStoreMeta(): StoreMeta | null {
  return shared().meta;
}

/** 'running' | 'stopped' (with why) | 'idle' (not started, or ended cleanly). */
export function pmEventsMigrationStatus(): { status: 'running' | 'stopped' | 'idle'; error: string | null } {
  const s = shared();
  if (s.runner) return { status: 'running', error: null };
  if (s.stopped) return { status: 'stopped', error: `${s.stopped.name}: ${s.stopped.message} (${s.stopped.at})` };
  return { status: 'idle', error: null };
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
const short = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 180);

async function readMeta(): Promise<{ meta: StoreMeta; exists: boolean }> {
  const r = await db().sql<Row>(metaSelectSql());
  return pickStoreMeta(r.rows.map((x) => x.v));
}

async function saveMeta(m: StoreMeta): Promise<StoreMeta> {
  const s = shared();
  const next = { ...m, updatedAt: new Date().toISOString() };
  const res = await db().sql<Row>(metaSaveSql(next, s.metaExists));
  if (s.metaExists) {
    // The engine answers an UPDATE with a single [[count]] row; 0 = the row is gone: write it again.
    const first = res.rows[0] ? Object.values(res.rows[0])[0] : undefined;
    const updated = Number(typeof first === 'number' ? first : res.rowCount);
    if (updated === 0) await db().sql(metaSaveSql(next, false));
  }
  s.metaExists = true;
  s.meta = next;
  return next;
}

/**
 * Flag on: create pm_events_v2 + pm_events_meta if needed and load the state.
 * The first time (state v1) this is the cutover: the state becomes `backfill`
 * and from then on every write goes to pm_events_v2. ensureEventsTable() calls
 * it before any read or write, so no write in this process reaches pm_events
 * after the cutover. Flag off: returns at once, no SQL.
 */
export async function ensurePmEventsStore(): Promise<void> {
  if (!pmEventsV2Enabled()) return;
  const s = shared();
  if (s.meta && s.meta.state !== 'v1') return;
  if (!s.loading) {
    s.loading = (async () => {
      await db().sql(pmEventsV2Ddl());
      for (const [col, type] of PM_EVENTS_ADDED_COLUMNS) {
        try {
          await db().sql(`SELECT ${col} FROM ${PM_EVENTS_V2_TABLE} LIMIT 1`);
        } catch {
          await db().sql(`ALTER TABLE ${PM_EVENTS_V2_TABLE} ADD COLUMN ${col} ${type}`);
        }
      }
      await db().sql(PM_EVENTS_META_DDL);
      const { meta, exists } = await readMeta();
      s.metaExists = exists;
      if (meta.state !== 'v1') {
        s.meta = meta;
        return meta;
      }
      const next = await saveMeta(beginBackfill(meta, new Date()));
      console.log(`${TAG} cutover: new visitor events now go to ${PM_EVENTS_V2_TABLE}; pages keep reading ${PM_EVENTS_TABLE} until the copy is verified`);
      return next;
    })().finally(() => {
      s.loading = null;
    });
  }
  await s.loading;
}

/**
 * Called every 15 min by the instrumentation hook: restart a backfill that
 * stopped on an engine failure (not on an integrity error, which needs a look).
 */
export function retryStoppedPmEventsMigration(hooks: MigrationHooks = {}): void {
  const s = shared();
  if (!pmEventsV2Enabled() || s.runner || !s.stopped || s.stopped.name === 'PmEventsIntegrityError') return;
  if (s.meta?.state === 'v2') return;
  console.warn(`${TAG} retrying the stopped backfill (stopped: ${s.stopped.message})`);
  void startPmEventsMigration(hooks);
}

export interface MigrationHooks {
  /** Runs once pages read pm_events_v2 (the boot sweep and reclassify skipped during the backfill). */
  afterBackfill?: () => Promise<void>;
}

/**
 * Start (or resume) the backfill in the background; resolves when it ends.
 * One runner per process. Errors are logged, never thrown: the state stays
 * `backfill` (writes to v2, reads from pm_events) and the next app start resumes.
 */
export function startPmEventsMigration(hooks: MigrationHooks = {}): Promise<void> {
  if (!pmEventsV2Enabled()) return Promise.resolve();
  const s = shared();
  if (!s.runner) {
    s.stopped = null;
    s.runner = runMigration(hooks)
      .catch((e) => {
        const state = shared().meta?.state;
        s.stopped = { name: String((e as Error)?.name ?? 'Error'), message: short(e), at: new Date().toISOString() };
        console.error(
          `${TAG} migration stopped: ${short(e)}. ` +
            (state === 'v2'
              ? `Pages keep reading ${PM_EVENTS_V2_TABLE}.`
              : `New events keep going to ${PM_EVENTS_V2_TABLE}; pages keep reading ${PM_EVENTS_TABLE}. ` +
                ((e as Error)?.name === 'PmEventsIntegrityError'
                  ? 'It will not retry by itself: check the data (bin/pm-events-v2.mjs verify), then restart the app or roll back (runbook).'
                  : 'It retries every 15 min; a restart also resumes it.')),
        );
      })
      .finally(() => {
        s.runner = null;
      });
  }
  return s.runner;
}

const deps: BackfillDeps = {
  sql: (statement) => db().sql<Row>(statement),
  saveMeta,
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  sleep,
};

async function runMigration(hooks: MigrationHooks): Promise<void> {
  // Setup can meet a restarting engine at boot: retry transient failures (~40 min).
  for (let n = 1; ; n++) {
    try {
      await ensurePmEventsStore();
      break;
    } catch (e) {
      if (classifyFailure(e) === 'fatal' || n >= 40) throw e;
      await sleep(retryDelayMs(n));
    }
  }
  const start = shared().meta;
  if (!start) throw new Error('state not loaded');
  if (start.state === 'v2') {
    if (await runCatchUp(start, deps)) invalidateReports();
    return;
  }
  const t0 = Date.now();
  console.log(
    `${TAG} backfill ${start.watermark || start.nullsDone ? `resuming at ${start.watermark ?? 'start'} (${start.checked} rows verified so far)` : 'starting'}; cutover ${start.cutoverAt}`,
  );
  const done = await runBackfill(start, deps);
  // The flip: from here every module instance reads pm_events_v2.
  let final: StoreMeta | null = null;
  for (let n = 1; !final; n++) {
    try {
      final = await saveMeta({ ...done, state: 'v2', finishedAt: new Date().toISOString(), oldCount: done.oldCount ?? done.checked });
    } catch (e) {
      if (classifyFailure(e) === 'fatal' || n >= 30) throw e;
      await sleep(retryDelayMs(n));
    }
  }
  invalidateReports();
  console.log(
    `${TAG} backfill verified: all ${final.checked} ${PM_EVENTS_TABLE} rows are in ${PM_EVENTS_V2_TABLE} exactly once ` +
      `(${final.copied} copied, ${Math.round((Date.now() - t0) / 1000)}s); pages now read ${PM_EVENTS_V2_TABLE}. ${PM_EVENTS_TABLE} is kept unchanged as the rollback source.`,
  );
  if (hooks.afterBackfill) {
    try {
      await hooks.afterBackfill();
    } catch (e) {
      console.error(`${TAG} post-backfill jobs failed: ${short(e)}`);
    }
  }
}
