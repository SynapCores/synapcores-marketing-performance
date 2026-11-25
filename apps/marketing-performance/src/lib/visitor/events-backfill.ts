/**
 * The pm_events → pm_events_v2 copy (see events-v2.ts for the why and the
 * states). Engine access is injected, so the whole algorithm is unit tested
 * against an in-memory engine with a crash or an ambiguous failure injected at
 * every statement (tests/events-backfill.test.ts). lib/events-migration.ts
 * wires it to the real engine.
 *
 * Correctness rests on three facts:
 *  - pm_events is frozen while this runs: every write already goes to v2;
 *  - a window copies only the ids v2 doesn't have yet, then checks each id is
 *    in v2 exactly once, so redoing a window never duplicates;
 *  - the watermark (with the verified-row count) is saved only after a window
 *    is verified, so a restart redoes at most that window, and the final
 *    COUNT(pm_events) = verified check catches anything outside the windows.
 */
import { failedWithoutWriting } from '../collect-outcome';
import { PM_EVENTS_TABLE } from './events';
import {
  BACKFILL,
  PM_EVENTS_V2_TABLE,
  boundsSql,
  chunk,
  classifyFailure,
  countSql,
  dupCheckSql,
  formatSqlTs,
  idsInSql,
  insertGroups,
  insertRowsSql,
  nextSpanMs,
  nullPageSql,
  parseSqlTs,
  progressPct,
  retryDelayMs,
  rowsToCopy,
  shrinkSpanMs,
  windowBounds,
  windowSelectSql,
  windowVerdict,
  type BackfillOptions,
  type StoreMeta,
} from './events-v2';

type Row = Record<string, unknown>;

export interface BackfillDeps {
  /** Run one statement (no bound parameters). `truncated`: the engine cut the result short. */
  sql: (statement: string) => Promise<{ rows: Row[]; truncated?: boolean }>;
  /** Persist the state; returns what was saved. */
  saveMeta: (m: StoreMeta) => Promise<StoreMeta>;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  opts?: BackfillOptions;
  /** Retries for one statement on transient failures before giving up (default 30, ~27 min). */
  maxAttempts?: number;
}

const TAG = '[pm-events-v2]';

export class PmEventsIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PmEventsIntegrityError';
  }
}

const short = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 180);

interface Bounds {
  lo: string | null;
  hi: string | null;
  n: number;
}

class Copier {
  private readonly o: BackfillOptions;
  private readonly max: number;
  private readonly now: () => number;
  /** INSERT size limits, halved for the rest of the run when the engine refuses a statement as too big. */
  private insertRows: number;
  private insertBytes: number;

  constructor(private readonly d: BackfillDeps) {
    this.o = d.opts ?? BACKFILL;
    this.max = d.maxAttempts ?? 30;
    this.now = d.now ?? Date.now;
    this.insertRows = this.o.insertChunk;
    this.insertBytes = this.o.insertBytes;
  }

  /** Retry fn on transient failures (reads and meta saves only: safe to repeat). */
  async retrying<T>(what: string, fn: () => Promise<T>, rethrowTooBig = false): Promise<T> {
    for (let n = 1; ; n++) {
      try {
        return await fn();
      } catch (e) {
        const kind = classifyFailure(e);
        if (kind === 'fatal' || (rethrowTooBig && kind === 'too_big') || n >= this.max) throw e;
        const ms = retryDelayMs(n);
        this.d.warn(`${TAG} ${what} failed (${kind}: ${short(e)}); retrying in ${ms / 1000}s`);
        await this.d.sleep(ms);
      }
    }
  }

  sqlOnce(statement: string): Promise<{ rows: Row[]; truncated?: boolean }> {
    return this.d.sql(statement);
  }

  save(m: StoreMeta): Promise<StoreMeta> {
    return this.retrying('save state', () => this.d.saveMeta(m));
  }

  async scalar(statement: string): Promise<number> {
    const r = await this.retrying('count', () => this.d.sql(statement));
    const v = Number(r.rows[0]?.n ?? NaN);
    if (!Number.isFinite(v)) throw new Error(`no count from: ${statement.slice(0, 80)}`);
    return v;
  }

  async bounds(): Promise<Bounds> {
    const r = await this.retrying('bounds', () => this.d.sql(boundsSql(PM_EVENTS_TABLE)));
    const x = r.rows[0] ?? {};
    const ts = (v: unknown) => {
      if (v == null) return null;
      const t = parseSqlTs(v);
      // A shape we can't window by would silently skip the copy: stop loudly instead.
      if (t == null) throw new Error(`unexpected received_at shape from the engine: ${JSON.stringify(String(v).slice(0, 40))}`);
      return formatSqlTs(t);
    };
    return { lo: ts(x.lo), hi: ts(x.hi), n: Number(x.n ?? 0) || 0 };
  }

  private async existingIds(ids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const part of chunk(ids, this.o.idChunk)) {
      const r = await this.d.sql(idsInSql(PM_EVENTS_V2_TABLE, part, 'ids'));
      for (const x of r.rows) found.add(String(x.event_id));
    }
    return found;
  }

  private async countIds(ids: string[]): Promise<number> {
    let n = 0;
    for (const part of chunk(ids, this.o.idChunk)) {
      const r = await this.d.sql(idsInSql(PM_EVENTS_V2_TABLE, part, 'count'));
      n += Number(r.rows[0]?.n ?? 0) || 0;
    }
    return n;
  }

  /**
   * Copy one window's rows into v2 and verify. Idempotent: only ids v2 lacks
   * are inserted, so a redo after a failed or ambiguous INSERT (or a restart)
   * never duplicates. Returns rows inserted.
   */
  async copyWindow(rows: Row[], label: string): Promise<number> {
    const ids = rows.map((r) => String(r.event_id));
    let inserted = 0;
    let failures = 0;
    let redos = 0;
    for (;;) {
      let inInsert = false;
      try {
        const todo = rowsToCopy(rows, await this.existingIds(ids));
        for (const part of insertGroups(PM_EVENTS_V2_TABLE, todo, this.insertRows, this.insertBytes)) {
          inInsert = true;
          await this.d.sql(insertRowsSql(PM_EVENTS_V2_TABLE, part));
          inInsert = false;
          inserted += part.length;
        }
        const found = await this.countIds(ids);
        const verdict = windowVerdict(ids.length, found);
        if (verdict === 'ok') return inserted;
        if (verdict === 'duplicate') {
          throw new PmEventsIntegrityError(`window ${label}: ${found} rows in ${PM_EVENTS_V2_TABLE} for ${ids.length} ids`);
        }
        if (++redos >= 3) {
          throw new PmEventsIntegrityError(`window ${label}: ${ids.length - found} of ${ids.length} rows still missing after ${redos} copies`);
        }
        this.d.warn(`${TAG} window ${label}: ${ids.length - found} row(s) missing after the copy; copying them again`);
      } catch (e) {
        if ((e as Error)?.name === 'PmEventsIntegrityError') throw e;
        const kind = classifyFailure(e);
        if (kind === 'too_big' && (this.insertRows > 1 || this.insertBytes > 4096)) {
          this.insertRows = Math.max(1, this.insertRows >> 1);
          this.insertBytes = Math.max(4096, this.insertBytes >> 1);
        } else if (kind === 'fatal' || ++failures >= this.max) {
          throw e;
        }
        // An INSERT that may still run in the engine (timeout, reset) must have finished or died before
        // the ids are read again, or the redo could insert its rows a second time.
        const unsure = inInsert && kind === 'transient' && !failedWithoutWriting(e);
        const ms = kind === 'too_big' ? 1_000 : unsure ? Math.max(this.o.ambiguousWaitMs, retryDelayMs(failures)) : retryDelayMs(failures);
        this.d.warn(`${TAG} window ${label} failed (${kind}${unsure ? ', INSERT outcome unknown' : ''}: ${short(e)}); redoing it in ${ms / 1000}s`);
        await this.d.sleep(ms);
      }
    }
  }

  /**
   * Copy pm_events rows with received_at in [from, end of table], window by
   * window, oldest first; onWindow runs after each verified window. Re-reads
   * the end when it gets there, in case rows were added meanwhile.
   */
  async copyRange(from: string, b0: Bounds, onWindow: (hi: string, rows: number, inserted: number) => Promise<void>): Promise<Bounds> {
    let b = b0;
    if (b.hi == null) return b;
    let end = parseSqlTs(b.hi)!;
    let lo = from;
    let span = this.o.initialSpanMs;
    while (parseSqlTs(lo)! <= end) {
      const w = windowBounds(lo, span);
      let rows: Row[];
      try {
        const limit = this.o.windowLimit;
        const res = await this.retrying(`window ${w.lo}`, () => this.d.sql(windowSelectSql(PM_EVENTS_TABLE, w.lo, w.hi, limit)), true);
        // A full (or truncated) window may hide rows past the limit: treat it like a size refusal and split it.
        if (res.truncated || res.rows.length >= limit) {
          throw Object.assign(new Error(`window result too large (${res.rows.length} rows, limit ${limit})`), { name: 'SynapCoresError', status: 413 });
        }
        rows = res.rows;
      } catch (e) {
        const smaller = classifyFailure(e) === 'too_big' ? shrinkSpanMs(span, this.o) : null;
        if (smaller == null) throw e;
        this.d.warn(`${TAG} window ${w.lo} refused as too big (${short(e)}); trying ${smaller / 1000}s windows`);
        span = smaller;
        continue;
      }
      const inserted = rows.length ? await this.copyWindow(rows, `${w.lo}..${w.hi}`) : 0;
      await onWindow(w.hi, rows.length, inserted);
      if (rows.length && this.o.pauseMs > 0) await this.d.sleep(this.o.pauseMs);
      lo = w.hi;
      span = nextSpanMs(span, rows.length, this.o);
      if (parseSqlTs(lo)! > end) {
        const again = await this.bounds();
        if (again.hi != null && parseSqlTs(again.hi)! > end) {
          this.d.warn(`${TAG} ${PM_EVENTS_TABLE} gained rows up to ${again.hi} during the copy; copying those too`);
          b = again;
          end = parseSqlTs(again.hi)!;
        }
      }
    }
    return b;
  }
}

/** Copy the rows without received_at, page by page (by event_id); returns [rows, inserted]. */
async function copyNullRows(c: Copier, deps: BackfillDeps): Promise<[number, number]> {
  const limit = (deps.opts ?? BACKFILL).windowLimit;
  let after: string | null = null;
  let rows = 0;
  let inserted = 0;
  for (;;) {
    const page = (await c.retrying('null rows', () => deps.sql(nullPageSql(PM_EVENTS_TABLE, after, limit)))).rows;
    if (!page.length) return [rows, inserted];
    inserted += await c.copyWindow(page, 'received_at IS NULL');
    rows += page.length;
    if (page.length < limit) return [rows, inserted];
    after = String(page[page.length - 1]!.event_id);
  }
}

/**
 * Backfill from the saved state (fresh or resumed) until every pm_events row is
 * verified in v2. Returns the final state, still `backfill` (the caller flips
 * to v2). Throws PmEventsIntegrityError when the copy can't be verified, or the
 * engine error that made it give up; the saved watermark lets it resume later.
 */
export async function runBackfill(start: StoreMeta, deps: BackfillDeps): Promise<StoreMeta> {
  const c = new Copier(deps);
  let meta = start;
  for (;;) {
    if (!meta.nullsDone) {
      const [rows, inserted] = await copyNullRows(c, deps);
      meta = await c.save({ ...meta, nullsDone: true, checked: meta.checked + rows, copied: meta.copied + inserted });
    }
    const b = await c.bounds();
    let total = b.n;
    let lastLog = (deps.now ?? Date.now)();
    const from = meta.watermark ?? b.lo;
    const end = from == null ? b : await c.copyRange(from, b, async (hi, rows, inserted) => {
      meta = await c.save({ ...meta, watermark: hi, checked: meta.checked + rows, copied: meta.copied + inserted });
      const t = (deps.now ?? Date.now)();
      if (t - lastLog >= 30_000) {
        lastLog = t;
        total = Math.max(total, meta.checked);
        deps.info(`${TAG} backfill ${progressPct(meta.checked, total)}%: ${meta.checked}/${total} rows verified (watermark ${hi})`);
      }
    });
    // A beacon INSERT the old process had in flight lands within seconds of its exit: count only once
    // the cutover is settleMs old (the copy itself takes minutes at prod size, so this rarely waits).
    const cut = meta.cutoverAt ? Date.parse(meta.cutoverAt) : NaN;
    const wait = Number.isFinite(cut) ? cut + (deps.opts ?? BACKFILL).settleMs - (deps.now ?? Date.now)() : 0;
    if (wait > 0) await deps.sleep(wait);
    const n = await c.scalar(countSql(PM_EVENTS_TABLE));
    if (n === meta.checked) {
      await assertNoDuplicates(c);
      return { ...meta, oldSyncedTo: end.hi ?? meta.oldSyncedTo, oldCount: n };
    }
    if (meta.passes >= 2) {
      throw new PmEventsIntegrityError(`${PM_EVENTS_TABLE} has ${n} rows but ${meta.checked} were verified in ${PM_EVENTS_V2_TABLE} after ${meta.passes} passes`);
    }
    deps.warn(`${TAG} ${PM_EVENTS_TABLE} has ${n} rows but ${meta.checked} were verified; running one more full pass (it copies only what is missing)`);
    meta = await c.save({ ...meta, watermark: null, nullsDone: false, checked: 0, passes: meta.passes + 1 });
  }
}

/** Refuse to flip (or to call a catch-up done) while v2 holds an event id twice. */
async function assertNoDuplicates(c: Copier): Promise<void> {
  const r = await c.retrying('duplicate check', () => c.sqlOnce(dupCheckSql(PM_EVENTS_V2_TABLE)));
  const x = r.rows[0] ?? {};
  const n = Number(x.n ?? NaN);
  const d = Number(x.d ?? NaN);
  if (!Number.isFinite(n) || !Number.isFinite(d)) throw new Error('duplicate check: no answer');
  if (n !== d) throw new PmEventsIntegrityError(`${PM_EVENTS_V2_TABLE} holds ${n} rows but ${d} distinct event ids`);
}

/**
 * State v2 at start: if pm_events changed since the last verified copy (the
 * app ran with the flag off after the cutover, a rollback without the reverse
 * copy, or a write that landed after the flip), copy what v2 lacks: one
 * id-checked pass over pm_events. Normally a single COUNT(*). Returns the new
 * state, or null when there was nothing to do.
 */
export async function runCatchUp(meta: StoreMeta, deps: BackfillDeps): Promise<StoreMeta | null> {
  const c = new Copier(deps);
  const known = meta.oldCount ?? meta.checked;
  const n0 = await c.scalar(countSql(PM_EVENTS_TABLE));
  if (n0 === known) return null;
  deps.warn(
    `${TAG} ${PM_EVENTS_TABLE} has ${n0} rows, ${known} at the last verified copy (the app ran with PM_EVENTS_V2 off after the cutover?); copying what ${PM_EVENTS_V2_TABLE} lacks`,
  );
  const [nullRows, nullCopied] = await copyNullRows(c, deps);
  let checked = nullRows;
  let copied = nullCopied;
  const b = await c.bounds();
  const end = b.lo == null ? b : await c.copyRange(b.lo, b, async (_hi, rows, inserted) => {
    checked += rows;
    copied += inserted;
  });
  const n = await c.scalar(countSql(PM_EVENTS_TABLE));
  if (n !== checked) throw new PmEventsIntegrityError(`catch-up: ${PM_EVENTS_TABLE} has ${n} rows but ${checked} were verified`);
  await assertNoDuplicates(c);
  const next = await c.save({ ...meta, oldSyncedTo: end.hi ?? meta.oldSyncedTo, oldCount: n, copied: meta.copied + copied });
  deps.info(`${TAG} catch-up done: all ${n} ${PM_EVENTS_TABLE} rows verified in ${PM_EVENTS_V2_TABLE}, ${copied} copied`);
  return next;
}
