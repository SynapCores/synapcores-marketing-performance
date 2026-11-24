import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QueryCache,
  QUERY_CACHE_DEFAULTS,
  cacheKey,
  copyQueryResult,
  estimateBytes,
  isCacheableSql,
  queryCacheOptionsFromEnv,
} from '../src/lib/query-cache';
import { ATTRIBUTION, QUERIES, SCHEMA, SCORECARD, SEED } from '../src/lib/recipe-sql';

type Result = { columns: string[]; rows: Array<Record<string, unknown>> };

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function counter(rows: Array<Record<string, unknown>> = [{ n: 1 }]) {
  const calls: string[] = [];
  const load = (label = 'q') => () => {
    calls.push(label);
    return Promise.resolve<Result>({ columns: Object.keys(rows[0] ?? {}), rows: rows.map((r) => ({ ...r })) });
  };
  return { calls, load };
}

const SELECT = 'SELECT anonymous_id, COUNT(*) AS events FROM pm_events WHERE tenant_id = $1 GROUP BY anonymous_id';

test('serves a repeat read from the cache within the TTL, then reloads after it', async () => {
  const c = clock();
  const cache = new QueryCache({ ttlMs: 30_000, maxEntries: 10, maxBytes: 1 << 20, now: c.now });
  const { calls, load } = counter();
  await cache.run('tenant:a', SELECT, ['a'], load());
  await cache.run('tenant:a', SELECT, ['a'], load());
  c.advance(29_999);
  await cache.run('tenant:a', SELECT, ['a'], load());
  assert.equal(calls.length, 1);
  c.advance(2);
  await cache.run('tenant:a', SELECT, ['a'], load());
  assert.equal(calls.length, 2);
  const s = cache.stats();
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 2);
});

test('the key is tenant + SQL + params: no sharing across tenants or params', async () => {
  const cache = new QueryCache({ ttlMs: 60_000, maxEntries: 10, maxBytes: 1 << 20 });
  const { calls, load } = counter();
  await cache.run('tenant:a', SELECT, ['a'], load('a'));
  await cache.run('tenant:b', SELECT, ['a'], load('b-same-sql-params'));
  await cache.run('tenant:a', SELECT, ['b'], load('a-other-param'));
  await cache.run('tenant:a', SELECT + ' LIMIT 5', ['a'], load('a-other-sql'));
  await cache.run('tenant:a', SELECT, ['a'], load('a-again'));
  assert.deepEqual(calls, ['a', 'b-same-sql-params', 'a-other-param', 'a-other-sql']);
  assert.notEqual(cacheKey('tenant:a', SELECT, [1]), cacheKey('tenant:a', SELECT, ['1']));
});

test('concurrent identical reads share one engine query (single flight)', async () => {
  const cache = new QueryCache({ ttlMs: 30_000, maxEntries: 10, maxBytes: 1 << 20 });
  let calls = 0;
  let release!: (r: Result) => void;
  const load = () => {
    calls++;
    return new Promise<Result>((resolve) => (release = resolve));
  };
  const pending = Array.from({ length: 20 }, () => cache.run('tenant:a', SELECT, ['a'], load, copyQueryResult));
  assert.equal(calls, 1);
  release({ columns: ['n'], rows: [{ n: 7 }] });
  const results = await Promise.all(pending);
  assert.equal(calls, 1);
  for (const r of results) assert.deepEqual(r.rows, [{ n: 7 }]);
});

test('errors are not cached', async () => {
  const cache = new QueryCache({ ttlMs: 30_000, maxEntries: 10, maxBytes: 1 << 20 });
  let calls = 0;
  const failing = () => {
    calls++;
    return Promise.reject(new Error('engine timeout'));
  };
  await assert.rejects(cache.run('tenant:a', SELECT, [], failing), /engine timeout/);
  await assert.rejects(cache.run('tenant:a', SELECT, [], failing), /engine timeout/);
  assert.equal(calls, 2);
  assert.equal(cache.stats().entries, 0);
});

test('writes and other non-cacheable statements always reach the engine', async () => {
  const cache = new QueryCache({ ttlMs: 30_000, maxEntries: 10, maxBytes: 1 << 20 });
  const { calls, load } = counter();
  const insert = `INSERT INTO pm_campaigns (campaign_id, tenant_id) VALUES ('x', 'a')`;
  await cache.run('tenant:a', insert, [], load());
  await cache.run('tenant:a', insert, [], load());
  await cache.run('', SELECT, [], load()); // no tenant scope → uncached
  await cache.run('', SELECT, [], load());
  assert.equal(calls.length, 4);
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().bypassed, 4);
});

test('QUERY_CACHE_TTL_MS=0 turns the cache off', async () => {
  const cache = new QueryCache({ ...queryCacheOptionsFromEnv({ QUERY_CACHE_TTL_MS: '0' }) });
  assert.equal(cache.enabled, false);
  const { calls, load } = counter();
  await cache.run('tenant:a', SELECT, ['a'], load());
  await cache.run('tenant:a', SELECT, ['a'], load());
  assert.equal(calls.length, 2);
  assert.equal(cache.stats().entries, 0);
});

test('LRU: evicts the least recently used entry beyond maxEntries', async () => {
  const cache = new QueryCache({ ttlMs: 60_000, maxEntries: 3, maxBytes: 1 << 20 });
  const { calls, load } = counter();
  const q = (i: number) => `${SELECT} LIMIT ${i}`;
  for (const i of [1, 2, 3]) await cache.run('tenant:a', q(i), ['a'], load(`q${i}`));
  await cache.run('tenant:a', q(1), ['a'], load('q1-again')); // touch 1 → 2 is now the oldest
  await cache.run('tenant:a', q(4), ['a'], load('q4')); // evicts 2
  assert.equal(cache.stats().entries, 3);
  await cache.run('tenant:a', q(1), ['a'], load('q1-third'));
  await cache.run('tenant:a', q(3), ['a'], load('q3-again'));
  await cache.run('tenant:a', q(2), ['a'], load('q2-reloaded'));
  assert.deepEqual(calls, ['q1', 'q2', 'q3', 'q4', 'q2-reloaded']);
  assert.ok(cache.stats().evictions >= 1);
});

test('byte cap: total size stays bounded and oversized results are not kept', async () => {
  const row = { anonymous_id: 'x'.repeat(100) };
  const one = estimateBytes({ columns: ['anonymous_id'], rows: [row] });
  const cache = new QueryCache({ ttlMs: 60_000, maxEntries: 100, maxBytes: one * 3, maxEntryBytes: one * 2 });
  const { calls, load } = counter([row]);
  for (let i = 0; i < 6; i++) await cache.run('tenant:a', `${SELECT} LIMIT ${i}`, [], load(`q${i}`));
  const s = cache.stats();
  assert.ok(s.bytes <= one * 3, `bytes ${s.bytes} over cap ${one * 3}`);
  assert.equal(s.entries, 3);

  const big = { columns: ['blob'], rows: [{ blob: 'y'.repeat(one * 4) }] };
  let bigCalls = 0;
  const loadBig = () => {
    bigCalls++;
    return Promise.resolve(big);
  };
  const r1 = await cache.run('tenant:a', 'SELECT blob FROM recipe_pm_creative', [], loadBig);
  const r2 = await cache.run('tenant:a', 'SELECT blob FROM recipe_pm_creative', [], loadBig);
  assert.equal(r1.rows[0]!.blob, big.rows[0]!.blob); // still returned to the caller
  assert.equal(r2.rows.length, 1);
  assert.equal(bigCalls, 2); // but never kept
  assert.ok(cache.stats().tooLarge >= 2);
  assert.equal(calls.length, 6);
});

test('invalidate(scope) clears one tenant; invalidate() clears everything', async () => {
  const cache = new QueryCache({ ttlMs: 60_000, maxEntries: 10, maxBytes: 1 << 20 });
  const { calls, load } = counter();
  await cache.run('tenant:a', SELECT, ['a'], load('a1'));
  await cache.run('tenant:b', SELECT, ['b'], load('b1'));
  cache.invalidate('tenant:a');
  await cache.run('tenant:a', SELECT, ['a'], load('a2'));
  await cache.run('tenant:b', SELECT, ['b'], load('b-cached'));
  assert.deepEqual(calls, ['a1', 'b1', 'a2']);
  cache.invalidate();
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().bytes, 0);
  await cache.run('tenant:b', SELECT, ['b'], load('b2'));
  assert.deepEqual(calls, ['a1', 'b1', 'a2', 'b2']);
});

test('a read that was in flight during a write is returned but not kept', async () => {
  const cache = new QueryCache({ ttlMs: 60_000, maxEntries: 10, maxBytes: 1 << 20 });
  let release!: (r: Result) => void;
  let calls = 0;
  const slow = () => {
    calls++;
    return new Promise<Result>((resolve) => (release = resolve));
  };
  const before = cache.run('tenant:a', SELECT, ['a'], slow);
  cache.invalidate('tenant:a'); // e.g. a campaign was saved meanwhile
  release({ columns: ['n'], rows: [{ n: 'old' }] });
  assert.deepEqual((await before).rows, [{ n: 'old' }]);
  const fresh = () => {
    calls++;
    return Promise.resolve<Result>({ columns: ['n'], rows: [{ n: 'new' }] });
  };
  assert.deepEqual((await cache.run('tenant:a', SELECT, ['a'], fresh)).rows, [{ n: 'new' }]);
  assert.equal(calls, 2);
});

test('every caller gets its own rows array (sorting one result leaves the cache alone)', async () => {
  const cache = new QueryCache({ ttlMs: 60_000, maxEntries: 10, maxBytes: 1 << 20 });
  const load = () => Promise.resolve<Result>({ columns: ['spend'], rows: [{ spend: 3 }, { spend: 1 }, { spend: 2 }] });
  const a = await cache.run('tenant:a', QUERIES.scorecard, [], load, copyQueryResult);
  a.rows.sort((x, y) => Number(x.spend) - Number(y.spend));
  a.rows.push({ spend: 99 });
  const b = await cache.run('tenant:a', QUERIES.scorecard, [], load, copyQueryResult);
  assert.deepEqual(b.rows.map((r) => r.spend), [3, 1, 2]);
});

test('isCacheableSql admits the report reads', () => {
  for (const [name, sql] of Object.entries(QUERIES)) assert.ok(isCacheableSql(sql), `QUERIES.${name} should be cacheable`);
  const reports = [
    // event-store.ts listVisitors (note the `AS sessions` alias)
    `SELECT anonymous_id, MIN(occurred_at) AS first_seen, MAX(occurred_at) AS last_seen, COUNT(*) AS events,
            COUNT(DISTINCT session_id) AS sessions,
            SUM(CASE WHEN event_type = 'pageview' OR event_type = 'page_view' THEN 1 ELSE 0 END) AS pageviews,
            COUNT(DISTINCT page_path) AS pages, MAX(CASE WHEN is_bot = TRUE THEN 1 ELSE 0 END) AS any_bot
       FROM pm_events WHERE tenant_id = $1 AND occurred_at >= $2
      GROUP BY anonymous_id ORDER BY last_seen DESC LIMIT 20000`,
    `SELECT * FROM (SELECT tenant_id, anonymous_id, ip, ROW_NUMBER() OVER (PARTITION BY anonymous_id ORDER BY is_bot DESC, occurred_at DESC) AS rn
       FROM pm_events WHERE tenant_id = $1 AND anonymous_id IN ($2,$3)) z WHERE rn = 1`,
    `SELECT * FROM pm_campaigns WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1000`,
    `SELECT * FROM pm_events WHERE tenant_id = $1 AND anonymous_id = $2 ORDER BY occurred_at ASC LIMIT 2000`,
    `SELECT anonymous_id, event_type, MIN(occurred_at) AS first_at FROM pm_events
      WHERE tenant_id = $1 AND event_type IN ('lead','signup','purchase','delete_me') GROUP BY anonymous_id, event_type LIMIT 100000`,
    `SELECT COUNT(*) FROM recipe_pm_click_events`,
    `SELECT * FROM recipe_pm_creative LIMIT 500`,
    `  -- leading comment\n  WITH t AS (SELECT 1 AS n) SELECT n FROM t`,
    `/* block */ select 1`,
  ];
  for (const sql of reports) assert.ok(isCacheableSql(sql), `should be cacheable: ${sql.slice(0, 60)}`);
});

test('isCacheableSql refuses writes, DDL, AI agents and the auth tables', () => {
  const refused = [
    ...SCHEMA,
    ...SEED,
    ATTRIBUTION,
    SCORECARD,
    `INSERT INTO pm_events (event_id) VALUES ('x')`,
    `UPDATE pm_events SET is_bot = TRUE WHERE event_id IN ('x')`,
    `DELETE FROM pm_campaigns WHERE tenant_id = $1 AND campaign_id = $2`,
    `ALTER TABLE pm_events ADD COLUMN bot_verified TEXT`,
    `DROP TABLE IF EXISTS recipe_pm_attribution`,
    `CREATE INDEX IF NOT EXISTS idx_pm_campaigns_tenant ON pm_campaigns(tenant_id)`,
    `WITH gone AS (DELETE FROM pm_events WHERE tenant_id = $1 RETURNING *) SELECT COUNT(*) FROM gone`,
    `SELECT * FROM pm_events FOR UPDATE`,
    `SELECT 1; DELETE FROM pm_events`,
    `SELECT AGENT_RUN('aidb-assistant', $1, json_object('max_iterations', 2)) AS rec`,
    `SELECT GENERATE('write a poem') AS g`,
    `SELECT id, email, name, password_hash FROM users WHERE email = $1 LIMIT 1`,
    `SELECT tenant_id, role, created_at FROM memberships WHERE user_id = $1 ORDER BY created_at DESC`,
    `SELECT id, name, slug, api_key_prefix FROM tenants WHERE id = $1 LIMIT 1`,
    `SELECT * FROM main.sessions WHERE user_id = $1`,
    `SELECT * FROM "api_keys" WHERE key_hash = $1`,
    `SELECT user_id FROM auth_tokens WHERE token_hash = $1`,
    `SELECT tenant_id, user_id, allowed_origins, disabled_at FROM tracking_pixels WHERE id = $1 LIMIT 1`,
    `SELECT e.* FROM pm_events e JOIN users u ON u.id = e.anonymous_id`,
    `SELECT * FROM pm_events, invitations`,
    `EXPLAIN SELECT 1`,
    `PRAGMA table_info(pm_events)`,
    '',
  ];
  for (const sql of refused) assert.ok(!isCacheableSql(sql), `should be refused: ${sql.slice(0, 70)}`);
});

test('env configuration: defaults, overrides and bad values', () => {
  assert.deepEqual(queryCacheOptionsFromEnv({}), { ...QUERY_CACHE_DEFAULTS });
  assert.deepEqual(
    queryCacheOptionsFromEnv({ QUERY_CACHE_TTL_MS: '45000', QUERY_CACHE_MAX_ENTRIES: '50', QUERY_CACHE_MAX_BYTES: '4194304', QUERY_CACHE_MAX_ENTRY_BYTES: '524288' }),
    { ttlMs: 45_000, maxEntries: 50, maxBytes: 4_194_304, maxEntryBytes: 524_288 },
  );
  const bad = queryCacheOptionsFromEnv({ QUERY_CACHE_TTL_MS: 'soon', QUERY_CACHE_MAX_ENTRIES: '', QUERY_CACHE_MAX_BYTES: '-5' });
  assert.equal(bad.ttlMs, QUERY_CACHE_DEFAULTS.ttlMs);
  assert.equal(bad.maxEntries, QUERY_CACHE_DEFAULTS.maxEntries);
  assert.equal(bad.maxBytes, 1024); // clamped to the floor
  assert.ok(bad.maxEntryBytes <= bad.maxBytes);
  assert.equal(queryCacheOptionsFromEnv({ QUERY_CACHE_TTL_MS: '0' }).ttlMs, 0);
  assert.equal(queryCacheOptionsFromEnv({ QUERY_CACHE_TTL_MS: '99999999' }).ttlMs, 600_000);
});

test('estimateBytes tracks the size of a result roughly like its JSON', () => {
  const r = { columns: ['a', 'b'], rows: Array.from({ length: 100 }, (_, i) => ({ a: `visitor-${i}`, b: i })) };
  const json = JSON.stringify(r).length;
  const est = estimateBytes(r);
  assert.ok(est > json * 0.5 && est < json * 2, `estimate ${est} vs json ${json}`);
});
