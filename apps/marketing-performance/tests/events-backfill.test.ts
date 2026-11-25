/**
 * The pm_events → pm_events_v2 backfill against an in-memory engine that
 * understands exactly the statements the backfill sends. Faults are injected
 * at every statement position:
 *  - crash: the process dies there (the run throws); a new run resumes from
 *    the saved state, like an app restart;
 *  - ambiguous: the statement runs but the reply is lost (connection reset);
 *  - transient: the engine refuses the statement (restarting).
 * After each scenario v2 must hold every pm_events row exactly once with
 * identical values, plus the live rows written meanwhile, and nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PM_EVENT_COLUMNS } from '../src/lib/visitor/events';
import { INITIAL_META, beginBackfill, parseStoreMeta, type BackfillOptions, type StoreMeta } from '../src/lib/visitor/events-v2';
import { runBackfill, runCatchUp, type BackfillDeps } from '../src/lib/visitor/events-backfill';

type Row = Record<string, unknown>;
type Fault = 'crash' | 'ambiguous' | 'transient' | null;

const OPTS: BackfillOptions = { initialSpanMs: 3_600_000, minSpanMs: 1_000, maxSpanMs: 7 * 86_400_000, targetRows: 5, windowLimit: 12, insertChunk: 3, insertBytes: 64 * 1024, idChunk: 4, pauseMs: 0, ambiguousWaitMs: 1, settleMs: 0 };

/** Parse `'a''b'`, NULL, TRUE/FALSE, numbers in a VALUES / IN list. */
function parseValues(s: string): unknown[][] {
  const tuples: unknown[][] = [];
  let i = 0;
  let cur: unknown[] | null = null;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  };
  for (;;) {
    ws();
    if (i >= s.length) break;
    const ch = s[i]!;
    if (ch === '(') { cur = []; i++; continue; }
    if (ch === ')') { tuples.push(cur ?? []); cur = null; i++; continue; }
    if (ch === ',') { i++; continue; }
    let v: unknown;
    if (ch === "'") {
      let out = '';
      i++;
      for (;;) {
        if (s[i] === "'" && s[i + 1] === "'") { out += "'"; i += 2; continue; }
        if (s[i] === "'") { i++; break; }
        out += s[i]; i++;
      }
      v = out;
    } else {
      const m = /^(NULL|TRUE|FALSE|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(s.slice(i));
      if (!m) throw new Error(`fake: bad literal at ${s.slice(i, i + 20)}`);
      i += m[0].length;
      const t = m[0].toUpperCase();
      v = t === 'NULL' ? null : t === 'TRUE' ? true : t === 'FALSE' ? false : Number(m[0]);
    }
    if (cur) cur.push(v);
    else tuples.push([v]);
  }
  return tuples;
}

class FakeEngine {
  old: Row[] = [];
  v2: Row[] = [];
  meta: string | null = null;
  calls = 0;
  fault: ((n: number, stmt: string) => Fault) | null = null;
  /** Called before each statement: lets a test write "live" rows mid-run. */
  onCall: ((n: number) => void) | null = null;
  /** Window SELECTs returning more rows than this are refused as too big. */
  maxWindowRows = Infinity;
  /** Window SELECTs returning more rows than this come back cut short with truncated: true. */
  truncateAbove = Infinity;
  /** Statements longer than this are refused like the real engine ("SQL query exceeds maximum length"). */
  maxSqlLength = Infinity;

  private run<T>(stmt: string, exec: () => T): T {
    const n = ++this.calls;
    this.onCall?.(n);
    const f = this.fault?.(n, stmt) ?? null;
    if (f === 'crash') throw Object.assign(new Error(`simulated crash at statement ${n}`), { name: 'SimulatedCrash' });
    if (f === 'transient') throw Object.assign(new Error('no response (ECONNREFUSED)'), { name: 'SynapCoresUnavailableError', code: 'ECONNREFUSED' });
    const out = exec();
    if (f === 'ambiguous') throw Object.assign(new Error('socket hang up (ECONNRESET)'), { name: 'SynapCoresUnavailableError', code: 'ECONNRESET' });
    return out;
  }

  async sql(stmt: string): Promise<{ rows: Row[]; truncated?: boolean }> {
    return this.run(stmt, () => {
      if (stmt.length > this.maxSqlLength) throw Object.assign(new Error('SQL query exceeds maximum length'), { name: 'SynapCoresError', status: 400 });
      const rows = this.exec(stmt);
      if (/^SELECT .+ WHERE received_at >= /.test(stmt) && rows.length > this.truncateAbove) {
        return { rows: rows.slice(0, this.truncateAbove), truncated: true };
      }
      return { rows };
    });
  }

  async saveMeta(m: StoreMeta): Promise<StoreMeta> {
    return this.run('META SAVE', () => {
      this.meta = JSON.stringify(m);
      return m;
    });
  }

  private table(name: string): Row[] {
    if (name === 'pm_events') return this.old;
    if (name === 'pm_events_v2') return this.v2;
    throw new Error(`fake: table ${name}`);
  }

  private exec(stmt: string): Row[] {
    const project = (r: Row) => Object.fromEntries(PM_EVENT_COLUMNS.map((c) => [c, r[c] ?? null]));
    let m = /^SELECT (.+) FROM (\w+) WHERE received_at >= '([^']+)' AND received_at < '([^']+)' LIMIT (\d+)$/.exec(stmt);
    if (m) {
      const rows = this.table(m[2]!).filter((r) => r.received_at != null && String(r.received_at) >= m![3]! && String(r.received_at) < m![4]!);
      if (rows.length > this.maxWindowRows) throw Object.assign(new Error('Query exceeded its memory budget'), { name: 'SynapCoresError', status: 400 });
      return rows.slice(0, Number(m[5])).map(project);
    }
    if ((m = /^SELECT .+ FROM (\w+) WHERE received_at IS NULL(?: AND event_id > '((?:[^']|'')*)')? ORDER BY event_id LIMIT (\d+)$/.exec(stmt))) {
      const after = m[2] == null ? null : m[2].replace(/''/g, "'");
      return this.table(m[1]!)
        .filter((r) => r.received_at == null && (after == null || String(r.event_id) > after))
        .sort((a, b) => (String(a.event_id) < String(b.event_id) ? -1 : 1))
        .slice(0, Number(m[3]))
        .map(project);
    }
    if ((m = /^SELECT MIN\(received_at\) AS lo, MAX\(received_at\) AS hi, COUNT\(\*\) AS n FROM (\w+)$/.exec(stmt))) {
      const t = this.table(m[1]!);
      const ts = t.map((r) => r.received_at).filter((v): v is string => typeof v === 'string').sort();
      return [{ lo: ts[0] ?? null, hi: ts[ts.length - 1] ?? null, n: t.length }];
    }
    if ((m = /^SELECT COUNT\(\*\) AS n FROM (\w+)$/.exec(stmt))) return [{ n: this.table(m[1]!).length }];
    if ((m = /^SELECT COUNT\(\*\) AS n, COUNT\(DISTINCT event_id\) AS d FROM (\w+)$/.exec(stmt))) {
      const t = this.table(m[1]!);
      return [{ n: t.length, d: new Set(t.map((r) => String(r.event_id))).size }];
    }
    if ((m = /^SELECT COUNT\(\*\) AS n FROM (\w+) WHERE received_at >= '([^']+)'$/.exec(stmt))) {
      return [{ n: this.table(m[1]!).filter((r) => r.received_at != null && String(r.received_at) >= m![2]!).length }];
    }
    if ((m = /^SELECT (event_id|COUNT\(\*\) AS n) FROM (\w+) WHERE event_id IN \((.*?)\)(?: LIMIT (\d+))?$/s.exec(stmt))) {
      const ids = new Set(parseValues(m[3]!).map((t) => String(t[0])));
      const hits = this.table(m[2]!).filter((r) => ids.has(String(r.event_id)));
      return m[1] === 'event_id' ? hits.slice(0, m[4] ? Number(m[4]) : 1000).map((r) => ({ event_id: r.event_id })) : [{ n: hits.length }];
    }
    if ((m = /^INSERT INTO (\w+) \(([^)]+)\) VALUES (.*)$/s.exec(stmt))) {
      const cols = m[2]!.split(',');
      const t = this.table(m[1]!);
      for (const tuple of parseValues(m[3]!)) t.push(Object.fromEntries(cols.map((c, i) => [c, tuple[i] ?? null])));
      return [{ count: 1 }];
    }
    throw new Error(`fake: unsupported statement ${stmt.slice(0, 80)}`);
  }
}

function row(i: number, received: string | null, extra: Row = {}): Row {
  const r: Row = Object.fromEntries(PM_EVENT_COLUMNS.map((c) => [c, null]));
  return Object.assign(r, {
    event_id: `old-${String(i).padStart(3, '0')}`, tenant_id: 'tenant-1', anonymous_id: `anon-${i % 7}`, session_id: `s-${i % 11}`,
    occurred_at: received ?? '2026-11-19 12:00:00', received_at: received, event_type: i % 3 ? 'pageview' : 'click',
    page_title: i % 5 ? `Page ${i}` : `O'Brien's "quote" \\ back — ünïcode ${i}`, is_bot: i % 4 === 0, bot_rules_version: 2,
    ip_truncated: i % 2 === 0, latitude: i % 6 ? 37.769999999999996 : -80.5, screen_w: 1440 + i, properties: JSON.stringify({ i, s: "a'b" }),
  }, extra);
}

/** pm_events as of the cutover: bursts in one second, hour/day gaps, window edges, one NULL received_at. */
function oldRows(): Row[] {
  const out: Row[] = [];
  const t0 = Date.UTC(2026, 10, 18, 0, 0, 0);
  const at = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  let i = 0;
  for (let k = 0; k < 7; k++) out.push(row(i++, at(t0)));                    // burst: 7 rows in one second
  for (let k = 1; k <= 20; k++) out.push(row(i++, at(t0 + k * 600_000)));    // every 10 min
  out.push(row(i++, at(t0 + 3_600_000)));                                    // exactly on a window edge
  out.push(row(i++, at(t0 + 3_600_000 - 1_000)));                            // one second before it
  for (let k = 0; k < 12; k++) out.push(row(i++, at(t0 + 86_400_000 + k * 1_000))); // next day, 12 consecutive seconds
  for (let k = 0; k < 10; k++) out.push(row(i++, at(t0 + 3 * 86_400_000 + 7_200_000))); // 10 rows, one second, 3 days later
  out.push(row(i++, null));                                                  // no received_at
  out.push(row(i++, at(t0 + 6 * 86_400_000 + 59_000)));                      // the newest
  return out;
}

const key = (r: Row) => JSON.stringify(PM_EVENT_COLUMNS.map((c) => r[c] ?? null));

function assertExact(e: FakeEngine, live: Row[], label: string) {
  const want = [...e.old, ...live].map(key).sort();
  const got = e.v2.map(key).sort();
  assert.equal(got.length, want.length, `${label}: v2 has ${got.length} rows, want ${want.length}`);
  assert.deepEqual(got, want, `${label}: v2 content differs`);
}

function setup(): { e: FakeEngine; live: Row[]; deps: BackfillDeps; start: StoreMeta } {
  const e = new FakeEngine();
  e.old = oldRows();
  const live: Row[] = [];
  // Collect keeps writing into v2 during the backfill: a live row every 7th statement.
  e.onCall = (n) => {
    if (n % 7 === 0) {
      const r = row(1000 + live.length, '2026-11-25 08:00:01', { event_id: `live-${n}` });
      live.push(r);
      e.v2.push({ ...r });
    }
  };
  const deps: BackfillDeps = {
    sql: (s) => e.sql(s),
    saveMeta: (m) => e.saveMeta(m),
    info: () => undefined,
    warn: () => undefined,
    sleep: async () => undefined,
    opts: OPTS,
    maxAttempts: 5,
  };
  const start = beginBackfill({ ...INITIAL_META }, new Date('2026-11-25T08:00:00Z'));
  e.meta = JSON.stringify(start);
  return { e, live, deps, start };
}

/** Run until done, restarting from the saved state after each simulated crash. */
async function runToEnd(e: FakeEngine, deps: BackfillDeps): Promise<{ meta: StoreMeta; crashes: number }> {
  let crashes = 0;
  for (;;) {
    try {
      return { meta: await runBackfill(parseStoreMeta(e.meta), deps), crashes };
    } catch (err) {
      if ((err as Error).name !== 'SimulatedCrash') throw err;
      crashes++;
      e.fault = null; // the restarted process doesn't crash at the same spot again
    }
  }
}

test('clean run: every pm_events row lands in v2 exactly once, live rows untouched', async () => {
  const { e, live, deps, start } = setup();
  const meta = await runBackfill(start, deps);
  assertExact(e, live, 'clean');
  assert.equal(meta.checked, e.old.length);
  assert.equal(meta.copied, e.old.length);
  assert.equal(meta.nullsDone, true);
  assert.equal(meta.oldSyncedTo, '2026-11-24 00:00:59');
  assert.ok(live.length > 0, 'live writes happened during the run');
  assert.ok(e.calls > 40, `enough statements to exercise windows/chunks (${e.calls})`);
});

test('a crash at any statement: the restarted run resumes without loss or duplicates', async () => {
  const probe = setup();
  await runBackfill(probe.start, probe.deps);
  const n = probe.e.calls;
  assert.ok(n > 40);
  for (let k = 1; k <= n; k++) {
    const { e, live, deps } = setup();
    e.fault = (c) => (c === k ? 'crash' : null);
    const { meta, crashes } = await runToEnd(e, deps);
    assert.equal(crashes, 1, `crash at ${k} happened`);
    assertExact(e, live, `crash at ${k}`);
    assert.equal(meta.checked, e.old.length, `crash at ${k}: checked`);
    assert.equal(parseStoreMeta(e.meta).checked, meta.checked, `crash at ${k}: saved state`);
  }
});

test('a lost reply (statement ran, connection reset) at any statement: no duplicates', async () => {
  const probe = setup();
  await runBackfill(probe.start, probe.deps);
  for (let k = 1; k <= probe.e.calls; k++) {
    const { e, live, deps, start } = setup();
    e.fault = (c) => (c === k ? 'ambiguous' : null);
    const meta = await runBackfill(start, deps);
    assertExact(e, live, `ambiguous at ${k}`);
    assert.equal(meta.checked, e.old.length);
  }
});

test('engine refusing (restart) at any statement, and in bursts: retried, exact', async () => {
  const probe = setup();
  await runBackfill(probe.start, probe.deps);
  for (let k = 1; k <= probe.e.calls; k++) {
    const { e, live, deps, start } = setup();
    e.fault = (c) => (c >= k && c < k + 3 ? 'transient' : null);
    await runBackfill(start, deps);
    assertExact(e, live, `refused at ${k}..${k + 2}`);
  }
});

test('two crashes in a row, then an ambiguous reply: still exact', async () => {
  for (const [a, b] of [[5, 9], [20, 21], [33, 60]] as const) {
    const { e, live, deps } = setup();
    let runs = 0;
    e.fault = (c) => (c === a ? 'crash' : null);
    for (;;) {
      try {
        await runBackfill(parseStoreMeta(e.meta), deps);
        break;
      } catch (err) {
        if ((err as Error).name !== 'SimulatedCrash') throw err;
        runs++;
        const base = e.calls;
        e.fault = runs === 1 ? (c) => (c === base + b ? 'crash' : null) : (c) => (c === base + 3 ? 'ambiguous' : null);
      }
    }
    assertExact(e, live, `crashes ${a}/${b}`);
  }
});

test('a duplicate that lands after its window was verified (delayed INSERT) blocks the flip', async () => {
  const { e, deps, start } = setup();
  e.onCall = null;
  let injected = false;
  const sql = deps.sql;
  const meta = runBackfill(start, {
    ...deps,
    sql: async (stmt) => {
      // the final COUNT(pm_events) = every window done and verified: now a delayed copy of row 3 shows up
      if (!injected && stmt === 'SELECT COUNT(*) AS n FROM pm_events') {
        injected = true;
        e.v2.push({ ...e.old[3]! });
      }
      return sql(stmt);
    },
  });
  await assert.rejects(meta, (err: Error) => err.name === 'PmEventsIntegrityError' && /distinct/.test(err.message));
  assert.ok(injected);
});

test('after an INSERT whose outcome is unknown, the redo waits out the engine statement timeout', async () => {
  const { e, live, deps, start } = setup();
  const sleeps: number[] = [];
  let k = 0;
  e.fault = (_n, stmt) => (stmt.startsWith('INSERT') && ++k === 2 ? 'ambiguous' : null);
  await runBackfill(start, { ...deps, opts: { ...OPTS, ambiguousWaitMs: 75_000 }, sleep: async (ms) => void sleeps.push(ms) });
  assert.ok(sleeps.includes(75_000), `waited 75 s (${sleeps.join(',')})`);
  assertExact(e, live, 'ambiguous insert');
  // a refused INSERT (never reached the engine) is redone after the normal short backoff
  const s2 = setup();
  const sleeps2: number[] = [];
  let k2 = 0;
  s2.e.fault = (_n, stmt) => (stmt.startsWith('INSERT') && ++k2 === 2 ? 'transient' : null);
  await runBackfill(s2.start, { ...s2.deps, opts: { ...OPTS, ambiguousWaitMs: 75_000 }, sleep: async (ms) => void sleeps2.push(ms) });
  assert.ok(!sleeps2.includes(75_000), `no long wait for a refused INSERT (${sleeps2.join(',')})`);
  assertExact(s2.e, s2.live, 'refused insert');
});

test('the final count waits until the cutover is settleMs old', async () => {
  const { deps } = setup();
  const sleeps: number[] = [];
  const now = Date.UTC(2026, 10, 25, 8, 0, 30);
  const start = beginBackfill({ ...INITIAL_META }, new Date(now - 30_000));
  await runBackfill(start, { ...deps, now: () => now, opts: { ...OPTS, settleMs: 120_000 }, sleep: async (ms) => void sleeps.push(ms) });
  assert.ok(sleeps.includes(90_000), `slept the remaining 90 s (${sleeps.join(',')})`);
});

test('a duplicate already in v2 stops the backfill (integrity error), nothing flips', async () => {
  const { e, deps, start } = setup();
  e.onCall = null;
  e.v2.push({ ...e.old[3]! }, { ...e.old[3]! });
  await assert.rejects(runBackfill(start, deps), (err: Error) => err.name === 'PmEventsIntegrityError' && /ids/.test(err.message));
});

test('a row that appears behind the watermark is caught by the final count (second pass)', async () => {
  const { e, live, deps, start } = setup();
  let injected = false;
  const prev = e.onCall!;
  e.onCall = (n) => {
    prev(n);
    // after the copy moved past day 1, a late row with an early received_at shows up in pm_events
    if (!injected && e.meta && (parseStoreMeta(e.meta).watermark ?? '') > '2026-11-19 00:00:00') {
      injected = true;
      e.old.push(row(500, '2026-11-18 00:30:00', { event_id: 'late-1' }));
    }
  };
  const meta = await runBackfill(start, deps);
  assert.ok(injected);
  assertExact(e, live, 'late row');
  assert.equal(meta.passes, 2);
  assert.equal(meta.checked, e.old.length);
});

test('windows the engine refuses as too big are split until they fit', async () => {
  const { e, live, deps, start } = setup();
  e.maxWindowRows = 10; // the 10-rows-in-one-second burst just fits (a 1 s window is the floor); bigger windows are refused
  const meta = await runBackfill(start, deps);
  assertExact(e, live, 'too big');
  assert.equal(meta.checked, e.old.length);
});

test('INSERTs over the engine max SQL length are refused, then packed smaller for the rest of the run', async () => {
  const { e, live, deps, start } = setup();
  e.maxSqlLength = 2_500; // one row is ~700 chars here: 3-row statements are refused, 1-2 row ones pass
  const meta = await runBackfill(start, deps);
  assertExact(e, live, 'max length');
  assert.equal(meta.checked, e.old.length);
});

test('INSERT batches are packed by SQL size as well as rows', async () => {
  const { insertGroups } = await import('../src/lib/visitor/events-v2');
  const rows = oldRows().slice(0, 9);
  const groups = insertGroups('pm_events_v2', rows, 100, 2_000);
  assert.ok(groups.length >= 3, `split by size (${groups.length} groups)`);
  assert.deepEqual(groups.flat(), rows);
  assert.deepEqual(insertGroups('pm_events_v2', rows, 4, 1_000_000).map((g) => g.length), [4, 4, 1]);
  assert.deepEqual(insertGroups('pm_events_v2', rows.slice(0, 1), 4, 10).map((g) => g.length), [1], 'a row bigger than the budget still goes alone');
});

test('a window result the engine truncates is split, never taken as complete', async () => {
  const { e, live, deps, start } = setup();
  e.truncateAbove = 10;
  const meta = await runBackfill(start, deps);
  assertExact(e, live, 'truncated');
  assert.equal(meta.checked, e.old.length);
});

test('resuming from a saved watermark skips verified windows (no re-read of history)', async () => {
  const { e, live, deps, start } = setup();
  e.fault = (c) => (c === 45 ? 'crash' : null);
  await assert.rejects(runBackfill(start, deps), (err: Error) => err.name === 'SimulatedCrash');
  const saved = parseStoreMeta(e.meta);
  assert.ok(saved.watermark, 'a watermark was saved before the crash');
  e.fault = null;
  const seen: string[] = [];
  const meta = await runBackfill(saved, { ...deps, sql: (s) => (seen.push(s), e.sql(s)) });
  const firstWindow = seen.find((s) => s.includes('received_at >= '));
  assert.ok(firstWindow?.includes(`received_at >= '${saved.watermark}'`), 'first window starts at the watermark');
  assertExact(e, live, 'resume');
  assert.equal(meta.checked, e.old.length);
});

test('rows without received_at are paged by event_id (more than one window LIMIT of them)', async () => {
  const { e, live, deps, start } = setup();
  for (let k = 0; k < 30; k++) e.old.push(row(800 + k, null, { event_id: `null-${String(k).padStart(2, '0')}` }));
  e.fault = (c) => (c === 9 ? 'crash' : c === 15 ? 'ambiguous' : null);
  const { meta } = await runToEnd(e, deps);
  void start;
  assertExact(e, live, 'null rows');
  assert.equal(meta.checked, e.old.length);
});

test('empty pm_events: nothing to copy, verified at once', async () => {
  const { e, deps, start } = setup();
  e.old = [];
  e.onCall = null;
  const meta = await runBackfill(start, deps);
  assert.equal(meta.checked, 0);
  assert.equal(e.v2.length, 0);
});

test('catch-up (state v2, flag-off rows in pm_events after the cutover): copies exactly those, once', async () => {
  const { e, live, deps, start } = setup();
  let meta = await runBackfill(start, deps);
  meta = { ...meta, state: 'v2' };
  e.meta = JSON.stringify(meta);
  e.onCall = null;
  assert.equal(meta.oldCount, e.old.length, 'the verified pm_events count is kept for the boot check');
  assert.equal(await runCatchUp(meta, deps), null, 'nothing to do right after the backfill');
  // a row that landed in pm_events after the flip with an OLD received_at is found too (count-based check)
  e.old.push(row(699, '2026-11-18 00:00:05', { event_id: 'late-old-ts' }));
  const flagOff = [row(700, '2026-11-25 09:00:00', { event_id: 'off-1' }), row(701, '2026-11-25 09:00:00', { event_id: 'off-2' }), row(702, '2026-11-25 10:30:00', { event_id: 'off-3' })];
  e.old.push(...flagOff);
  const next = await runCatchUp(meta, deps);
  assert.ok(next);
  assert.equal(next?.oldSyncedTo, '2026-11-25 10:30:00');
  assertExact(e, live, 'catch-up');
  assert.equal(await runCatchUp(next!, deps), null, 'idempotent: nothing left');
});
