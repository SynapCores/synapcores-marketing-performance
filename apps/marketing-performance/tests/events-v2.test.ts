import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PM_EVENTS_DDL, PM_EVENT_COLUMNS } from '../src/lib/visitor/events';
import { truncationGuardSql, truncationSql } from '../src/lib/visitor/retention';
import { lit } from '../src/lib/visitor/sql-lit';
import {
  BACKFILL,
  INITIAL_META,
  PM_EVENTS_META_DDL,
  beginBackfill,
  boundsSql,
  chunk,
  classifyFailure,
  countSinceSql,
  dupCheckSql,
  formatSqlTs,
  idsInSql,
  insertRowsSql,
  metaSaveSql,
  metaSelectSql,
  nextSpanMs,
  nullPageSql,
  parseSqlTs,
  parseStoreMeta,
  pickStoreMeta,
  pmEventsV2Ddl,
  pmEventsV2Enabled,
  progressPct,
  retryDelayMs,
  rowsToCopy,
  shrinkSpanMs,
  tablesFor,
  windowBounds,
  windowSelectSql,
  windowVerdict,
} from '../src/lib/visitor/events-v2';

const engineError = (status: number, message: string) => Object.assign(new Error(message), { name: 'SynapCoresError', status });
const unavailable = (code: string) => Object.assign(new Error(`no response (${code})`), { name: 'SynapCoresUnavailableError', code });

/** "name TYPE" pairs of a CREATE TABLE statement, in order. */
function columnsOf(ddl: string): string[] {
  const body = ddl.slice(ddl.indexOf('(') + 1, ddl.lastIndexOf(')'));
  return body.split(',').map((c) => c.trim().replace(/\s+/g, ' ').replace(/ PRIMARY KEY$/, ''));
}

test('flag: PM_EVENTS_V2 accepts 1/true/on/yes only', () => {
  for (const v of ['1', 'true', 'TRUE', ' on ', 'yes']) assert.equal(pmEventsV2Enabled({ PM_EVENTS_V2: v }), true, v);
  for (const v of [undefined, '', '0', 'false', 'off', 'no', '2', 'enabled']) assert.equal(pmEventsV2Enabled({ PM_EVENTS_V2: v }), false, String(v));
  assert.equal(pmEventsV2Enabled({}), false);
});

test('v2 DDL: same columns and types as pm_events, no primary key, no index', () => {
  const v2 = pmEventsV2Ddl();
  assert.match(v2, /^CREATE TABLE IF NOT EXISTS pm_events_v2 \(/);
  assert.doesNotMatch(v2, /PRIMARY KEY|UNIQUE|INDEX/i);
  assert.deepEqual(columnsOf(v2), columnsOf(PM_EVENTS_DDL[0] ?? ''));
  assert.deepEqual(columnsOf(v2).map((c) => c.split(' ')[0]), [...PM_EVENT_COLUMNS]);
  assert.match(columnsOf(v2)[0] ?? '', /^event_id TEXT$/);
  // the old table keeps its key and indexes (it is the rollback source)
  assert.match(PM_EVENTS_DDL[0] ?? '', /event_id TEXT PRIMARY KEY/);
  assert.equal(PM_EVENTS_DDL.length, 3);
  assert.doesNotMatch(PM_EVENTS_META_DDL, /PRIMARY KEY|INDEX/i);
});

test('state: parse is tolerant, duplicates resolve to the most advanced state', () => {
  assert.deepEqual(parseStoreMeta(null), INITIAL_META);
  assert.deepEqual(parseStoreMeta('{not json'), INITIAL_META);
  assert.deepEqual(parseStoreMeta('{"state":"v3"}'), INITIAL_META);
  const m = parseStoreMeta(JSON.stringify({ state: 'backfill', cutoverAt: '2026-11-25T08:00:00.000Z', watermark: '2026-11-20 01:00:00', checked: 12.7, copied: -3, nullsDone: 'yes' }));
  assert.equal(m.state, 'backfill');
  assert.equal(m.watermark, '2026-11-20 01:00:00');
  assert.equal(m.checked, 12);
  assert.equal(m.copied, 0);
  assert.equal(m.nullsDone, false);
  assert.equal(parseStoreMeta({ state: 'v2', watermark: "x'; DROP" }).watermark, null);
  assert.deepEqual(pickStoreMeta([]), { meta: INITIAL_META, exists: false });
  const two = pickStoreMeta([JSON.stringify({ state: 'backfill', updatedAt: '2026-11-25T09:00:00Z' }), JSON.stringify({ state: 'v2', updatedAt: '2026-11-25T08:00:00Z' })]);
  assert.equal(two.meta.state, 'v2');
  assert.equal(two.exists, true);
});

test('state: the cutover happens once (v1 → backfill), later states are kept', () => {
  const now = new Date('2026-11-25T08:00:00.123Z');
  const b = beginBackfill({ ...INITIAL_META }, now);
  assert.equal(b.state, 'backfill');
  assert.equal(b.cutoverAt, '2026-11-25T08:00:00.123Z');
  assert.equal(b.watermark, null);
  assert.equal(b.checked, 0);
  assert.equal(b.passes, 1);
  assert.equal(beginBackfill(b, new Date()), b);
  const v2 = { ...b, state: 'v2' as const };
  assert.equal(beginBackfill(v2, new Date()), v2);
});

test('tables: flag off = pm_events only; flag on writes v2 at once, reads v2 only after the backfill', () => {
  for (const s of [null, 'v1', 'backfill', 'v2'] as const) assert.deepEqual(tablesFor(false, s), { read: 'pm_events', write: 'pm_events' });
  assert.deepEqual(tablesFor(true, null), { read: 'pm_events', write: null });
  assert.deepEqual(tablesFor(true, 'v1'), { read: 'pm_events', write: null });
  assert.deepEqual(tablesFor(true, 'backfill'), { read: 'pm_events', write: 'pm_events_v2' });
  assert.deepEqual(tablesFor(true, 'v2'), { read: 'pm_events_v2', write: 'pm_events_v2' });
});

test('meta SQL: one row keyed pm_events_store, insert first then update; JSON is quoted', () => {
  assert.equal(metaSelectSql(), "SELECT v FROM pm_events_meta WHERE k = 'pm_events_store'");
  const m = { ...INITIAL_META, state: 'backfill' as const, cutoverAt: "it's" };
  assert.match(metaSaveSql(m, false), /^INSERT INTO pm_events_meta \(k, v\) VALUES \('pm_events_store', '\{.*"cutoverAt":"it''s".*\}'\)$/);
  assert.match(metaSaveSql(m, true), /^UPDATE pm_events_meta SET v = '\{.*\}' WHERE k = 'pm_events_store'$/);
});

test('windows: timestamps, spans and bounds', () => {
  assert.equal(parseSqlTs('2026-11-20 01:02:03'), Date.UTC(2026, 10, 20, 1, 2, 3));
  assert.equal(parseSqlTs('2026-11-20T01:02:03.456Z'), Date.UTC(2026, 10, 20, 1, 2, 3));
  assert.equal(parseSqlTs('20 Nov'), null);
  assert.equal(parseSqlTs('2026-11-20 01:02:03+00:00'), Date.UTC(2026, 10, 20, 1, 2, 3));
  assert.equal(parseSqlTs('2026-11-20T01:02:03+0000'), Date.UTC(2026, 10, 20, 1, 2, 3));
  assert.equal(parseSqlTs('2026-11-20 01:02:03+05:00'), null, 'a non-UTC offset is not silently taken as UTC');
  assert.equal(parseSqlTs(null), null);
  assert.equal(formatSqlTs(Date.UTC(2026, 10, 20, 1, 2, 3, 999)), '2026-11-20 01:02:03');
  assert.deepEqual(windowBounds('2026-11-20 23:30:00', 3_600_000), { lo: '2026-11-20 23:30:00', hi: '2026-11-21 00:30:00' });
  assert.deepEqual(windowBounds('2026-11-20 23:30:00', 10), { lo: '2026-11-20 23:30:00', hi: '2026-11-20 23:30:01' });
  assert.throws(() => windowBounds('nope', 1000));
  // adapt: big window halves, small doubles, in whole seconds within bounds
  assert.equal(nextSpanMs(3_600_000, 5_000), 1_800_000);
  assert.equal(nextSpanMs(3_600_000, 100), 7_200_000);
  assert.equal(nextSpanMs(3_600_000, 1_000), 3_600_000);
  assert.equal(nextSpanMs(1_000, 99_999), 1_000);
  assert.equal(nextSpanMs(BACKFILL.maxSpanMs, 0), BACKFILL.maxSpanMs);
  assert.equal(nextSpanMs(3_001, 5_000), 1_000);
  assert.equal(shrinkSpanMs(3_600_000), 1_800_000);
  assert.equal(shrinkSpanMs(1_500), 1_000);
  assert.equal(shrinkSpanMs(1_000), null);
});

test('backfill SQL: explicit columns and LIMITs, validated timestamps and tables, quoted ids', () => {
  const cols = PM_EVENT_COLUMNS.join(', ');
  assert.equal(
    windowSelectSql('pm_events', '2026-11-20 00:00:00', '2026-11-20 01:00:00', 2000),
    `SELECT ${cols} FROM pm_events WHERE received_at >= '2026-11-20 00:00:00' AND received_at < '2026-11-20 01:00:00' LIMIT 2000`,
  );
  assert.equal(nullPageSql('pm_events', null, 2000), `SELECT ${cols} FROM pm_events WHERE received_at IS NULL ORDER BY event_id LIMIT 2000`);
  assert.equal(nullPageSql('pm_events', "a'b", 5), `SELECT ${cols} FROM pm_events WHERE received_at IS NULL AND event_id > 'a''b' ORDER BY event_id LIMIT 5`);
  assert.throws(() => windowSelectSql('pm_events', "2026-11-20 00:00:00' OR '1'='1", '2026-11-20 01:00:00', 10));
  assert.throws(() => windowSelectSql('users', '2026-11-20 00:00:00', '2026-11-20 01:00:00', 10));
  assert.throws(() => windowSelectSql('pm_events', '2026-11-20 00:00:00', '2026-11-20 01:00:00', 0));
  assert.ok(BACKFILL.windowLimit > 2 * BACKFILL.targetRows, 'a normal window never fills its LIMIT');
  const uuids = Array.from({ length: BACKFILL.idChunk }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  assert.ok(idsInSql('pm_events_v2', uuids, 'ids').length < 99_996, 'an id lookup stays under the engine statement limit');
  assert.equal(boundsSql('pm_events'), 'SELECT MIN(received_at) AS lo, MAX(received_at) AS hi, COUNT(*) AS n FROM pm_events');
  assert.equal(countSinceSql('pm_events', '2026-11-25 08:00:00'), "SELECT COUNT(*) AS n FROM pm_events WHERE received_at >= '2026-11-25 08:00:00'");
  assert.equal(dupCheckSql('pm_events_v2'), 'SELECT COUNT(*) AS n, COUNT(DISTINCT event_id) AS d FROM pm_events_v2');
  assert.equal(idsInSql('pm_events_v2', ['a', "b'c"], 'ids'), "SELECT event_id FROM pm_events_v2 WHERE event_id IN ('a','b''c') LIMIT 8");
  assert.equal(idsInSql('pm_events_v2', ['a'], 'count'), "SELECT COUNT(*) AS n FROM pm_events_v2 WHERE event_id IN ('a')");
  assert.throws(() => idsInSql('pm_events_v2', [], 'ids'));
  const row: Record<string, unknown> = Object.fromEntries(PM_EVENT_COLUMNS.map((c) => [c, null]));
  Object.assign(row, { event_id: 'e1', tenant_id: 't', is_bot: false, latitude: 37.769999999999996, screen_w: 1440, page_title: "O'Brien \\ x" });
  const ins = insertRowsSql('pm_events_v2', [row, row]);
  assert.ok(ins.startsWith(`INSERT INTO pm_events_v2 (${PM_EVENT_COLUMNS.join(',')}) VALUES (`));
  assert.ok(ins.includes(`'O''Brien \\ x'`));
  assert.ok(ins.includes(',37.769999999999996,'));
  assert.equal(ins.split('),(').length, 2);
  assert.throws(() => insertRowsSql('pm_events_v2', []));
  assert.equal(lit("a'b"), "'a''b'");
});

test('copy decisions: missing ids, verdicts, chunks', () => {
  const rows = [{ event_id: 'a' }, { event_id: 'b' }, { event_id: 'c' }];
  assert.deepEqual(rowsToCopy(rows, new Set(['b'])), [{ event_id: 'a' }, { event_id: 'c' }]);
  assert.deepEqual(rowsToCopy(rows, new Set(['a', 'b', 'c'])), []);
  assert.throws(() => rowsToCopy([{ event_id: null }], new Set()));
  assert.equal(windowVerdict(3, 3), 'ok');
  assert.equal(windowVerdict(3, 2), 'missing');
  assert.equal(windowVerdict(3, 4), 'duplicate');
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
  assert.equal(progressPct(50, 200), 25);
  assert.equal(progressPct(5, 0), 100);
});

test('failures: engine restarts are transient, size refusals shrink, the rest stops', () => {
  assert.equal(classifyFailure(unavailable('ECONNREFUSED')), 'transient');
  assert.equal(classifyFailure(unavailable('ECONNRESET')), 'transient');
  assert.equal(classifyFailure(engineError(503, 'unavailable')), 'transient');
  assert.equal(classifyFailure(engineError(429, 'SQL concurrency or queue capacity is exhausted; retry later')), 'transient');
  assert.equal(classifyFailure(engineError(400, 'Query exceeded its memory budget (256 MiB)')), 'too_big');
  assert.equal(classifyFailure(engineError(413, 'payload too large')), 'too_big');
  assert.equal(classifyFailure(engineError(400, 'Query operation error: parse error near FROM')), 'fatal');
  assert.equal(classifyFailure(engineError(404, "table 'pm_events_v2' not found")), 'fatal');
  assert.equal(classifyFailure(new Error('boom')), 'fatal');
  assert.equal(classifyFailure(engineError(503, 'resource exhausted, retry')), 'transient', 'overload status wins over a size-like message');
  assert.equal(classifyFailure(engineError(400, 'SQL query exceeds maximum length')), 'too_big');
  assert.equal(classifyFailure(engineError(413, 'window result too large (2000 rows, limit 2000)')), 'too_big');
  assert.equal(classifyFailure(Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })), 'transient');
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(retryDelayMs), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
});

test('retention sweep targets the table that holds the events', () => {
  assert.equal(truncationSql('2026-08-17 00:00:00'), "UPDATE pm_events SET ip = ip_prefix, ip_truncated = TRUE WHERE received_at < '2026-08-17 00:00:00' AND ip_truncated = FALSE");
  assert.equal(truncationSql('2026-08-17 00:00:00', 'pm_events_v2'), "UPDATE pm_events_v2 SET ip = ip_prefix, ip_truncated = TRUE WHERE received_at < '2026-08-17 00:00:00' AND ip_truncated = FALSE");
  assert.throws(() => truncationSql('2026-08-17 00:00:00', 'users' as 'pm_events'));
  assert.equal(truncationGuardSql('2026-08-17 00:00:00', 'pm_events_v2'), "SELECT event_id FROM pm_events_v2 WHERE received_at < '2026-08-17 00:00:00' AND ip_truncated = FALSE LIMIT 1");
  assert.throws(() => truncationGuardSql("x' OR 1=1 --", 'pm_events_v2'));
  assert.throws(() => truncationGuardSql('2026-08-17 00:00:00', 'users' as 'pm_events'));
  assert.equal(truncationGuardSql('2026-08-17 00:00:00', 'pm_events'), "SELECT event_id FROM pm_events WHERE received_at < '2026-08-17 00:00:00' AND ip_truncated = FALSE LIMIT 1");
});

test('ops script (bin/pm-events-v2.mjs): columns, reply envelope, dates, strict args, packing, redaction', () => {
  // The script is ESM; Node >= 22 loads it with require() (it only runs main() as the entry script).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ops = require(join(__dirname, '..', '..', 'bin', 'pm-events-v2.mjs'));
  assert.deepEqual(ops.COLUMNS, [...PM_EVENT_COLUMNS]);
  // the engine wraps every reply in { data: { columns, rows, truncated }, meta }
  const reply = JSON.stringify({ data: { columns: [{ name: 'n', data_type: 'INTEGER', nullable: true }], rows: [[3]], truncated: false }, meta: {} });
  assert.deepEqual(ops.parseReply(reply).rows, [{ n: 3 }]);
  assert.equal(ops.parseReply(JSON.stringify({ data: { columns: ['a'], rows: [[1]], truncated: true } })).truncated, true);
  assert.throws(() => ops.parseReply(JSON.stringify({ meta: {} })), /no columns/);
  assert.throws(() => ops.parseReply(JSON.stringify({ columns: [], meta: {} })));
  // only real dates in the exact shape
  assert.equal(ops.parseTs('2026-11-24 10:00:00'), Date.UTC(2026, 10, 24, 10));
  for (const bad of ['2026-24-11 10:00:00', '2026-11-24 25:00:00', '2026-02-30 00:00:00', '2026-11-24', null]) assert.equal(ops.parseTs(bad), null, String(bad));
  // strict args
  assert.deepEqual(ops.parseArgs(['--env', '/x/app.env', 'reverse-copy', '--apply', '--pause-ms', '500']), {
    cmd: 'reverse-copy', env: '/x/app.env', apply: true, force: false, since: null, pauseMs: 500,
  });
  for (const bad of [[], ['nope'], ['reverse-copy', '--aply'], ['reverse-copy', '--pause-ms', 'abc'], ['reverse-copy', '--pause-ms'],
    ['reverse-copy', '--since', '2026-24-11 10:00:00'], ['verify', '--apply'], ['status', 'extra']]) {
    assert.throws(() => ops.parseArgs(bad), Error, JSON.stringify(bad));
  }
  // INSERT packing stays under the engine limit, head included
  const row: Record<string, unknown> = Object.fromEntries(PM_EVENT_COLUMNS.map((c) => [c, null]));
  Object.assign(row, { event_id: 'e', tenant_id: 't', user_agent: 'x'.repeat(2000), properties: 'p'.repeat(4000) });
  const packs: string[][] = ops.packValues(Array.from({ length: 60 }, () => row));
  assert.ok(packs.length > 1);
  const head = `INSERT INTO pm_events (${PM_EVENT_COLUMNS.join(',')}) VALUES `;
  for (const p of packs) assert.ok(Buffer.byteLength(head + p.join(','), 'utf8') <= 90 * 1024);
  assert.equal(packs.flat().length, 60);
  // engine errors can echo row values: quoted literals and IPs are redacted
  assert.equal(ops.redact("parse error near '203.0.113.7' and 10.0.0.1"), "parse error near '…' and <ip>");
  assert.equal(ops.redact('at 06:05:58 from 2001:db8::7'), 'at 06:05:58 from <ip>');
  // only the engine's not-found answer means "missing"; anything else must surface
  assert.equal(ops.isNotFound(new Error("engine HTTP 400: Query operation error: Table or collection '…' does not exist")), true);
  for (const m of ['engine HTTP 401: unauthorized', 'connect ECONNREFUSED 127.0.0.1:18420', 'engine request timed out', 'engine HTTP 500: does not exist']) assert.equal(ops.isNotFound(new Error(m)), false, m);
  assert.equal(ops.parseArgs(['dedupe', '--apply']).apply, true);
  assert.throws(() => ops.parseArgs(['dedupe', '--since', '2026-11-24 10:00:00']));
  // verify tolerates sweep/reclassify edits only in those columns
  const a = { ...row, ip: '198.51.100.7', ip_truncated: false, is_bot: false };
  const b = { ...row, ip: '198.51.100.0', ip_truncated: true, is_bot: true };
  assert.notEqual(ops.canon(a), ops.canon(b));
  assert.equal(ops.canon(a, ops.MUTABLE), ops.canon(b, ops.MUTABLE));
  assert.notEqual(ops.canon({ ...a, page_url: 'x' }, ops.MUTABLE), ops.canon(b, ops.MUTABLE));
});
