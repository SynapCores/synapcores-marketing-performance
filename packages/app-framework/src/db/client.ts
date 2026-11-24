/**
 * SynapCores SDK client.
 *
 * Wire protocol (SynapCores v1.7.0.1-ce):
 *
 *   - Auth: JWT obtained via POST /v1/auth/login (caller passes the
 *     access_token as the Bearer). For framework-internal calls we
 *     hold the token in the admin client and refresh on 401 (TODO
 *     phase 3).
 *
 *   - Non-parameterized statements (DDL, SELECT with literal values):
 *       POST /v1/query/execute { sql }
 *
 *   - Parameterized statements ($1, $2, …):
 *       POST /v1/query/prepare { sql }      → { statement_id }
 *       POST /v1/query/exec    { statement_id, params }
 *       (POST /v1/query/close  { statement_id } — fire-and-forget cleanup)
 *
 *   - Response envelope: { data: { columns, rows, ... }, meta }.
 *     `columns` is an array of `{ name, data_type, nullable }` objects;
 *     `rows` is an array of value-arrays (positional, NOT object-keyed).
 *     This client maps rows into `{ [columnName]: value }` for ergonomics.
 *
 * Errors: non-2xx → `SynapCoresError(status, message, upstream)`. The
 * upstream body keeps the original error shape so callers can branch on
 * `err.upstream.error.code` (`query_error`, `endpoint_not_found`, ...).
 * No HTTP response at all (connection refused / reset / closed, or no answer
 * within the per-request timeout, code ETIMEDOUT) →
 * `SynapCoresUnavailableError(code)`, which carries the digest the error
 * boundaries use to show "Reconnecting…".
 *
 * Engine restarts: a statement whose connection is REFUSED never reached the
 * engine, so `sql()` re-runs it (prepare included) with a short backoff for
 * up to ~12 s, which covers the ~5 s the engine takes to come back. Nothing
 * else is retried: not resets, not timeouts, not HTTP errors (see ./retry.ts).
 */

import {
  CONNECT_RETRY_BUDGET_MS,
  isConnectionRefused,
  markEngineDown,
  newEngineBreaker,
  retryBudgetFor,
  transportErrorCode,
  withConnectRetry,
  type EngineBreaker,
} from './retry';
import { ENGINE_UNAVAILABLE_DIGEST } from './unavailable';

export interface SynapCoresClientOptions {
  /** Base URL — e.g. http://127.0.0.1:28080 */
  baseUrl?: string;
  /** Bearer token (JWT). For admin clients, mint via /v1/auth/login. */
  apiKey: string;
  /** Per-request timeout in ms. Default: 60_000. */
  timeoutMs?: number;
  /** Optional fetch implementation (for tests / Edge runtime). */
  fetchImpl?: typeof fetch;
  /** How long to keep retrying refused connections (ms). Default CONNECT_RETRY_BUDGET_MS (~12 s); tests use less. */
  connectRetryBudgetMs?: number;
  /** Engine reachability state. Default: the one shared by the whole process; tests pass their own. */
  engineBreaker?: EngineBreaker;
}

export interface QueryResult<Row = Record<string, unknown>> {
  columns: string[];
  rows: Row[];
  truncated?: boolean;
  rowCount: number;
  meta?: Record<string, unknown>;
}

export class SynapCoresError extends Error {
  readonly status: number;
  readonly upstream: unknown;

  constructor(status: number, message: string, upstream?: unknown) {
    super(message);
    this.name = 'SynapCoresError';
    this.status = status;
    this.upstream = upstream;
  }
}

/**
 * The engine could not be reached: no HTTP response (connection refused after
 * the retries, reset / closed mid-request, or ETIMEDOUT = nothing within the
 * per-request timeout). `code` is the socket error code. Carries
 * ENGINE_UNAVAILABLE_DIGEST so a Next.js error boundary can tell "engine
 * restarting" apart from other failures.
 */
export class SynapCoresUnavailableError extends Error {
  readonly code: string;
  readonly digest = ENGINE_UNAVAILABLE_DIGEST;

  constructor(message: string, code: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'SynapCoresUnavailableError';
    this.code = code;
  }
}

// Engine reachability, shared by every client and module instance in the process
// (route handlers and server actions are separate module instances).
const BREAKER_KEY = Symbol.for('synapcores.app-framework.engine-breaker');
function sharedBreaker(): EngineBreaker {
  const g = globalThis as unknown as Record<symbol, EngineBreaker | undefined>;
  let b = g[BREAKER_KEY];
  if (!b) {
    b = newEngineBreaker();
    g[BREAKER_KEY] = b;
  }
  return b;
}

// One log line when the engine starts refusing connections, one when requests
// start failing fast, one when it answers again, instead of one per request.
function noteRefused(b: EngineBreaker, budgetMs: number): void {
  if (b.refusedSince) return;
  b.refusedSince = Date.now();
  console.warn(`[synapcores] engine refused the connection (restarting?); retrying for up to ${budgetMs / 1000} s`);
}

function noteReachable(b: EngineBreaker): void {
  b.downUntil = 0;
  if (!b.refusedSince) return;
  console.warn(`[synapcores] engine reachable again after ${((Date.now() - b.refusedSince) / 1000).toFixed(1)} s`);
  b.refusedSince = 0;
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

function isFetchFailed(err: unknown): boolean {
  return err instanceof TypeError && err.message === 'fetch failed';
}

/**
 * A failed request without an HTTP response → SynapCoresUnavailableError:
 * our own timeout (ETIMEDOUT), a socket error code, or undici's "fetch
 * failed". Anything else (e.g. an invalid URL, a bug) is rethrown unchanged so
 * it isn't shown as "engine restarting". `always`: the response had started, so
 * any failure is a broken connection.
 */
function toTransportError(
  err: unknown,
  method: string,
  path: string,
  o: { timedOut: boolean; timeoutMs: number; always?: boolean },
): unknown {
  if (err instanceof SynapCoresUnavailableError) return err;
  if (o.timedOut && isAbortError(err)) {
    return new SynapCoresUnavailableError(
      `SynapCores ${method} ${path}: no response within ${Math.round(o.timeoutMs / 1000)} s (ETIMEDOUT)`,
      'ETIMEDOUT',
      err,
    );
  }
  const code = transportErrorCode(err);
  if (!code && !isFetchFailed(err) && !o.always) return err;
  return new SynapCoresUnavailableError(
    `SynapCores ${method} ${path}: no response (${code ?? 'fetch failed'})`,
    code ?? 'EUNKNOWN',
    err,
  );
}

interface WireColumn {
  name: string;
  data_type: string;
  nullable: boolean;
}

interface WireQueryResult {
  columns: WireColumn[];
  rows: unknown[][];
  rows_affected?: number;
  execution_time_ms?: number;
  truncated?: boolean;
}

interface WirePrepareResult {
  statement_id: string;
  param_count: number;
  sql: string;
  database: string;
}

export class SynapCoresClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly connectRetryBudgetMs: number;
  private readonly breaker: EngineBreaker;

  constructor(opts: SynapCoresClientOptions) {
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:28080').replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.connectRetryBudgetMs = opts.connectRetryBudgetMs ?? CONNECT_RETRY_BUDGET_MS;
    this.breaker = opts.engineBreaker ?? sharedBreaker();
  }

  /**
   * Execute a SQL statement with optional bound parameters.
   * If `params` is non-empty, routes through prepare → exec → close.
   * If empty, hits /v1/query/execute directly.
   */
  async sql<Row = Record<string, unknown>>(
    statement: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<QueryResult<Row>> {
    // The whole unit is re-run on a refused connection: a statement prepared on
    // an engine that has since restarted no longer exists there.
    const b = this.breaker;
    const budgetMs = this.connectRetryBudgetMs;
    try {
      const result = await withConnectRetry(() => this.sqlOnce<Row>(statement, params), {
        budgetMs: retryBudgetFor(b, Date.now(), budgetMs),
        onRetry: () => noteRefused(b, budgetMs),
      });
      noteReachable(b);
      return result;
    } catch (err) {
      if (err instanceof SynapCoresError) {
        noteReachable(b); // the engine answered
      } else if (isConnectionRefused(err)) {
        noteRefused(b, budgetMs);
        if (Date.now() >= b.downUntil) {
          console.warn('[synapcores] engine still refusing connections; requests fail fast until it answers');
        }
        markEngineDown(b, Date.now());
      }
      throw err;
    }
  }

  private async sqlOnce<Row>(
    statement: string,
    params: ReadonlyArray<unknown>,
  ): Promise<QueryResult<Row>> {
    if (params.length === 0) {
      const wire = await this.request<WireQueryResult>('POST', '/v1/query/execute', {
        sql: statement,
      });
      return shapeResult<Row>(wire);
    }

    const prep = await this.request<WirePrepareResult>('POST', '/v1/query/prepare', {
      sql: statement,
    });
    try {
      const wire = await this.request<WireQueryResult>('POST', '/v1/query/exec', {
        statement_id: prep.statement_id,
        params: params as unknown[],
      });
      return shapeResult<Row>(wire);
    } finally {
      // Fire-and-forget close. We don't await it — gateway will GC.
      void this.request('POST', '/v1/query/close', {
        statement_id: prep.statement_id,
      }).catch(() => undefined);
    }
  }

  async sqlScalar<T = unknown>(
    statement: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<T | null> {
    const result = await this.sql<Record<string, T>>(statement, params);
    const firstRow = result.rows[0];
    if (!firstRow) return null;
    const firstColumn = result.columns[0];
    if (!firstColumn) return null;
    return firstRow[firstColumn] ?? null;
  }

  async health(): Promise<{ ok: boolean; version?: string }> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`);
      if (!res.ok) return { ok: false };
      const body = (await res.json()) as { status?: string; version?: string };
      return { ok: body.status === 'ok', version: body.version };
    } catch {
      return { ok: false };
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } catch (err) {
      throw toTransportError(err, method, path, { timedOut: ctl.signal.aborted, timeoutMs: this.timeoutMs });
    } finally {
      clearTimeout(timer);
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      // The connection dropped while the body was streaming: the statement may have run.
      throw toTransportError(err, method, path, { timedOut: false, timeoutMs: this.timeoutMs, always: true });
    }
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const message =
        (parsed as { error?: { message?: string } } | undefined)?.error?.message ??
        `SynapCores ${method} ${path} → ${res.status}`;
      throw new SynapCoresError(res.status, message, parsed);
    }

    // Unwrap the {data, meta} envelope every gateway response uses.
    if (parsed && typeof parsed === 'object' && 'data' in parsed) {
      return (parsed as { data: T }).data;
    }
    return parsed as T;
  }
}

/** Convert the gateway's positional rows into ergonomic objects. */
function shapeResult<Row>(wire: WireQueryResult): QueryResult<Row> {
  const columnNames = wire.columns.map((c) => c.name);
  const rows = wire.rows.map((rowArr) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columnNames.length; i++) {
      obj[columnNames[i]!] = rowArr[i];
    }
    return obj as unknown as Row;
  });
  return {
    columns: columnNames,
    rows,
    truncated: wire.truncated,
    rowCount: wire.rows_affected ?? rows.length,
  };
}
