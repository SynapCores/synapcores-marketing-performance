/** Crawler range store: bundled fallback + on-disk cache + refresh that never empties a list. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'crawler-store-'));
const cache = join(dir, 'ranges.json');
process.env.CRAWLER_RANGES_CACHE = cache;
// Cached copy: newer google-common list that adds a test prefix.
writeFileSync(cache, JSON.stringify({ fetchedAt: '2999-01-01T00:00:00Z', sources: { 'google-common': ['198.51.100.0/24'] } }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require('../src/lib/visitor/crawler-ranges-store') as typeof import('../src/lib/visitor/crawler-ranges-store');

test('matcher = bundled data overlaid with the cache', () => {
  const m = store.getCrawlerMatcher();
  assert.equal(m.lookup('198.51.100.7')?.operator, 'google'); // from cache
  assert.equal(m.lookup('66.249.66.1'), null); // cache replaced google-common
  assert.equal(m.lookup('157.55.39.10')?.operator, 'bing'); // bundled
  assert.ok(store.rangesAgeMs() < 0); // fetchedAt in the future → fresh
});

test('refresh keeps the previous list for sources that fail and writes the cache', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('bingbot')) return new Response('nope', { status: 503 });
    if (String(url).includes('googlebot.json')) return new Response(JSON.stringify({ prefixes: [{ ipv4Prefix: '66.249.64.0/19' }] }));
    return new Response(JSON.stringify({ prefixes: [] })); // parses to nothing → keep old
  }) as typeof fetch;
  try {
    const r = await store.refreshCrawlerRanges();
    assert.deepEqual(r.ok, ['google-common']);
    assert.ok(r.failed.some((f) => f.id === 'bing'));
    const m = store.getCrawlerMatcher();
    assert.equal(m.lookup('66.249.66.1')?.operator, 'google');
    assert.equal(m.lookup('157.55.39.10')?.operator, 'bing'); // failed fetch kept bundled list
    const written = JSON.parse(readFileSync(cache, 'utf8'));
    assert.deepEqual(written.sources['google-common'], ['66.249.64.0/19']);
    assert.ok(written.sources.bing.length > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
