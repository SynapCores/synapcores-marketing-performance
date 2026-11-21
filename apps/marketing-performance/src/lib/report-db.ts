import 'server-only';
import { getAdminClient } from '@synapcores/app-framework/db/server';
import type { QueryResult } from '@synapcores/app-framework/db';
import { QueryCache, copyQueryResult, queryCacheOptionsFromEnv, type QueryCacheStats } from './query-cache';

/**
 * Cached reads for the report pages (dashboard, campaigns, attribution,
 * creative, visitors, UTM campaigns, tables). See query-cache.ts for the rules.
 *
 * Use reportDb(tenantId) ONLY for report SELECTs. Writes, auth/session/token
 * lookups, pixel-key checks and read-before-write lookups (e.g. MAX(id) before
 * an insert) must keep using getAdminClient() directly.
 *
 * Every write to report data calls invalidateReports(): with a tenant id for
 * that tenant's pm_events / pm_campaigns, without one for the shared recipe
 * warehouse tables and the all-tenant background jobs. New pixel events are the
 * exception: they show up within QUERY_CACHE_TTL_MS (30 s by default), so a busy
 * site can't keep emptying the cache.
 *
 * The cache lives on globalThis so route handlers, server actions, pages and
 * instrumentation (separate module instances in a Next.js server build) share
 * one cache and one invalidation.
 */

export interface ReportReader {
  sql<Row = Record<string, unknown>>(statement: string, params?: ReadonlyArray<unknown>): Promise<QueryResult<Row>>;
  sqlScalar<T = unknown>(statement: string, params?: ReadonlyArray<unknown>): Promise<T | null>;
}

const CACHE_KEY = Symbol.for('synapcores.marketing-performance.report-cache');

export function reportCache(): QueryCache {
  const g = globalThis as unknown as Record<symbol, QueryCache | undefined>;
  let cache = g[CACHE_KEY];
  if (!cache) {
    cache = new QueryCache(queryCacheOptionsFromEnv(process.env));
    g[CACHE_KEY] = cache;
  }
  return cache;
}

const tenantScope = (tenantId: string) => `tenant:${tenantId}`;

/** A reader for one tenant's reports. Without a tenant it is the plain (uncached) admin client. */
export function reportDb(tenantId: string | null | undefined): ReportReader {
  const db = getAdminClient();
  if (!tenantId) return db;
  const scope = tenantScope(tenantId);
  const sql = <Row = Record<string, unknown>>(statement: string, params: ReadonlyArray<unknown> = []) =>
    reportCache().run<QueryResult<Row>>(scope, statement, params, () => db.sql<Row>(statement, params), copyQueryResult);
  return {
    sql,
    async sqlScalar<T = unknown>(statement: string, params: ReadonlyArray<unknown> = []): Promise<T | null> {
      const r = await sql<Record<string, T>>(statement, params);
      const col = r.columns[0];
      const row = r.rows[0];
      return row && col ? row[col] ?? null : null;
    },
  };
}

/** Drop cached reports for one tenant, or for everyone when called without one. */
export function invalidateReports(tenantId?: string | null): void {
  if (tenantId) reportCache().invalidate(tenantScope(tenantId));
  else reportCache().invalidate();
}

export function reportCacheStats(): QueryCacheStats {
  return reportCache().stats();
}
