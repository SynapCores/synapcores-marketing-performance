/**
 * Loads, caches and refreshes the published crawler IP lists.
 *
 *   1. bundled fallback (crawler-ranges.bundled.json, regenerated with
 *      `node bin/update-crawler-ranges.mjs`), so verification works offline;
 *   2. on-disk cache (CRAWLER_RANGES_CACHE, default
 *      /var/lib/mktperf-app/crawler-ranges.json), so a restart doesn't refetch;
 *   3. a daily refresh from the operators' URLs (CRAWLER_RANGES_REFRESH_HOURS,
 *      default 24). A source that fails or parses to nothing keeps its previous
 *      prefixes — a bad fetch never empties a list.
 *
 * Set CRAWLER_RANGES_REFRESH=off to stay on cache + bundled data.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import bundled from './crawler-ranges.bundled.json';
import { CrawlerMatcher, RANGE_SOURCES, parsePrefixes, type RangeSet } from './crawler-ranges';

const DEFAULT_CACHE = '/var/lib/mktperf-app/crawler-ranges.json';
const cachePath = () => process.env.CRAWLER_RANGES_CACHE || DEFAULT_CACHE;
export const refreshIntervalMs = () => Math.max(1, Number(process.env.CRAWLER_RANGES_REFRESH_HOURS ?? 24) || 24) * 3600_000;

let current: RangeSet | null = null;
let matcher: CrawlerMatcher | null = null;

function readCache(): RangeSet | null {
  try {
    const s = JSON.parse(readFileSync(cachePath(), 'utf8')) as RangeSet;
    return s && typeof s.fetchedAt === 'string' && s.sources && typeof s.sources === 'object' ? s : null;
  } catch {
    return null;
  }
}

/** Per source, prefer the newer set's list when it's non-empty. */
function merge(base: RangeSet, over: RangeSet | null): RangeSet {
  if (!over) return base;
  const sources: Record<string, string[]> = { ...base.sources };
  for (const [id, list] of Object.entries(over.sources)) if (Array.isArray(list) && list.length) sources[id] = list;
  return { fetchedAt: over.fetchedAt > base.fetchedAt ? over.fetchedAt : base.fetchedAt, sources };
}

function use(set: RangeSet) {
  current = set;
  matcher = new CrawlerMatcher(set);
}

/** Synchronous: always returns a matcher (cache if present, else bundled). */
export function getCrawlerMatcher(): CrawlerMatcher {
  if (!matcher) use(merge(bundled as RangeSet, readCache()));
  return matcher!;
}

export function rangesAgeMs(now = Date.now()): number {
  getCrawlerMatcher();
  const t = Date.parse(current!.fetchedAt);
  return Number.isFinite(t) ? now - t : Infinity;
}

async function fetchJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'mktperf-crawler-ranges/1.0' }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

export interface RefreshResult { ok: string[]; failed: Array<{ id: string; error: string }>; prefixes: number }

/** Fetch every source; keep the previous list for any that fail. Writes the cache. */
export async function refreshCrawlerRanges(): Promise<RefreshResult> {
  getCrawlerMatcher();
  const next: RangeSet = { fetchedAt: new Date().toISOString(), sources: { ...current!.sources } };
  const ok: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  await Promise.all(
    RANGE_SOURCES.map(async (s) => {
      try {
        const list = parsePrefixes(await fetchJson(s.url));
        if (!list.length) throw new Error('no prefixes');
        next.sources[s.id] = list;
        ok.push(s.id);
      } catch (e) {
        failed.push({ id: s.id, error: (e as Error).message.slice(0, 120) });
      }
    }),
  );
  if (!ok.length) next.fetchedAt = current!.fetchedAt; // nothing new: don't pretend it's fresh
  use(next);
  try {
    const p = cachePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p + '.tmp', JSON.stringify(next));
    renameSync(p + '.tmp', p);
  } catch {
    // Read-only filesystem: keep the in-memory copy.
  }
  return { ok, failed, prefixes: matcher!.size };
}
