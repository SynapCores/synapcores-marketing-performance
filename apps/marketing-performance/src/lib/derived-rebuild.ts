/**
 * The derived-table rebuild (Steps 7 & 10) and the queue that keeps derived-table
 * writers from overlapping. All I/O is passed in by warehouse.ts, so the
 * statement sequences can be unit-tested.
 *
 * Why not DROP + CREATE on every rebuild: SynapCores 2.5.1-ce keeps memory
 * after each DROP TABLE of a table that held rows, and the collector rebuilds
 * every 5 minutes. On prod the engine grew about 20-25 MB per rebuild. In an
 * isolated repro, DROP + CREATE + INSERT kept growing, while DELETE + INSERT
 * gave its memory back once idle.
 *
 * Why still DROP once per process: CREATE TABLE IF NOT EXISTS leaves an
 * existing table alone. A deploy that changes the derived tables' DDL only
 * takes effect once they are dropped, so the first rebuild in each process
 * drops and re-creates them.
 */

/**
 * Filled only by the rebuild and loadSampleData(), recomputed in full each
 * time. clearAll() drops them along with the base tables.
 */
export const DERIVED_TABLES = ['recipe_pm_attribution', 'recipe_pm_campaign_scorecard'] as const;

export type DerivedClearMode = 'drop' | 'delete';

export interface DerivedClearState {
  /** This process has already dropped and re-created the derived tables, so they carry its DDL. */
  recreated: boolean;
  /** A DELETE failed earlier in this run, e.g. because a table is missing. */
  deleteFailed?: boolean;
}

/** DROP + re-create on the first rebuild in a process and after a failed DELETE; DELETE otherwise. */
export function derivedClearMode({ recreated, deleteFailed = false }: DerivedClearState): DerivedClearMode {
  return recreated && !deleteFailed ? 'delete' : 'drop';
}

/** The statements that empty the derived tables in `mode`, attribution first. */
export function derivedClearStatements(mode: DerivedClearMode): string[] {
  return DERIVED_TABLES.map((t) => (mode === 'drop' ? `DROP TABLE IF EXISTS ${t}` : `DELETE FROM ${t}`));
}

export interface RebuildDeps {
  /** Run one statement. */
  run(sql: string): Promise<unknown>;
  /** CREATE TABLE IF NOT EXISTS for every warehouse table, cached until schemaChanged(). */
  ensureSchema(): Promise<void>;
  /** Forget the ensureSchema() cache, so the next call runs the DDL again. */
  schemaChanged(): void;
  invalidateReports(): void;
  warn(message: string): void;
  /** The INSERT ... SELECT statements that fill the derived tables (recipe-sql.ts). */
  attribution: string;
  scorecard: string;
}

/**
 * Empty the derived tables (DROP + re-create, or DELETE; see derivedClearMode),
 * then refill them. `state.recreated` is set once a DROP + re-create succeeded.
 * Reports are invalidated whatever happens.
 */
export async function rebuildDerivedWith(state: { recreated: boolean }, deps: RebuildDeps): Promise<void> {
  try {
    let mode = derivedClearMode({ recreated: state.recreated });
    if (mode === 'delete') {
      await deps.ensureSchema();
      try {
        for (const sql of derivedClearStatements('delete')) await deps.run(sql);
      } catch (e) {
        mode = derivedClearMode({ recreated: state.recreated, deleteFailed: true });
        deps.warn(`[warehouse] emptying the derived tables failed, rebuilding them by DROP: ${(e as Error).message}`);
      }
    }
    if (mode === 'drop') {
      try {
        for (const sql of derivedClearStatements('drop')) await deps.run(sql);
      } finally {
        deps.schemaChanged();
      }
      await deps.ensureSchema();
      state.recreated = true;
    }
    try {
      await deps.run(deps.attribution);
      await deps.run(deps.scorecard);
    } catch (e) {
      // e.g. a base table was dropped outside the app: the next run's ensureSchema() re-creates it
      deps.schemaChanged();
      throw e;
    }
  } finally {
    deps.invalidateReports();
  }
}

export interface WriterQueue {
  tail: Promise<unknown>;
  /** A runShared() run that is queued and has not started yet. */
  pending: Promise<void> | null;
}

/**
 * Run `task` once every task queued before it has settled, so two writers
 * never interleave their statements. A failed task rejects only its own
 * caller, and the queue carries on (callers must handle the rejection).
 * A task must not wait for another task on the same queue: that never settles.
 */
export function runExclusive<T>(queue: WriterQueue, task: () => Promise<T>): Promise<T> {
  queue.pending = null; // a shared run queued before this task must not absorb later callers
  const result = queue.tail.then(() => task(), () => task());
  queue.tail = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * runExclusive for a task that recomputes everything (the rebuild): callers that
 * arrive while such a run is queued and not yet started share it. It starts
 * after their call, so it sees everything they wrote before calling.
 */
export function runShared(queue: WriterQueue, task: () => Promise<void>): Promise<void> {
  if (queue.pending) return queue.pending;
  const run: Promise<void> = runExclusive(queue, () => {
    if (queue.pending === run) queue.pending = null; // started: later callers queue a new run
    return task();
  });
  queue.pending = run; // set before the task can start: queued tasks never start synchronously
  return run;
}
