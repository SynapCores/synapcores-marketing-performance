import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DERIVED_TABLES,
  derivedClearMode,
  derivedClearStatements,
  rebuildDerivedWith,
  runExclusive,
  runShared,
  type RebuildDeps,
  type WriterQueue,
} from '../src/lib/derived-rebuild';
import { ATTRIBUTION, SCHEMA, SCORECARD, TABLES } from '../src/lib/recipe-sql';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const queue = (): WriterQueue => ({ tail: Promise.resolve(), pending: null });

/** Short labels for the statements a rebuild runs. */
function label(sql: string): string {
  if (sql === ATTRIBUTION) return 'ATTRIBUTION';
  if (sql === SCORECARD) return 'SCORECARD';
  const m = /^\s*(DROP TABLE IF EXISTS|CREATE TABLE IF NOT EXISTS|DELETE FROM) recipe_pm_(\w+)/.exec(sql);
  if (!m) return sql.trim().slice(0, 30);
  return `${m[1]!.split(' ')[0]} ${m[2]}`;
}

/**
 * A stand-in for warehouse.ts: records statements, caches the schema like
 * ensureSchema() (until schemaChanged() or a failed CREATE) and fails the
 * statements matching `failOnce`, once each.
 */
function fakeWarehouse() {
  const log: string[] = [];
  const failOnce: RegExp[] = [];
  let schemaReady = false;
  const state = { recreated: false };
  const deps: RebuildDeps = {
    async run(sql) {
      log.push(label(sql));
      await sleep(1);
      const i = failOnce.findIndex((re) => re.test(sql));
      if (i >= 0) {
        failOnce.splice(i, 1);
        log.push(`!${label(sql)}`);
        throw new Error(`${label(sql)} failed`);
      }
    },
    async ensureSchema() {
      if (schemaReady) return;
      for (const ddl of SCHEMA) await deps.run(ddl);
      schemaReady = true;
    },
    schemaChanged() { schemaReady = false; },
    invalidateReports() { log.push('INVALIDATE'); },
    warn() { log.push('WARN'); },
    attribution: ATTRIBUTION,
    scorecard: SCORECARD,
  };
  /** Run one rebuild; returns its statements (and error message, if it failed). */
  const rebuild = async () => {
    const start = log.length;
    let error: string | null = null;
    try { await rebuildDerivedWith(state, deps); } catch (e) { error = (e as Error).message; }
    return { stmts: log.slice(start), error };
  };
  return { log, failOnce, state, deps, rebuild };
}

const CREATE_ALL = ['ad_spend', 'creative', 'click_events', 'identity', 'conversions', 'orders', 'attribution', 'campaign_scorecard'].map((t) => `CREATE ${t}`);
const DROP_PATH = ['DROP attribution', 'DROP campaign_scorecard', ...CREATE_ALL, 'ATTRIBUTION', 'SCORECARD', 'INVALIDATE'];
const DELETE_PATH = ['DELETE attribution', 'DELETE campaign_scorecard', 'ATTRIBUTION', 'SCORECARD', 'INVALIDATE'];

test('derivedClearMode: the first rebuild in a process drops; later rebuilds delete', () => {
  assert.equal(derivedClearMode({ recreated: false }), 'drop');
  assert.equal(derivedClearMode({ recreated: true }), 'delete');
  assert.equal(derivedClearMode({ recreated: true, deleteFailed: false }), 'delete');
});

test('derivedClearMode: a failed DELETE falls back to drop for that run', () => {
  assert.equal(derivedClearMode({ recreated: true, deleteFailed: true }), 'drop');
  assert.equal(derivedClearMode({ recreated: false, deleteFailed: true }), 'drop');
});

test('clear statements: whole-table DROP or DELETE, attribution first', () => {
  assert.deepEqual(derivedClearStatements('drop'), [
    'DROP TABLE IF EXISTS recipe_pm_attribution',
    'DROP TABLE IF EXISTS recipe_pm_campaign_scorecard',
  ]);
  assert.deepEqual(derivedClearStatements('delete'), [
    'DELETE FROM recipe_pm_attribution',
    'DELETE FROM recipe_pm_campaign_scorecard',
  ]);
});

test('the derived tables are the ones ATTRIBUTION and SCORECARD fill, and the schema creates both', () => {
  assert.match(ATTRIBUTION, /^\s*INSERT INTO recipe_pm_attribution \(/);
  assert.match(SCORECARD, /^\s*INSERT INTO recipe_pm_campaign_scorecard \(/);
  for (const t of DERIVED_TABLES) {
    assert.ok(TABLES.includes(t), `${t} is a warehouse table`);
    assert.ok(SCHEMA.some((ddl) => ddl.startsWith(`CREATE TABLE IF NOT EXISTS ${t} (`)), `${t} has a CREATE in SCHEMA`);
  }
});

test('rebuild: the first run drops and re-creates, later runs only DELETE + INSERT', async () => {
  const w = fakeWarehouse();
  assert.deepEqual(await w.rebuild(), { stmts: DROP_PATH, error: null });
  assert.equal(w.state.recreated, true);
  assert.deepEqual(await w.rebuild(), { stmts: DELETE_PATH, error: null });
  assert.deepEqual(await w.rebuild(), { stmts: DELETE_PATH, error: null });
});

test('rebuild: a failed DELETE takes the DROP path for that run, then DELETE again', async () => {
  for (const failing of [/^DELETE FROM recipe_pm_attribution$/, /^DELETE FROM recipe_pm_campaign_scorecard$/]) {
    const w = fakeWarehouse();
    await w.rebuild();
    w.failOnce.push(failing);
    const failed = failing.source.includes('attribution')
      ? ['DELETE attribution', '!DELETE attribution']
      : ['DELETE attribution', 'DELETE campaign_scorecard', '!DELETE campaign_scorecard'];
    assert.deepEqual(await w.rebuild(), { stmts: [...failed, 'WARN', ...DROP_PATH], error: null });
    assert.deepEqual(await w.rebuild(), { stmts: DELETE_PATH, error: null });
  }
});

test('rebuild: a failed first DROP rejects and the next run is still a first run', async () => {
  const w = fakeWarehouse();
  w.failOnce.push(/^DROP TABLE IF EXISTS recipe_pm_attribution$/);
  assert.deepEqual(await w.rebuild(), { stmts: ['DROP attribution', '!DROP attribution', 'INVALIDATE'], error: 'DROP attribution failed' });
  assert.equal(w.state.recreated, false);
  assert.deepEqual(await w.rebuild(), { stmts: DROP_PATH, error: null });
  assert.deepEqual(await w.rebuild(), { stmts: DELETE_PATH, error: null });
});

test('rebuild: a failed INSERT rejects, keeps DELETE mode and re-runs the schema DDL next time', async () => {
  const w = fakeWarehouse();
  await w.rebuild();
  w.failOnce.push(/^\s*INSERT INTO recipe_pm_campaign_scorecard /);
  assert.deepEqual(await w.rebuild(), {
    stmts: ['DELETE attribution', 'DELETE campaign_scorecard', 'ATTRIBUTION', 'SCORECARD', '!SCORECARD', 'INVALIDATE'],
    error: 'SCORECARD failed',
  });
  // a base table dropped outside the app would be re-created here, and no populated table is dropped
  assert.deepEqual(await w.rebuild(), { stmts: [...CREATE_ALL, ...DELETE_PATH], error: null });
});

test('rebuild: if the schema DDL fails on the DELETE path, the run rejects before touching the derived tables', async () => {
  const w = fakeWarehouse();
  await w.rebuild();
  w.deps.schemaChanged(); // e.g. clearAll() ran
  w.failOnce.push(/^CREATE TABLE IF NOT EXISTS recipe_pm_ad_spend /);
  assert.deepEqual(await w.rebuild(), { stmts: ['CREATE ad_spend', '!CREATE ad_spend', 'INVALIDATE'], error: 'CREATE ad_spend failed' });
  assert.deepEqual(await w.rebuild(), { stmts: [...CREATE_ALL, ...DELETE_PATH], error: null });
});

test('runExclusive runs queued tasks one at a time, in order', async () => {
  const q = queue();
  const log: string[] = [];
  const task = (name: string, ms: number) => async () => {
    log.push(`${name}:start`);
    await sleep(ms);
    log.push(`${name}:end`);
    return name;
  };
  const results = await Promise.all([runExclusive(q, task('a', 20)), runExclusive(q, task('b', 1)), runExclusive(q, task('c', 5))]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
});

test('runExclusive: a failed task rejects only its own caller and the queue carries on', async () => {
  const q = queue();
  const failed = runExclusive(q, async () => {
    await sleep(5);
    throw new Error('boom');
  });
  const next = runExclusive(q, async () => 'ok');
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'ok');
  const syncThrow = runExclusive(q, () => {
    throw new Error('sync');
  });
  await assert.rejects(syncThrow, /sync/);
  assert.equal(await runExclusive(q, async () => 42), 42);
});

test('runShared: callers share a queued run that has not started; a started run is never joined', async () => {
  const q = queue();
  const starts: number[] = [];
  let n = 0;
  const task = async () => {
    starts.push(++n);
    await sleep(10);
  };
  const first = runShared(q, task);
  await sleep(2); // `first` has started
  const second = runShared(q, task);
  const third = runShared(q, task);
  assert.notEqual(second, first);
  assert.equal(third, second);
  await Promise.all([first, second, third]);
  assert.deepEqual(starts, [1, 2]);
  await runShared(q, task); // idle again: a new run
  assert.deepEqual(starts, [1, 2, 3]);
});

test('runShared: a task queued with runExclusive in between is not jumped', async () => {
  const q = queue();
  const log: string[] = [];
  const step = (name: string) => async () => {
    log.push(name);
    await sleep(2);
  };
  const r1 = runShared(q, step('rebuild-1'));
  const clear = runExclusive(q, step('clear'));
  const r2 = runShared(q, step('rebuild-2'));
  assert.notEqual(r2, r1);
  await Promise.all([r1, clear, r2]);
  assert.deepEqual(log, ['rebuild-1', 'clear', 'rebuild-2']);
});

test('overlapping rebuilds never interleave their statements', async () => {
  const w = fakeWarehouse();
  const q = queue();
  const go = () => runShared(q, () => rebuildDerivedWith(w.state, w.deps));
  const a = go();
  await sleep(3); // a is running
  const b = go(); // queued behind a
  w.failOnce.push(/^\s*INSERT INTO recipe_pm_attribution /);
  const results = await Promise.allSettled([a, b]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'fulfilled']);
  assert.deepEqual(w.log, [
    ...DROP_PATH.slice(0, -3), 'ATTRIBUTION', '!ATTRIBUTION', 'INVALIDATE',
    ...CREATE_ALL, ...DELETE_PATH,
  ]);
});
