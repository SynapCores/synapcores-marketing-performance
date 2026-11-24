import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedQueue, insertNumbered, isDuplicateKeyError } from '../src/lib/ingest-ids';

// The engine's message in prod (mktperf-app journal, 68× in 48 h before the fix).
const PROD_DUPLICATE =
  "Query operation error: Batch error: Constraint violation: Duplicate key: row violates a UNIQUE or PRIMARY KEY constraint on table 'recipe_pm_click_events'";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

/** A table like the engine's: MAX is a separate round trip, and a multi-row INSERT with any taken id is rejected as a whole. */
function fakeTable() {
  const rows = new Map<number, string>();
  return {
    rows,
    async max(): Promise<number> {
      await tick();
      return rows.size ? Math.max(...rows.keys()) : 0;
    },
    async insert(batch: Array<[number, string]>): Promise<number> {
      await tick();
      if (batch.some(([id]) => rows.has(id))) throw new Error(PROD_DUPLICATE);
      for (const [id, v] of batch) rows.set(id, v);
      return batch.length;
    },
  };
}

const numbered = (records: string[], start: number): Array<[number, string]> => records.map((v, i) => [start + i, v]);

test('isDuplicateKeyError: the engine duplicate-key rejection, nothing else', () => {
  assert.equal(isDuplicateKeyError(new Error(PROD_DUPLICATE)), true);
  assert.equal(isDuplicateKeyError(new Error('Constraint violation: duplicate key value')), true);
  assert.equal(isDuplicateKeyError(new Error('SQL concurrency or queue capacity is exhausted; retry later')), false);
  assert.equal(isDuplicateKeyError(new TypeError('fetch failed')), false);
  assert.equal(isDuplicateKeyError(new Error('Query operation error: table not found')), false);
  assert.equal(isDuplicateKeyError(undefined), false);
});

test('concurrent beacons: numbering from the same MAX loses whole batches; the per-table queue does not', async () => {
  const beacons = Array.from({ length: 6 }, (_, b) => [`b${b}-1`, `b${b}-2`]);

  // Before: each request reads MAX and inserts on its own (prod behaviour).
  const before = fakeTable();
  const results = await Promise.allSettled(
    beacons.map((recs) =>
      insertNumbered({
        nextId: async () => (await before.max()) + 1,
        insert: (start) => before.insert(numbered(recs, start)),
        renumberable: false,
      }),
    ),
  );
  const lost = results.filter((r) => r.status === 'rejected');
  assert.ok(lost.length > 0, 'the race reproduces: some batches are rejected');
  assert.ok(lost.every((r) => r.status === 'rejected' && isDuplicateKeyError(r.reason)));
  assert.equal(before.rows.size, (beacons.length - lost.length) * 2, 'a rejected batch wrote none of its rows');

  // After: one writer per table.
  const after = fakeTable();
  const queue = createKeyedQueue();
  const written = await Promise.all(
    beacons.map((recs) =>
      queue('recipe_pm_click_events', () =>
        insertNumbered({
          nextId: async () => (await after.max()) + 1,
          insert: (start) => after.insert(numbered(recs, start)),
          renumberable: true,
        }),
      ),
    ),
  );
  assert.deepEqual(written, beacons.map(() => 2));
  assert.equal(after.rows.size, 12);
  assert.deepEqual([...after.rows.keys()].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual(new Set(after.rows.values()), new Set(beacons.flat()), 'every event stored once');
});

test('insertNumbered: a collision with another writer is renumbered from a fresh MAX', async () => {
  const table = fakeTable();
  table.rows.set(1, 'other-writer');
  let maxReads = 0;
  const collisions: number[] = [];
  const n = await insertNumbered({
    nextId: async () => {
      maxReads += 1;
      if (maxReads === 1) return 1; // stale MAX: id 1 was just taken by someone else
      return (await table.max()) + 1;
    },
    insert: (start) => table.insert(numbered(['a', 'b'], start)),
    renumberable: true,
    onCollision: (attempt) => collisions.push(attempt),
  });
  assert.equal(n, 2);
  assert.equal(maxReads, 2);
  assert.deepEqual(collisions, [1]);
  assert.deepEqual([...table.rows.entries()].sort(), [[1, 'other-writer'], [2, 'a'], [3, 'b']]);
});

test('insertNumbered: explicit keys / multi-statement loads, other errors and repeated collisions are not retried forever', async () => {
  let attempts = 0;
  await assert.rejects(
    insertNumbered({
      nextId: async () => 1,
      insert: async () => {
        attempts += 1;
        throw new Error(PROD_DUPLICATE);
      },
      renumberable: false,
    }),
    (err: unknown) => isDuplicateKeyError(err),
  );
  assert.equal(attempts, 1, 'caller-supplied ids: a duplicate is a real duplicate');

  attempts = 0;
  await assert.rejects(
    insertNumbered({
      nextId: async () => 1,
      insert: async () => {
        attempts += 1;
        throw new Error('SQL concurrency or queue capacity is exhausted; retry later');
      },
      renumberable: true,
    }),
  );
  assert.equal(attempts, 1, 'only id collisions are renumbered');

  attempts = 0;
  await assert.rejects(
    insertNumbered({
      nextId: async () => 1,
      insert: async () => {
        attempts += 1;
        throw new Error(PROD_DUPLICATE);
      },
      renumberable: true,
      attempts: 3,
    }),
  );
  assert.equal(attempts, 3);
});

test('createKeyedQueue: same key runs one at a time, other keys concurrently, failures do not block the queue', async () => {
  const queue = createKeyedQueue();
  let running = 0;
  let peak = 0;
  const job = (ms: number, fail = false) => async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, ms));
    running -= 1;
    if (fail) throw new Error('boom');
    return ms;
  };
  const same = await Promise.allSettled([queue('t', job(5)), queue('t', job(5, true)), queue('t', job(5))]);
  assert.equal(peak, 1);
  assert.deepEqual(same.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);

  peak = 0;
  await Promise.all([queue('a', job(10)), queue('b', job(10))]);
  assert.equal(peak, 2, 'different tables are not serialized');
});

test('writeGuard + insertNumbered: a queued write whose caller gave up is skipped before anything is written', async () => {
  const { writeGuard, NotAttemptedError } = await import('../src/lib/ingest-ids');
  let t = 1_000;
  const steps: string[] = [];

  // Deadline passes while the item waits for MAX: the INSERT never starts.
  await assert.rejects(
    insertNumbered({
      check: writeGuard({ deadline: 1_500, now: () => t }),
      nextId: async () => {
        steps.push('max');
        t = 2_000;
        return 1;
      },
      insert: async () => {
        steps.push('insert');
        return 1;
      },
      renumberable: true,
    }),
    (err: unknown) => err instanceof NotAttemptedError && /deadline passed/.test((err as Error).message),
  );
  assert.deepEqual(steps, ['max']);

  // Client already gone: not even the MAX read.
  const ctl = new AbortController();
  ctl.abort();
  steps.length = 0;
  await assert.rejects(
    insertNumbered({
      check: writeGuard({ signal: ctl.signal }),
      nextId: async () => {
        steps.push('max');
        return 1;
      },
      insert: async () => {
        steps.push('insert');
        return 1;
      },
      renumberable: true,
    }),
    (err: unknown) => err instanceof NotAttemptedError,
  );
  assert.deepEqual(steps, []);

  // In time: runs normally.
  assert.equal(
    await insertNumbered({ check: writeGuard({ deadline: Date.now() + 60_000 }), nextId: async () => 7, insert: async (s) => s, renumberable: false }),
    7,
  );
});
