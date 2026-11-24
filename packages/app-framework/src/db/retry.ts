/**
 * Engine-restart resilience for the SynapCores client: which transport
 * failures may be retried, and how long to keep trying.
 *
 * The engine is restarted a few times a day (a watchdog bounds its memory)
 * and refuses connections for ~5 s while it comes back. A request whose
 * connection was REFUSED never reached the engine, so sending it again cannot
 * run a statement twice. That is the only failure retried here. A connection
 * reset or closed mid-request, a timeout, or any HTTP error response may
 * already have run the statement on the engine, so it is never retried (a
 * write must not apply twice).
 *
 * Once one request has waited out the whole budget, the engine is "known
 * down" for a few seconds (EngineBreaker): later requests try once instead of
 * waiting again, so statements run one after another don't each wait ~12 s
 * during a longer outage. Any answer from the engine clears it.
 *
 * Use withConnectRetry around exactly one request unit (one statement's
 * prepare + exec), never around several statements: a later statement giving
 * up would re-run the earlier ones. That is why none of this is exported from
 * the package barrels.
 *
 * No I/O besides the injected sleep/clock, so the policy is unit-tested
 * directly (packages/app-framework/tests/engine-retry.test.ts).
 */

/** Stop retrying refused connections after this long (the restart gap is ~5 s). */
export const CONNECT_RETRY_BUDGET_MS = 12_000;

/** Wait before retry n (1-based); the last value repeats until the budget is spent. */
export const CONNECT_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500, 1_000, 1_500];

/** Each wait is scaled by a random factor in [1 - JITTER, 1 + JITTER] so waiting requests don't return in lockstep. */
export const CONNECT_RETRY_JITTER = 0.2;

const MAX_CAUSE_DEPTH = 6;

/**
 * True when `err` is a refused TCP connect (nothing listening on the port).
 * Looks through `cause` chains (undici's `TypeError: fetch failed` keeps the
 * socket error in `cause`) and requires every attempt of an AggregateError
 * (several addresses tried) to have been refused.
 */
export function isConnectionRefused(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > MAX_CAUSE_DEPTH) return false;
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    return e.errors.every((inner) => isConnectionRefused(inner, depth + 1));
  }
  if (e.code === 'ECONNREFUSED') return true;
  return isConnectionRefused(e.cause, depth + 1);
}

/** The first string `code` in `err`'s cause chain (ECONNREFUSED, ECONNRESET, UND_ERR_SOCKET, ...). */
export function transportErrorCode(err: unknown, depth = 0): string | undefined {
  if (!err || typeof err !== 'object' || depth > MAX_CAUSE_DEPTH) return undefined;
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e.code === 'string' && e.code) return e.code;
  return transportErrorCode(e.cause, depth + 1);
}

/**
 * Wait (ms) before re-sending after attempt `attempt` (1-based) failed with
 * `err`, `elapsedMs` after the first attempt started; null = give up and
 * rethrow. Only refused connections are retried, and only while the next
 * attempt still starts within the budget. `random` is in [0, 1).
 */
export function connectRetryDelay(
  err: unknown,
  attempt: number,
  elapsedMs: number,
  budgetMs: number = CONNECT_RETRY_BUDGET_MS,
  random: () => number = Math.random,
): number | null {
  if (!isConnectionRefused(err)) return null;
  const i = Math.min(Math.max(1, Math.floor(attempt)) - 1, CONNECT_RETRY_DELAYS_MS.length - 1);
  const base = CONNECT_RETRY_DELAYS_MS[i]!;
  const r = Math.min(Math.max(random(), 0), 1);
  const delay = Math.round(base * (1 - CONNECT_RETRY_JITTER + 2 * CONNECT_RETRY_JITTER * r));
  return elapsedMs + delay <= budgetMs ? delay : null;
}

/** After a request gave up on refusals, later requests make a single attempt for this long. */
export const ENGINE_DOWN_HOLD_MS = 5_000;

/** Process-wide engine reachability, shared by every client (see the file comment). */
export interface EngineBreaker {
  /** Until when (epoch ms) requests make a single attempt instead of backing off. */
  downUntil: number;
  /** When the engine started refusing (epoch ms); 0 = reachable. Drives the one-line logs. */
  refusedSince: number;
}

export function newEngineBreaker(): EngineBreaker {
  return { downUntil: 0, refusedSince: 0 };
}

/** Retry budget for a request starting at `now`: none while the engine is known down. */
export function retryBudgetFor(b: EngineBreaker, now: number, budgetMs: number = CONNECT_RETRY_BUDGET_MS): number {
  return now < b.downUntil ? 0 : budgetMs;
}

/** A request gave up on refused connections: treat the engine as down for `holdMs`. */
export function markEngineDown(b: EngineBreaker, now: number, holdMs: number = ENGINE_DOWN_HOLD_MS): void {
  b.downUntil = now + holdMs;
}

export interface ConnectRetryOptions {
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Called before each wait (attempt = the attempt that just failed). */
  onRetry?: (info: { attempt: number; delayMs: number; elapsedMs: number }) => void;
}

/**
 * Run `fn`; while it fails with a refused connection, wait and run it again,
 * until it succeeds, fails any other way, or the budget is spent (then the
 * last error is rethrown). `fn` must be a complete unit that is safe to start
 * over, e.g. prepare + exec (a statement prepared on the engine that went away
 * is gone, so the retry prepares it again).
 */
export async function withConnectRetry<T>(fn: () => Promise<T>, opts: ConnectRetryOptions = {}): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const elapsedMs = now() - started;
      const delayMs = connectRetryDelay(err, attempt, elapsedMs, opts.budgetMs, opts.random);
      if (delayMs === null) throw err;
      opts.onRetry?.({ attempt, delayMs, elapsedMs });
      await sleep(delayMs);
    }
  }
}
