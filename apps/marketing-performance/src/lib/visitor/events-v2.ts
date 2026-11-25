/**
 * pm_events_v2: the visitor-event table without a primary key or any index.
 *
 * Why: on SynapCores 2.5.1 every INSERT or UPDATE statement on a wide table
 * that has any index (primary key included) costs O(rows) in time and in
 * transient engine memory: ~465 ms and ~190 MiB per beacon at 35.7k rows. The
 * same 51 columns without any index insert in 2-9 ms. Event ids stay
 * server-minted UUIDs; nothing relies on the engine enforcing uniqueness.
 *
 * Switch: PM_EVENTS_V2=1 (systemd drop-in). Unset = release F behaviour,
 * byte for byte: pm_events only, no new tables, no meta reads.
 *
 * Migration (flag on), persisted as one JSON row in pm_events_meta:
 *  - v1 → backfill, at the first use in a process: from then on every write
 *    goes to pm_events_v2, so pm_events is frozen (all writers live in the one
 *    app process), while reads stay on pm_events, which still holds the whole
 *    history up to the cutover;
 *  - backfill: pm_events is copied into pm_events_v2 in received_at windows.
 *    Per window: copy only the ids not yet in v2, then check that every id is
 *    there exactly once; save the watermark after each window, so a restart
 *    of the app or the engine resumes where it stopped;
 *  - backfill → v2 when COUNT(pm_events) equals the verified ids. Reads switch.
 * pm_events stays as the rollback source; nothing is dropped in this release.
 *
 * Pure: state and window decisions plus SQL text, unit tested
 * (tests/events-v2.test.ts). The runner is lib/events-migration.ts.
 */
import { PM_EVENTS_DDL, PM_EVENTS_TABLE, PM_EVENT_COLUMNS } from './events';
import { lit } from './sql-lit';

export const PM_EVENTS_V2_TABLE = 'pm_events_v2';
export const PM_EVENTS_META_TABLE = 'pm_events_meta';
export const STORE_META_KEY = 'pm_events_store';

type Env = Record<string, string | undefined>;

/** PM_EVENTS_V2=1 / true / on / yes turns the new table on. */
export function pmEventsV2Enabled(env: Env = process.env): boolean {
  const v = (env.PM_EVENTS_V2 ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * The v2 DDL: PM_EVENTS_DDL's table with the same columns and types, without
 * the PRIMARY KEY and without the two indexes. Throws if the base DDL changed
 * shape (called only when the flag is on).
 */
export function pmEventsV2Ddl(): string {
  const base = PM_EVENTS_DDL[0] ?? '';
  const head = `CREATE TABLE IF NOT EXISTS ${PM_EVENTS_TABLE} (`;
  if (!base.startsWith(head) || !base.includes('event_id TEXT PRIMARY KEY,')) {
    throw new Error('pm_events_v2: PM_EVENTS_DDL changed shape; update pmEventsV2Ddl');
  }
  const ddl = `CREATE TABLE IF NOT EXISTS ${PM_EVENTS_V2_TABLE} (` +
    base.slice(head.length).replace('event_id TEXT PRIMARY KEY,', 'event_id TEXT,');
  if (/PRIMARY KEY|UNIQUE|INDEX/i.test(ddl)) throw new Error('pm_events_v2: DDL still declares a key');
  return ddl;
}

/** Tiny key/value table, no key or index either (a handful of rows at most). */
export const PM_EVENTS_META_DDL = `CREATE TABLE IF NOT EXISTS ${PM_EVENTS_META_TABLE} (k TEXT, v TEXT)`;

// ── migration state ──────────────────────────────────────────────────────────

export type StoreState = 'v1' | 'backfill' | 'v2';

export interface StoreMeta {
  state: StoreState;
  /** ISO time writes moved to pm_events_v2. */
  cutoverAt: string | null;
  /** Every pm_events row with received_at < watermark is verified in v2 ('YYYY-MM-DD HH:MM:SS'). */
  watermark: string | null;
  /** Rows with received_at IS NULL copied and verified. */
  nullsDone: boolean;
  /** pm_events rows verified present in v2 exactly once (this pass). */
  checked: number;
  /** Rows the backfill inserted into v2 (all passes). */
  copied: number;
  /** Backfill passes started; a final count mismatch starts one more. */
  passes: number;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
  /** Newest pm_events received_at at the last verified copy (informational). */
  oldSyncedTo: string | null;
  /** COUNT(pm_events) at the last verified copy: a different count at a later start means rows to catch up. */
  oldCount: number | null;
  /** Set by bin/pm-events-v2.mjs reverse-copy when it rolls the data back. */
  rolledBackAt: string | null;
}

export const INITIAL_META: StoreMeta = {
  state: 'v1', cutoverAt: null, watermark: null, nullsDone: false, checked: 0, copied: 0, passes: 0,
  startedAt: null, finishedAt: null, updatedAt: null, oldSyncedTo: null, oldCount: null, rolledBackAt: null,
};

const STATES: StoreState[] = ['v1', 'backfill', 'v2'];
const TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null);
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** Parse the stored JSON; anything unreadable is the untouched state (v1). */
export function parseStoreMeta(raw: unknown): StoreMeta {
  let o: Record<string, unknown> | null = null;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    o = null;
  }
  if (!o || !STATES.includes(o.state as StoreState)) return { ...INITIAL_META };
  const wm = strOrNull(o.watermark);
  const synced = strOrNull(o.oldSyncedTo);
  return {
    state: o.state as StoreState,
    cutoverAt: strOrNull(o.cutoverAt),
    watermark: wm && TS.test(wm) ? wm : null,
    nullsDone: o.nullsDone === true,
    checked: count(o.checked),
    copied: count(o.copied),
    passes: count(o.passes),
    startedAt: strOrNull(o.startedAt),
    finishedAt: strOrNull(o.finishedAt),
    updatedAt: strOrNull(o.updatedAt),
    oldSyncedTo: synced && TS.test(synced) ? synced : null,
    oldCount: typeof o.oldCount === 'number' && Number.isFinite(o.oldCount) && o.oldCount >= 0 ? Math.floor(o.oldCount) : null,
    rolledBackAt: strOrNull(o.rolledBackAt),
  };
}

/**
 * The meta row(s) for STORE_META_KEY. There is exactly one in practice; if a
 * race ever wrote two, the most advanced state wins (then the latest update),
 * and the next save (an UPDATE by key) rewrites both.
 */
export function pickStoreMeta(values: unknown[]): { meta: StoreMeta; exists: boolean } {
  if (!values.length) return { meta: { ...INITIAL_META }, exists: false };
  const metas = values.map(parseStoreMeta);
  metas.sort((a, b) => STATES.indexOf(b.state) - STATES.indexOf(a.state) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return { meta: metas[0] ?? { ...INITIAL_META }, exists: true };
}

/** v1 → backfill: the cutover. Other states are returned unchanged. */
export function beginBackfill(m: StoreMeta, now: Date): StoreMeta {
  if (m.state !== 'v1') return m;
  const iso = now.toISOString();
  return { ...INITIAL_META, copied: m.copied, state: 'backfill', cutoverAt: iso, startedAt: iso, updatedAt: iso, passes: 1 };
}

/**
 * Which table each side uses. Flag off: pm_events for both (release F).
 * Flag on: writes go to v2 as soon as the state is known (backfill or v2);
 * reads move only once the backfill is verified. While the state is not known
 * yet (or still v1) there is no write table: the caller must not write.
 */
export function tablesFor(enabled: boolean, state: StoreState | null): { read: string; write: string | null } {
  if (!enabled) return { read: PM_EVENTS_TABLE, write: PM_EVENTS_TABLE };
  if (state === 'v2') return { read: PM_EVENTS_V2_TABLE, write: PM_EVENTS_V2_TABLE };
  if (state === 'backfill') return { read: PM_EVENTS_TABLE, write: PM_EVENTS_V2_TABLE };
  return { read: PM_EVENTS_TABLE, write: null };
}

export function metaSelectSql(): string {
  return `SELECT v FROM ${PM_EVENTS_META_TABLE} WHERE k = ${lit(STORE_META_KEY)}`;
}

export function metaSaveSql(m: StoreMeta, exists: boolean): string {
  const v = lit(JSON.stringify(m));
  return exists
    ? `UPDATE ${PM_EVENTS_META_TABLE} SET v = ${v} WHERE k = ${lit(STORE_META_KEY)}`
    : `INSERT INTO ${PM_EVENTS_META_TABLE} (k, v) VALUES (${lit(STORE_META_KEY)}, ${v})`;
}

// ── backfill windows ─────────────────────────────────────────────────────────

export const BACKFILL = {
  /** First window; then adapted to the rows each window returned. */
  initialSpanMs: 3_600_000,
  minSpanMs: 1_000,
  maxSpanMs: 7 * 86_400_000,
  /** Rows per window to aim for: one window's SELECT stays far below the engine's per-query memory budget. */
  targetRows: 500,
  /**
   * Explicit LIMIT on a window SELECT. The engine cuts a SELECT without LIMIT at
   * 1000 rows (truncated: true); with a LIMIT it returns up to the LIMIT and no
   * flag, so a window that fills its LIMIT is treated as too big and split.
   */
  windowLimit: 2_000,
  /** Rows per INSERT statement into v2 (at most; see insertBytes). */
  insertChunk: 200,
  /**
   * SQL bytes per INSERT statement. The engine refuses longer statements
   * ("SQL query exceeds maximum length"); rows are packed up to this size.
   */
  insertBytes: 64 * 1024,
  /** Ids per `event_id IN (…)` lookup. */
  idChunk: 400,
  /** Pause between windows, so the copy leaves the engine room for beacons and pages. */
  pauseMs: 250,
  /**
   * Wait after an INSERT whose outcome is unknown (timeout / reset) before
   * re-reading the window's ids: longer than the engine's 60 s statement
   * timeout, so a statement still queued in the engine has finished or died.
   */
  ambiguousWaitMs: 75_000,
  /** The final count waits until the cutover is this old (an INSERT in flight in the old process has landed). */
  settleMs: 120_000,
};
export type BackfillOptions = typeof BACKFILL;

/** 'YYYY-MM-DD HH:MM:SS' (UTC, as stored by sqlTs) → epoch ms; null when not that shape. */
export function parseSqlTs(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]00:?00)?$/.exec(s.trim());
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}Z`);
  return Number.isFinite(t) ? t : null;
}

/** epoch ms → 'YYYY-MM-DD HH:MM:SS' (UTC, whole seconds, same as events.ts sqlTs). */
export function formatSqlTs(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/** Next window span: halve after a big window, double after a small one; whole seconds, clamped. */
export function nextSpanMs(spanMs: number, rows: number, o: BackfillOptions = BACKFILL): number {
  let s = spanMs;
  if (rows > 2 * o.targetRows) s = spanMs / 2;
  else if (rows < o.targetRows / 4) s = spanMs * 2;
  s = Math.floor(s / 1000) * 1000;
  return Math.min(o.maxSpanMs, Math.max(o.minSpanMs, s));
}

/** Half the span for a retry after the engine refused a window as too big; null at the minimum. */
export function shrinkSpanMs(spanMs: number, o: BackfillOptions = BACKFILL): number | null {
  if (spanMs <= o.minSpanMs) return null;
  return Math.max(o.minSpanMs, Math.floor(spanMs / 2 / 1000) * 1000);
}

/** [lo, lo + span) as SQL timestamps. */
export function windowBounds(lo: string, spanMs: number): { lo: string; hi: string } {
  const t = parseSqlTs(lo);
  if (t == null) throw new Error(`bad window start ${JSON.stringify(lo)}`);
  return { lo: formatSqlTs(t), hi: formatSqlTs(t + Math.max(1_000, spanMs)) };
}

const COLS = PM_EVENT_COLUMNS.join(', ');
const assertTs = (s: string) => {
  if (!TS.test(s)) throw new Error(`bad timestamp ${JSON.stringify(s)}`);
  return s;
};
const assertTable = (t: string) => {
  if (t !== PM_EVENTS_TABLE && t !== PM_EVENTS_V2_TABLE) throw new Error(`unexpected table ${t}`);
  return t;
};

const assertLimit = (n: number) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`bad limit ${n}`);
  return n;
};

/** All columns, in insert order, of the rows received in [lo, hi); at most `limit` rows. */
export function windowSelectSql(table: string, lo: string, hi: string, limit: number): string {
  return `SELECT ${COLS} FROM ${assertTable(table)} WHERE received_at >= '${assertTs(lo)}' AND received_at < '${assertTs(hi)}' LIMIT ${assertLimit(limit)}`;
}

/** One page of the rows without received_at (they can't be windowed by time): by event_id, after `afterId`. */
export function nullPageSql(table: string, afterId: string | null, limit: number): string {
  const after = afterId == null ? '' : ` AND event_id > ${lit(afterId)}`;
  return `SELECT ${COLS} FROM ${assertTable(table)} WHERE received_at IS NULL${after} ORDER BY event_id LIMIT ${assertLimit(limit)}`;
}

export function boundsSql(table: string): string {
  return `SELECT MIN(received_at) AS lo, MAX(received_at) AS hi, COUNT(*) AS n FROM ${assertTable(table)}`;
}

export function countSql(table: string): string {
  return `SELECT COUNT(*) AS n FROM ${assertTable(table)}`;
}

export function countSinceSql(table: string, from: string): string {
  return `SELECT COUNT(*) AS n FROM ${assertTable(table)} WHERE received_at >= '${assertTs(from)}'`;
}

/** Rows vs distinct ids: a difference means duplicate event ids. */
export function dupCheckSql(table: string): string {
  return `SELECT COUNT(*) AS n, COUNT(DISTINCT event_id) AS d FROM ${assertTable(table)}`;
}

/**
 * `event_id IN (…)` lookup: the ids found ('ids') or how many rows carry them
 * ('count'). The ids form carries a LIMIT above any possible answer (the
 * engine would cut an unlimited one at 1000 rows); duplicates show up in 'count'.
 */
export function idsInSql(table: string, ids: readonly string[], what: 'ids' | 'count'): string {
  if (!ids.length) throw new Error('idsInSql: no ids');
  const list = ids.map(lit).join(',');
  return what === 'ids'
    ? `SELECT event_id FROM ${assertTable(table)} WHERE event_id IN (${list}) LIMIT ${ids.length * 4}`
    : `SELECT COUNT(*) AS n FROM ${assertTable(table)} WHERE event_id IN (${list})`;
}

type Row = Record<string, unknown>;

const tuple = (r: Row) => '(' + PM_EVENT_COLUMNS.map((c) => lit(r[c])).join(',') + ')';

/** One multi-row INSERT of full rows (all 51 columns, values as the engine returned them). */
export function insertRowsSql(table: string, rows: readonly Row[]): string {
  if (!rows.length) throw new Error('insertRowsSql: no rows');
  return `INSERT INTO ${assertTable(table)} (${PM_EVENT_COLUMNS.join(',')}) VALUES ${rows.map(tuple).join(',')}`;
}

/**
 * Rows packed into INSERT batches of at most maxRows rows and maxBytes of SQL
 * (UTF-8) each; a single row larger than maxBytes still gets its own batch.
 * Returns the row groups (the caller builds each statement with insertRowsSql).
 */
export function insertGroups(table: string, rows: readonly Row[], maxRows: number, maxBytes: number): Row[][] {
  const head = Buffer.byteLength(`INSERT INTO ${assertTable(table)} (${PM_EVENT_COLUMNS.join(',')}) VALUES `, 'utf8');
  const out: Row[][] = [];
  let cur: Row[] = [];
  let size = head;
  for (const r of rows) {
    const n = Buffer.byteLength(tuple(r), 'utf8') + 1;
    if (cur.length && (cur.length >= maxRows || size + n > maxBytes)) {
      out.push(cur);
      cur = [];
      size = head;
    }
    cur.push(r);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function chunk<T>(a: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

/** Window rows not yet in v2 (by event_id). Rows without an id are refused. */
export function rowsToCopy(rows: readonly Row[], existing: ReadonlySet<string>): Row[] {
  return rows.filter((r) => {
    if (r.event_id == null || r.event_id === '') throw new Error('pm_events row without event_id');
    return !existing.has(String(r.event_id));
  });
}

/** After copying a window: each of its ids must be in v2 exactly once. */
export function windowVerdict(expected: number, found: number): 'ok' | 'missing' | 'duplicate' {
  if (found === expected) return 'ok';
  return found > expected ? 'duplicate' : 'missing';
}

/**
 * How a failed statement should be handled by the backfill:
 *  - transient: the engine is unreachable/restarting or answered 5xx/408/429 → wait, then redo the window;
 *  - too_big: the engine refused the statement for memory/budget/size → smaller window;
 *  - fatal: anything else (bad SQL, missing table) → stop; reads stay on pm_events.
 * Matched by name, not instanceof (separate module instances), like collect-outcome.ts.
 */
export function classifyFailure(err: unknown): 'transient' | 'too_big' | 'fatal' {
  const e = (err && typeof err === 'object' ? err : {}) as Record<string, unknown>;
  const name = String(e.name ?? '');
  const message = String(e.message ?? '');
  const status = typeof e.status === 'number' ? e.status : 0;
  if (name === 'SynapCoresUnavailableError') return 'transient';
  // The engine's own overload answers come first, whatever their message says.
  if (name === 'SynapCoresError' && (status >= 500 || status === 408 || status === 429)) return 'transient';
  if (/memory|budget|resource|too large|too long|payload|exceed/i.test(message)) return 'too_big';
  if (name === 'SynapCoresError') {
    if (/queue capacity is exhausted|timed? ?out|timeout/i.test(message)) return 'transient';
    return 'fatal';
  }
  // Socket-level errors from fetch (should be wrapped by the client, but be safe).
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed/i.test(message + String(e.code ?? ''))) return 'transient';
  return 'fatal';
}

/** Retry delay after the n-th consecutive transient failure (1-based): 5 s doubling to 60 s. */
export function retryDelayMs(n: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, Math.min(4, n - 1)));
}

/** Progress in whole percent (verified rows / rows at the start of the pass). */
export function progressPct(checked: number, total: number): number {
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.floor((checked / total) * 100)));
}
