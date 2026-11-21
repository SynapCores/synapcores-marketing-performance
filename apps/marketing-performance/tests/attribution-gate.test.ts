/**
 * Collector attribution gate: browser-pixel batches from bots are kept in
 * pm_events (Visitors, humans-vs-bots, AI crawler views) but never written to
 * the recipe tables, so they stop re-arming the full-table attribution +
 * scorecard rebuild. Server-to-server batches are always ingested.
 *
 * Real-world case: Googlebot's Nexus 5X smartphone renderer (66.249.66.0/24)
 * rendering werkor.us pages all night, ~3 beacons/min.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import bundled from '../src/lib/visitor/crawler-ranges.bundled.json';
import { CrawlerMatcher, type RangeSet } from '../src/lib/visitor/crawler-ranges';
import { classifyVisitor } from '../src/lib/visitor/classify';
import { buildEventRows } from '../src/lib/visitor/events';
import { EMPTY_GEO } from '../src/lib/visitor/geo';
import { mapBatch, shouldIngestForAttribution, type BeaconBatch, type CollectSourceKind } from '../src/lib/collector';

const M = new CrawlerMatcher(bundled as RangeSet);

const NEXUS = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Mobile Safari/537.36';
const UA = {
  googlebotSmartphone: `${NEXUS} (compatible; Googlebot/2.1; +http://www.google.com/bot.html)`,
  googleRendererPlain: NEXUS, // Google's renderer with no bot token: a bot only by its IP
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  headless: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
  curl: 'curl/8.5.0',
  python: 'python-requests/2.32.3',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Mobile/15E148 Safari/604.1',
};
const GOOGLE_IP = '66.249.66.12';
const RESIDENTIAL = '136.57.16.80';

test('pixel: a verified crawler (declared UA or crawler IP) is not ingested for attribution', () => {
  const cases: Array<[string, string, string]> = [
    [UA.googlebotSmartphone, GOOGLE_IP, 'Googlebot smartphone UA from 66.249.66.x'],
    [UA.googleRendererPlain, GOOGLE_IP, 'plain Nexus 5X Chrome UA from 66.249.66.x (renderer, verified by IP)'],
    [UA.chromeMac, '66.249.66.204', 'desktop Chrome UA from a Google crawler range'],
    [UA.chromeMac, '2001:4860:4801:10::5', 'browser UA from a Google crawler v6 range'],
    [UA.gptbot, '132.196.86.5', 'GPTBot from its published range'],
  ];
  for (const [ua, ip, label] of cases) {
    const c = classifyVisitor(ua, ip, M);
    assert.deepEqual([c.isBot, c.botVerified], [true, 'verified'], label);
    assert.equal(shouldIngestForAttribution('pixel', c), false, label);
  }
});

test('pixel: declared bots without a verified IP (spoofed, unverifiable, scripted, empty UA) are not ingested either', () => {
  const cases: Array<[string, string, string]> = [
    [UA.googlebotSmartphone, RESIDENTIAL, 'claims Googlebot, unverified'],
    [UA.headless, RESIDENTIAL, 'HeadlessChrome'],
    [UA.curl, RESIDENTIAL, 'curl'],
    [UA.python, RESIDENTIAL, 'python-requests'],
    ['', RESIDENTIAL, 'empty user agent'],
  ];
  for (const [ua, ip, label] of cases) {
    const c = classifyVisitor(ua, ip, M);
    assert.equal(c.isBot, true, label);
    assert.equal(shouldIngestForAttribution('pixel', c), false, label);
  }
});

test('pixel: humans are ingested', () => {
  for (const [ua, ip] of [[UA.chromeMac, RESIDENTIAL], [UA.safariIphone, '176.54.64.146'], [UA.chromeMac, null]] as const) {
    const c = classifyVisitor(ua, ip, M);
    assert.equal(c.isBot, false, `${ua} ${ip}`);
    assert.equal(shouldIngestForAttribution('pixel', c), true, `${ua} ${ip}`);
  }
});

test('server-to-server batches are always ingested, even with an automated UA or a crawler IP', () => {
  const bots = [
    classifyVisitor(UA.python, '203.0.113.9', M), // the customer's server UA, no body userAgent
    classifyVisitor(UA.googlebotSmartphone, GOOGLE_IP, M),
    classifyVisitor(UA.chromeMac, GOOGLE_IP, M),
    classifyVisitor(null, null, M), // no UA anywhere
  ];
  for (const c of bots) {
    assert.equal(c.isBot, true);
    assert.equal(shouldIngestForAttribution('key', c), true, `${c.botName}`);
  }
  assert.equal(shouldIngestForAttribution('key', classifyVisitor(UA.chromeMac, RESIDENTIAL, M)), true);
});

test('dev fallback and a missing verdict fall back to the old behaviour (ingest)', () => {
  assert.equal(shouldIngestForAttribution('dev', classifyVisitor(UA.curl, '127.0.0.1', M)), true);
  for (const kind of ['pixel', 'key', 'dev'] as CollectSourceKind[]) {
    assert.equal(shouldIngestForAttribution(kind, null), true, kind);
    assert.equal(shouldIngestForAttribution(kind, undefined), true, kind);
  }
});

test('a Googlebot batch maps to recipe rows and flagged pm_events rows; the gate holds back only the recipe rows', () => {
  const T0 = Date.parse('2026-11-21T04:10:00Z');
  const batch: BeaconBatch = {
    siteId: 'pk_werkor',
    userId: 'anon-googlebot-1',
    sessionId: 'sess-g1',
    timestamp: T0,
    url: 'https://werkor.us/pricing?utm_source=google&utm_campaign=c1',
    userAgent: UA.googleRendererPlain,
    events: [
      { name: 'pageview', timestamp: T0, data: { path: '/pricing' }, queryParams: { utm_source: 'google', utm_campaign: 'c1' } },
      { name: 'purchase', timestamp: T0, data: { revenue: 99 } },
      { name: 'identify', timestamp: T0, data: { customer_id: 42 } },
    ],
  };
  const ua = classifyVisitor(UA.googleRendererPlain, GOOGLE_IP, M);

  // The mapping would have produced recipe rows (and so a rebuild)…
  const mapped = mapBatch(batch);
  assert.deepEqual([mapped.clickstream.length, mapped.conversions.length, mapped.identity.length], [1, 1, 1]);
  // …but the gate holds a pixel bot back, and lets the same batch through on S2S.
  assert.equal(shouldIngestForAttribution('pixel', ua), false);
  assert.equal(shouldIngestForAttribution('key', ua), true);

  // pm_events keeps every event, flagged as a verified bot, for the bot reports.
  const rows = buildEventRows(batch, { tenantId: 't1', pixelId: 'pk_werkor', sourceKind: 'pixel', ip: GOOGLE_IP, geo: EMPTY_GEO, ua, userAgent: UA.googleRendererPlain });
  assert.equal(rows.length, 3);
  for (const r of rows) assert.deepEqual([r.is_bot, r.bot_name, r.bot_verified], [true, 'Googlebot', 'verified']);
});
