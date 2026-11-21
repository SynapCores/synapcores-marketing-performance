/**
 * Short-lived, in-process read cache for report queries: LRU + TTL + byte cap.
 *
 * Why: every report render runs several heavy GROUP BY / window-function
 * statements against the single SynapCores instance, and the same statements
 * repeat within seconds (back/forward, re-sorts, two tabs, QA runs, a burst of
 * renders after a deploy). One app instance runs on a 2 GB box, so this lives
 * in the Node process (no Redis).
 *
 * Rules:
 * - Callers opt in per statement. Only the report readers in event-store.ts and
 *   warehouse.ts use it, via reportDb(tenantId) in report-db.ts. Auth, session,
 *   token, pixel-key and write statements never go through it.
 * - As a second guard, isCacheableSql() only admits plain SELECT / WITH reads.
 *   It refuses anything that writes, calls an AI agent/generator, or touches the
 *   auth tables, even if a caller routes it here by mistake.
 * - Keys are scope (tenant) + SQL + bound params, so tenants never share an entry.
 * - Concurrent identical reads share one in-flight engine query (single flight).
 *   Errors are never cached.
 * - Writes clear their tenant (or everything for the shared warehouse tables);
 *   see invalidateReports() in report-db.ts.
 * - Every caller gets its own copy of the rows array, so sorting a result can't
 *   reorder the cached one.
 *
 * Env: QUERY_CACHE_TTL_MS (default 30000; 0 turns the cache off),
 * QUERY_CACHE_MAX_ENTRIES (default 200), QUERY_CACHE_MAX_BYTES (default 16 MiB),
 * QUERY_CACHE_MAX_ENTRY_BYTES (default 2 MiB). Bytes are the estimated size of
 * the result as data (about its JSON size); heap use is a small multiple of that.
 */

export interface QueryCacheOptions {
  /** Entry lifetime in ms, counted from when the result arrived. 0 or less disables the cache. */
  ttlMs: number;
  /** Most entries kept; the least recently used go first. */
  maxEntries: number;
  /** Cap on the summed estimated size of cached results. */
  maxBytes: number;
  /** Results estimated larger than this are returned but not kept. Default: maxBytes / 8. */
  maxEntryBytes?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export interface QueryCacheStats {
  hits: number;
  misses: number;
  /** Calls that skipped the cache (disabled, no scope, or not a cacheable read). */
  bypassed: number;
  evictions: number;
  /** Results not kept because they were larger than maxEntryBytes. */
  tooLarge: number;
  invalidations: number;
  entries: number;
  bytes: number;
}

interface Entry {
  scope: string;
  /** Infinity while the query is in flight. */
  expiresAt: number;
  bytes: number;
  promise: Promise<unknown>;
}

export const QUERY_CACHE_DEFAULTS = {
  ttlMs: 30_000,
  maxEntries: 200,
  maxBytes: 16 * 1024 * 1024,
  maxEntryBytes: 2 * 1024 * 1024,
} as const;

export class QueryCache {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
  private readonly now: () => number;
  private readonly map = new Map<string, Entry>();
  private bytes = 0;
  private readonly counters = { hits: 0, misses: 0, bypassed: 0, evictions: 0, tooLarge: 0, invalidations: 0 };

  constructor(opts: QueryCacheOptions) {
    this.ttlMs = Math.max(0, Math.floor(opts.ttlMs));
    this.maxEntries = Math.max(1, Math.floor(opts.maxEntries));
    this.maxBytes = Math.max(1, Math.floor(opts.maxBytes));
    this.maxEntryBytes = Math.min(this.maxBytes, Math.max(1, Math.floor(opts.maxEntryBytes ?? this.maxBytes / 8)));
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  /**
   * Return the cached result for (scope, sql, params), or run `load` and keep
   * its result for ttlMs. Statements that aren't plain reads, an empty scope or
   * a disabled cache go straight to `load`. `copy` gives each caller its own
   * copy of the shared value.
   */
  run<T>(
    scope: string,
    sql: string,
    params: ReadonlyArray<unknown>,
    load: () => Promise<T>,
    copy: (value: T) => T = (v) => v,
  ): Promise<T> {
    if (!this.enabled || !scope || !isCacheableSql(sql)) {
      this.counters.bypassed++;
      return load();
    }
    const key = cacheKey(scope, sql, params);
    const now = this.now();
    const hit = this.map.get(key);
    if (hit && hit.expiresAt > now) {
      this.map.delete(key); // move to the most-recently-used end
      this.map.set(key, hit);
      this.counters.hits++;
      return (hit.promise as Promise<T>).then(copy);
    }
    if (hit) this.drop(key, hit);
    this.counters.misses++;

    const entry: Entry = { scope, expiresAt: Number.POSITIVE_INFINITY, bytes: 0, promise: Promise.resolve() };
    const promise = load().then(
      (value) => {
        this.settle(key, entry, value);
        return value;
      },
      (err: unknown) => {
        if (this.map.get(key) === entry) this.drop(key, entry);
        throw err;
      },
    );
    entry.promise = promise;
    this.map.set(key, entry);
    this.prune();
    return promise.then(copy);
  }

  /** Forget one scope's entries (a tenant), or everything when no scope is given. */
  invalidate(scope?: string): void {
    this.counters.invalidations++;
    if (scope === undefined) {
      this.map.clear();
      this.bytes = 0;
      return;
    }
    for (const [key, e] of this.map) if (e.scope === scope) this.drop(key, e);
  }

  stats(): QueryCacheStats {
    return { ...this.counters, entries: this.map.size, bytes: this.bytes };
  }

  private settle(key: string, entry: Entry, value: unknown): void {
    // Invalidated or evicted while in flight: hand the result to the callers
    // that were waiting, but don't keep it.
    if (this.map.get(key) !== entry) return;
    const bytes = estimateBytes(value);
    if (bytes > this.maxEntryBytes) {
      this.counters.tooLarge++;
      this.drop(key, entry);
      return;
    }
    entry.bytes = bytes;
    entry.expiresAt = this.now() + this.ttlMs;
    this.bytes += bytes;
    this.prune();
  }

  private drop(key: string, entry: Entry): void {
    if (this.map.get(key) !== entry) return;
    this.map.delete(key);
    this.bytes -= entry.bytes;
  }

  /** Drop expired entries, then the least recently used ones over the caps. */
  private prune(): void {
    const now = this.now();
    for (const [key, e] of this.map) if (e.expiresAt <= now) this.drop(key, e);
    for (const [key, e] of this.map) {
      if (this.map.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      this.drop(key, e);
      this.counters.evictions++;
    }
  }
}

export function cacheKey(scope: string, sql: string, params: ReadonlyArray<unknown>): string {
  return JSON.stringify([scope, sql, params]);
}

// ── what may be cached ──────────────────────────────────────────────────────
const READ_START = /^(?:select|with)\b/i;
/** Statement words that write or change state. */
const WRITE_WORDS =
  /\b(?:insert|update|delete|merge|upsert|replace|create|alter|drop|truncate|rename|grant|revoke|vacuum|analyze|attach|detach|copy|call|exec|execute|set|begin|commit|rollback|savepoint|release|lock|refresh|reindex|pragma|into)\b/i;
/** Non-deterministic or side-effecting functions (EMBED and COSINE_SIMILARITY are deterministic and allowed). */
const VOLATILE_FUNCS =
  /\b(?:agent_run|agent_\w+|generate\w*|chat\w*|ask|decide\w*|llm\w*|complete|completion|summari[sz]e|translate|nextval|setval|random|uuid\w*|gen_random_uuid|sleep|pg_sleep)\s*\(/i;
/**
 * A FROM / JOIN / comma-list reference to a table holding credentials,
 * sessions, memberships or audit records (optionally schema-qualified or
 * quoted). Column aliases such as `AS sessions` don't match.
 */
const SENSITIVE_TABLE_REF =
  /(?:\bfrom|\bjoin|,)\s*(?:"?\w+"?\s*\.\s*)?"?(?:users|sessions|memberships|tenants|api_keys|mcp_tokens|invitations|auth_tokens|framework_audit_log|tracking_pixels)"?(?!\w)/i;

/** Remove comments and the contents of string literals / quoted identifiers before matching words. */
function stripSqlNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .trim();
}

/**
 * True only for a plain read: starts with SELECT or WITH, contains no
 * write/DDL/transaction keyword, calls no agent/generator/random function and
 * reads no auth table. Anything else is run uncached.
 */
export function isCacheableSql(sql: string): boolean {
  if (typeof sql !== 'string') return false;
  const s = stripSqlNoise(sql);
  if (!READ_START.test(s)) return false;
  if (s.includes(';')) return false; // one statement only
  if (WRITE_WORDS.test(s)) return false;
  if (VOLATILE_FUNCS.test(s)) return false;
  if (SENSITIVE_TABLE_REF.test(s)) return false;
  return true;
}

// ── sizing ──────────────────────────────────────────────────────────────────
/** Rough size of a value as data (≈ its JSON byte length). Cheap; no stringify. */
export function estimateBytes(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 4;
  switch (typeof value) {
    case 'string':
      return value.length + 2;
    case 'number':
    case 'bigint':
      return 8;
    case 'boolean':
      return 5;
    case 'object': {
      if (depth > 6) return 64;
      let n = 2;
      if (Array.isArray(value)) {
        for (const v of value) n += estimateBytes(v, depth + 1) + 1;
        return n;
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) n += k.length + 4 + estimateBytes(v, depth + 1);
      return n;
    }
    default:
      return 8;
  }
}

// ── result copies ───────────────────────────────────────────────────────────
/** Shallow copy of a query result: own rows/columns arrays, shared row objects. */
export function copyQueryResult<R extends { rows: unknown[]; columns?: unknown[] }>(r: R): R {
  return { ...r, rows: r.rows.slice(), ...(Array.isArray(r.columns) ? { columns: r.columns.slice() } : {}) };
}

// ── configuration ───────────────────────────────────────────────────────────
type Env = Record<string, string | undefined>;

function intFrom(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Read QUERY_CACHE_* from the environment; bad values fall back to the defaults. */
export function queryCacheOptionsFromEnv(env: Env): Required<Omit<QueryCacheOptions, 'now'>> {
  const ttlMs = intFrom(env.QUERY_CACHE_TTL_MS, QUERY_CACHE_DEFAULTS.ttlMs, 0, 10 * 60_000);
  const maxEntries = intFrom(env.QUERY_CACHE_MAX_ENTRIES, QUERY_CACHE_DEFAULTS.maxEntries, 1, 10_000);
  const maxBytes = intFrom(env.QUERY_CACHE_MAX_BYTES, QUERY_CACHE_DEFAULTS.maxBytes, 1024, 512 * 1024 * 1024);
  const maxEntryBytes = Math.min(maxBytes, intFrom(env.QUERY_CACHE_MAX_ENTRY_BYTES, QUERY_CACHE_DEFAULTS.maxEntryBytes, 1024, 512 * 1024 * 1024));
  return { ttlMs, maxEntries, maxBytes, maxEntryBytes };
}
