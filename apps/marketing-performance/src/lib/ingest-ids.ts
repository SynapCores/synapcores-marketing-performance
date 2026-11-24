/**
 * Safe auto-numbering for warehouse ingestion (lib/warehouse.ts ingestRecords).
 *
 * Rows that arrive without a primary key are numbered from MAX(key) + 1. Two
 * writers doing that at the same time (two pixel beacons ingested in parallel)
 * read the same MAX and number their rows the same; the engine then rejects
 * the second multi-row INSERT as a whole ("Batch error: Constraint violation:
 * Duplicate key"), so all of that batch's rows were lost. Fix: writes to a
 * table run one at a time in this process, and an id collision with another
 * writer renumbers from a fresh MAX and tries again (only when every id in the
 * statement is ours and the statement is the whole insert; the engine rejects
 * such a statement as a whole, so the rejected attempt wrote nothing).
 *
 * A queued write whose caller has given up (the beacon request was aborted or
 * is past its deadline) is skipped before it starts, so a pixel re-send can't
 * meet a late copy of the same rows. Plain module: no I/O, unit-tested.
 */

/** A write skipped before it started (the caller went away or its deadline passed): nothing was written. */
export class NotAttemptedError extends Error {
  constructor(reason: string) {
    super(`write skipped: ${reason}`);
    this.name = 'NotAttemptedError';
  }
}

/** Throws NotAttemptedError once `signal` is aborted or `deadline` (epoch ms) has passed. */
export function writeGuard(o: { signal?: AbortSignal; deadline?: number; now?: () => number }): () => void {
  const now = o.now ?? Date.now;
  return () => {
    if (o.signal?.aborted) throw new NotAttemptedError('the request was aborted');
    if (o.deadline !== undefined && now() > o.deadline) throw new NotAttemptedError('deadline passed');
  };
}

/** The engine's duplicate-key / unique-constraint rejection. */
export function isDuplicateKeyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /duplicate key|unique or primary key constraint/i.test(msg);
}

export type KeyedQueue = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/** Calls with the same key run one after another; different keys run concurrently. */
export function createKeyedQueue(): KeyedQueue {
  const tails = new Map<string, Promise<void>>();
  return function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

export interface NumberedInsert<T> {
  /** First id to use (MAX(key) + 1, read fresh on every attempt). */
  nextId: () => Promise<number>;
  /** Number the rows from `startId` and insert them. */
  insert: (startId: number) => Promise<T>;
  /** Every row's id is assigned here and the insert is one statement: a collision can be renumbered. */
  renumberable: boolean;
  /** Total attempts when renumberable (default 3). */
  attempts?: number;
  /** Runs before each engine step; throws (NotAttemptedError) to stop before anything is written. */
  check?: () => void;
  onCollision?: (attempt: number, err: unknown) => void;
}

/** Insert auto-numbered rows, renumbering and retrying when another writer took the ids first. */
export async function insertNumbered<T>(o: NumberedInsert<T>): Promise<T> {
  const attempts = o.renumberable ? Math.max(1, Math.floor(o.attempts ?? 3)) : 1;
  for (let attempt = 1; ; attempt++) {
    o.check?.();
    const startId = await o.nextId();
    o.check?.();
    try {
      return await o.insert(startId);
    } catch (err) {
      if (attempt >= attempts || !isDuplicateKeyError(err)) throw err;
      o.onCollision?.(attempt, err);
    }
  }
}
