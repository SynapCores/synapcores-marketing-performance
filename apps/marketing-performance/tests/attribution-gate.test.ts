/**
 * Collector attribution gate. Browser-pixel beacons from named crawlers that
 * never act for a live person (search engines, SEO tools, AI crawlers) are
 * kept in pm_events (Visitors, humans-vs-bots, AI crawler views) but not
 * written to the recipe tables, so they stop re-arming the full-table
 * attribution + scorecard rebuild. Everything else, where a wrong bot verdict
 * could cost real attribution, is ingested as before: user-initiated AI agents,
 * social previews, monitors, headless browsers (Electron apps), scripted
 * clients, other bots, a missing verdict, and every S2S / dev batch.
 *
 * Verdicts come from the real classifyVisitor + the bundled crawler ranges.
 * Real-world case: Googlebot's Nexus 5X renderer (66.249.66.0/24) rendering
 * werkor.us pages all night, ~3 beacons/min, plus Meta-ExternalAgent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import bundled from '../src/lib/visitor/crawler-ranges.bundled.json';
import { CrawlerMatcher, RANGE_SOURCES, type RangeSet } from '../src/lib/visitor/crawler-ranges';
import { classifyVisitor } from '../src/lib/visitor/classify';
import { AI_BOT_NAMES } from '../src/lib/visitor/ua';
import { buildEventRows } from '../src/lib/visitor/events';
import { EMPTY_GEO } from '../src/lib/visitor/geo';
import {
  isUserInitiatedBot,
  mapBatch,
  shouldIngestForAttribution,
  type BeaconBatch,
  type CollectSourceKind,
} from '../src/lib/collector';

const M = new CrawlerMatcher(bundled as RangeSet);

/** An address in the first IPv4 prefix of a bundled list (small prefixes change when the lists are regenerated). */
function inList(id: string): string {
  const cidr = (bundled as RangeSet).sources[id]?.find((c) => !c.includes(':'));
  assert.ok(cidr, `bundled list ${id} has an IPv4 prefix`);
  return cidr.split('/')[0]!;
}

const NEXUS = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Mobile Safari/537.36';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA = {
  googlebotSmartphone: `${NEXUS} (compatible; Googlebot/2.1; +http://www.google.com/bot.html)`,
  googleRendererPlain: NEXUS, // Google's renderer with no bot token: a bot only by its IP
  headless: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  ahrefs: 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
  metaAgent: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  metaFetcher: 'meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  chatgptUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  chatgptAgent: `${CHROME} ChatGPT-Agent/1.0`, // a UA carrying the token ua.ts matches
  claudeUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
  diffbotUser: 'Mozilla/5.0 (compatible; Diffbot-User/1.0; +https://www.diffbot.com)',
  fbHit: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  lighthouse: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
  uptimeRobot: 'Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)',
  electron: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Notion/4.3.0 Chrome/130.0.6723.137 Electron/33.2.1 Safari/537.36',
  curl: 'curl/8.5.0',
  python: 'python-requests/2.32.3',
  shapbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ShapBot/0.1.0',
  chromeMac: CHROME,
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Mobile/15E148 Safari/604.1',
};
const IP = {
  google: '66.249.66.12', // googlebot.json
  residential: '136.57.16.80',
  hosting: '34.31.203.120', // in no published crawler list
  gptbot: '132.196.86.5', // openai gptbot.json
  chatgptUser: inList('openai-chatgpt-user'),
  chatgptUserBroad: '9.129.4.20', // the broad 9.129.0.0/16 in chatgpt-user.json
  anthropic: '216.73.216.10', // 216.73.216.0/22 in claude.com/crawling/bots.json
  perplexityUser: inList('perplexity-user'),
  googleUserTriggered: inList('google-user-triggered'),
};

type Case = [label: string, ua: string, ip: string | null, category: string, name?: string];

/** Classify for real, check the verdict, then return the gate's decision for a pixel batch. */
function pixelGate([label, ua, ip, category, name]: Case): boolean {
  const v = classifyVisitor(ua, ip, M);
  assert.equal(v.isBot, true, `${label}: isBot`);
  assert.equal(v.botCategory, category, `${label}: category`);
  if (name) assert.equal(v.botName, name, `${label}: name`);
  return shouldIngestForAttribution('pixel', v);
}

test('pixel: search, SEO and AI crawlers are not ingested for attribution', () => {
  const cases: Case[] = [
    ['verified Googlebot', UA.googlebotSmartphone, IP.google, 'search', 'Googlebot'],
    ['Google renderer: plain Nexus 5X Chrome UA from 66.249.66.x (range hit)', UA.googleRendererPlain, IP.google, 'search', 'Googlebot'],
    ['Google renderer: HeadlessChrome from 66.249.66.x (range hit)', UA.headless, IP.google, 'search', 'Googlebot'],
    ['Googlebot claimed from a residential IP (unverified, still search)', UA.googlebotSmartphone, IP.residential, 'search', 'Googlebot'],
    ['Meta-ExternalAgent', UA.metaAgent, IP.hosting, 'ai', 'Meta-ExternalAgent'],
    ['GPTBot from its published range', UA.gptbot, IP.gptbot, 'ai', 'GPTBot (OpenAI)'],
    ['AhrefsBot', UA.ahrefs, IP.hosting, 'seo', 'AhrefsBot'],
  ];
  for (const c of cases) assert.equal(pixelGate(c), false, c[0]);
});

test('pixel: user-initiated AI agents and fetchers are ingested', () => {
  const cases: Case[] = [
    ['ChatGPT-User from its range', UA.chatgptUser, IP.chatgptUser, 'ai', 'ChatGPT-User (OpenAI)'],
    ['plain Chrome UA from the broad 9.129.0.0/16 ChatGPT-User range', UA.chromeMac, IP.chatgptUserBroad, 'ai', 'ChatGPT-User (OpenAI)'],
    ['ChatGPT Agent (browses and buys for a user)', UA.chatgptAgent, IP.chatgptUser, 'ai', 'ChatGPT Agent (OpenAI)'],
    ['Claude-User from its range', UA.claudeUser, IP.anthropic, 'ai', 'Claude-User (Anthropic)'],
    ['Perplexity-User via range with a plain UA', UA.chromeMac, IP.perplexityUser, 'ai', 'Perplexity-User'],
    ['Meta-ExternalFetcher', UA.metaFetcher, IP.hosting, 'ai', 'Meta-ExternalFetcher'],
    ['Diffbot-User (the /Diffbot/ rule names it Diffbot)', UA.diffbotUser, IP.hosting, 'ai', 'Diffbot'],
    ["plain UA from Anthropic's one list for all its bots (Claude-User included)", UA.chromeMac, IP.anthropic, 'ai', 'Claude crawler (Anthropic)'],
  ];
  for (const c of cases) assert.equal(pixelGate(c), true, c[0]);
});

test('pixel: social, monitor, headless, scripted and other bots are ingested (a wrong verdict there could cost attribution)', () => {
  const cases: Case[] = [
    ['Facebook link preview', UA.fbHit, IP.hosting, 'social', 'Facebook link preview'],
    ['Lighthouse', UA.lighthouse, IP.residential, 'monitor', 'Lighthouse'],
    ['UptimeRobot', UA.uptimeRobot, IP.hosting, 'monitor', 'UptimeRobot'],
    ['HeadlessChrome', UA.headless, IP.residential, 'headless', 'HeadlessChrome'],
    ['Electron desktop app', UA.electron, IP.residential, 'headless', 'Browser automation'],
    ['curl', UA.curl, IP.residential, 'tool', 'curl'],
    ['python-requests', UA.python, IP.residential, 'tool', 'Python HTTP client'],
    ['empty user agent', '', IP.residential, 'tool', 'Empty user agent'],
    ['an "other" bot (generic token)', UA.shapbot, IP.hosting, 'other', 'ShapBot'],
    ['Google user-triggered fetcher (plain UA from its range)', UA.chromeMac, IP.googleUserTriggered, 'other', 'Google user-triggered fetcher'],
  ];
  for (const c of cases) assert.equal(pixelGate(c), true, c[0]);
});

test('pixel: humans are ingested', () => {
  for (const [ua, ip] of [[UA.chromeMac, IP.residential], [UA.safariIphone, '176.54.64.146'], [UA.chromeMac, null]] as const) {
    const v = classifyVisitor(ua, ip, M);
    assert.equal(v.isBot, false, `${ua} ${ip}`);
    assert.equal(shouldIngestForAttribution('pixel', v), true, `${ua} ${ip}`);
  }
});

test('server-to-server batches are always ingested, even with a crawler UA or IP', () => {
  const cases: Array<[string, string | null, string | null]> = [
    ['S2S with a Googlebot UA', UA.googlebotSmartphone, IP.google],
    ['S2S with a plain UA from a Google crawler range', UA.chromeMac, IP.google],
    ['S2S with a GPTBot UA', UA.gptbot, IP.gptbot],
    ['S2S with an AhrefsBot UA', UA.ahrefs, IP.hosting],
    ["the customer server's own UA, no body userAgent", UA.python, '203.0.113.9'],
    ['no UA anywhere', null, null],
  ];
  for (const [label, ua, ip] of cases) {
    const v = classifyVisitor(ua, ip, M);
    assert.equal(v.isBot, true, label);
    assert.equal(shouldIngestForAttribution('key', v), true, label);
  }
});

test('dev fallback and a missing verdict ingest, as before the gate existed', () => {
  assert.equal(shouldIngestForAttribution('dev', classifyVisitor(UA.googlebotSmartphone, IP.google, M)), true);
  for (const kind of ['pixel', 'key', 'dev'] as CollectSourceKind[]) {
    assert.equal(shouldIngestForAttribution(kind, null), true, kind);
    assert.equal(shouldIngestForAttribution(kind, undefined), true, kind);
  }
});

// Every `ai` rule in visitor/ua.ts, with its decision. A new or renamed ai rule
// fails the coverage test below until it is added here on purpose.
const AI_RULES: Array<[token: string, name: string, userInitiated: boolean]> = [
  ['GPTBot', 'GPTBot (OpenAI)', false],
  ['ChatGPT-User', 'ChatGPT-User (OpenAI)', true],
  ['OAI-SearchBot', 'OAI-SearchBot (OpenAI)', false],
  ['ChatGPT-Agent', 'ChatGPT Agent (OpenAI)', true],
  ['ClaudeBot', 'ClaudeBot (Anthropic)', false],
  ['Claude-User', 'Claude-User (Anthropic)', true],
  ['Claude-SearchBot', 'Claude-SearchBot (Anthropic)', false],
  ['Claude-Web', 'Claude-Web (Anthropic)', false],
  ['anthropic-ai', 'Claude-Web (Anthropic)', false],
  ['PerplexityBot', 'PerplexityBot', false],
  ['Perplexity-User', 'Perplexity-User', true],
  ['Google-Extended', 'Google-Extended', false],
  ['Google-CloudVertexBot', 'Google-CloudVertexBot', false],
  ['Google-Agent', 'Google AI Agent', true],
  ['Gemini-Deep-Research', 'Google AI Agent', true],
  ['Google-NotebookLM', 'Google AI Agent', true],
  ['Applebot-Extended', 'Applebot-Extended', false],
  ['CCBot', 'CCBot (Common Crawl)', false],
  ['Bytespider', 'Bytespider (ByteDance)', false],
  ['meta-externalagent', 'Meta-ExternalAgent', false],
  ['meta-externalfetcher', 'Meta-ExternalFetcher', true],
  ['FacebookBot', 'FacebookBot (Meta AI)', false],
  ['Amazonbot', 'Amazonbot', false],
  ['cohere-ai', 'Cohere', true],
  ['cohere-training-data-crawler', 'Cohere', true], // same name as cohere-ai: can't be told apart
  ['Diffbot', 'Diffbot', true], // one name with Diffbot-User
  ['Diffbot-User', 'Diffbot', true],
  ['YouBot', 'YouBot (You.com)', false],
  ['MistralAI-User', 'MistralAI-User', true],
  ['DeepSeekBot', 'DeepSeekBot', false],
  ['PetalBot', 'PetalBot (Huawei)', false],
  ['AI2Bot', 'AI2Bot (Allen AI)', false],
  ['Timpibot', 'Timpibot', false],
  ['ImagesiftBot', 'ImagesiftBot', false],
  ['omgili', 'Omgili (Webz.io)', false],
  ['Kangaroo Bot', 'Kangaroo Bot', false],
  ['PanguBot', 'PanguBot', false],
  ['iaskspider', 'iAskSpider', false],
  ['DuckAssistBot', 'DuckAssistBot', true],
  ['Phind', 'Phind', true],
  ['FirecrawlAgent', 'Firecrawl', false],
  ['QualifiedBot', 'AI data crawler', false],
];

test('every ai rule in the UA table has a deliberate gate decision', () => {
  assert.deepEqual([...new Set(AI_RULES.map(([, name]) => name))].sort(), [...AI_BOT_NAMES].sort());
  for (const [token, name, userInitiated] of AI_RULES) {
    const v = classifyVisitor(`Mozilla/5.0 (compatible; ${token}/1.0)`, IP.hosting, M);
    assert.deepEqual([v.isBot, v.botCategory, v.botName], [true, 'ai', name], token);
    assert.equal(isUserInitiatedBot(name), userInitiated, name);
    assert.equal(shouldIngestForAttribution('pixel', v), userInitiated, token);
  }
});

test("ai crawler-range labels: the -User lists and Anthropic's mixed list count as user-initiated", () => {
  const ai = RANGE_SOURCES.filter((s) => s.category === 'ai');
  assert.ok(ai.length >= 7);
  assert.deepEqual(
    ai.filter((s) => isUserInitiatedBot(s.label)).map((s) => s.label).sort(),
    ['ChatGPT-User (OpenAI)', 'Claude crawler (Anthropic)', 'Perplexity-User'],
  );
  // Per-bot crawler lists stay crawlers, and so do look-alike names.
  for (const n of ['GPTBot (OpenAI)', 'OAI-SearchBot (OpenAI)', 'PerplexityBot', 'CCBot (Common Crawl)', 'Meta-ExternalAgent', 'DuckDuckBot', 'ClaudeBot (Anthropic)', 'Claude-SearchBot (Anthropic)', 'Some-Username', null, undefined, '']) {
    assert.equal(isUserInitiatedBot(n), false, String(n));
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
  const ua = classifyVisitor(UA.googleRendererPlain, IP.google, M);

  // The mapping would have produced recipe rows (and so a rebuild)…
  const mapped = mapBatch(batch);
  assert.deepEqual([mapped.clickstream.length, mapped.conversions.length, mapped.identity.length], [1, 1, 1]);
  // …but the gate holds a pixel crawler back, and lets the same batch through on S2S.
  assert.equal(shouldIngestForAttribution('pixel', ua), false);
  assert.equal(shouldIngestForAttribution('key', ua), true);

  // pm_events keeps every event, flagged as a verified bot, for the bot reports.
  const rows = buildEventRows(batch, { tenantId: 't1', pixelId: 'pk_werkor', sourceKind: 'pixel', ip: IP.google, geo: EMPTY_GEO, ua, userAgent: UA.googleRendererPlain });
  assert.equal(rows.length, 3);
  for (const r of rows) assert.deepEqual([r.is_bot, r.bot_name, r.bot_verified], [true, 'Googlebot', 'verified']);
});
