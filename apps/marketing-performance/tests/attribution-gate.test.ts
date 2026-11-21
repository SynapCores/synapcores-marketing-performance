/**
 * Collector attribution gate. Browser-pixel beacons from named crawlers that
 * never act for a live person (search crawlers whose operator publishes IP
 * ranges, SEO tools, AI crawlers) are kept in pm_events (Visitors,
 * humans-vs-bots, AI crawler views) but not written to the recipe tables, so
 * they stop re-arming the full-table attribution + scorecard rebuild.
 * Everything else, where a wrong bot verdict could cost real attribution, is
 * ingested as before: search bots with no published list (their UA rules also
 * match Sogou Mobile Browser and the Yandex app), user-initiated AI agents,
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
import { AI_BOT_NAMES, botOperator } from '../src/lib/visitor/ua';
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
  bingbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/136.0.0.0 Safari/537.36',
  sogouMobileBrowser: 'Mozilla/5.0 (Linux; Android 10; V2001A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Mobile Safari/537.36 SogouMSE,SogouMobileBrowser/5.37.6',
  yandexApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 YaBrowser/24.6.1.402.10 SA/3 Mobile/15E148 Safari/604.1 YandexSearch/7.42',
  yandexBot: 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
  baiduspider: 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  ahrefs: 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
  metaAgent: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  metaFetcher: 'meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  chatgptUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  chatgptAgent: `${CHROME} ChatGPT-Agent/1.0`, // the token ua.ts matches; OpenAI documents none for its agent
  claudeAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-Agent/1.0) Chrome/154.0.0.0 Safari/537.36', // Anthropic's documented example
  amznUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amzn-User/0.1) Chrome/131.0.0.0 Safari/537.36',
  geminiNotebook: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36 (compatible; Google-GeminiNotebook; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-gemininotebook)',
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
  bing: inList('bing'), // bingbot.json
  residential: '136.57.16.80',
  hosting: '34.31.203.120', // in no published crawler list
  gptbot: '132.196.86.5', // openai gptbot.json
  chatgptUser: inList('openai-chatgpt-user'),
  chatgptUserBroad: '9.129.4.20', // the broad 9.129.0.0/16 in chatgpt-user.json
  anthropic: '216.73.216.10', // 216.73.216.0/22 in claude.com/crawling/bots.json
  perplexityUser: inList('perplexity-user'),
  googleUserTriggered: inList('google-user-triggered'),
  claudeAgent: '34.31.25.14', // claude.com/.well-known/sail (Claude-Agent), in no bundled list
};

type Case = [label: string, ua: string, ip: string | null, category: string, name?: string, verified?: string];

/** Classify for real, check the verdict, then return the gate's decision for a pixel batch. */
function pixelGate([label, ua, ip, category, name, verified]: Case): boolean {
  const v = classifyVisitor(ua, ip, M);
  assert.equal(v.isBot, true, `${label}: isBot`);
  assert.equal(v.botCategory, category, `${label}: category`);
  if (name) assert.equal(v.botName, name, `${label}: name`);
  if (verified) assert.equal(v.botVerified, verified, `${label}: botVerified`);
  return shouldIngestForAttribution('pixel', v);
}

// Search engines that publish crawler ranges: classifyVisitor always says
// 'verified' (IP in the operator's list) or 'unverified' (the UA claims it, the
// IP isn't).
const LISTED_SEARCH: Array<[ua: string, name: string]> = [
  [UA.googlebotSmartphone, 'Googlebot'],
  [`${NEXUS} (compatible; Google-InspectionTool/1.0;)`, 'Google-InspectionTool'],
  ['AdsBot-Google (+http://www.google.com/adsbot.html)', 'AdsBot-Google'],
  [UA.bingbot, 'Bingbot'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)', 'Applebot'],
  ['DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)', 'DuckDuckBot'],
];
// Search engines with no published list: only ever 'unverifiable'.
const NO_LIST_SEARCH: Array<[ua: string, name: string]> = [
  [UA.yandexBot, 'YandexBot'],
  [UA.baiduspider, 'Baiduspider'],
  ['Sogou web spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)', 'Sogou'],
  ['Mozilla/5.0 (compatible; SeznamBot/4.0; +https://o-seznam.cz/napoveda/vyhledavani/en/seznambot-crawler/)', 'SeznamBot'],
  ['Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)', 'Naver Yeti'],
  ['Mozilla/5.0 (compatible; MojeekBot/0.11; +https://www.mojeek.com/bot.html)', 'MojeekBot'],
  ['Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)', 'Yahoo Slurp'],
  ['Mozilla/5.0 (compatible; Qwantbot/1.0; +https://help.qwant.com/bot/)', 'Qwantbot'],
  ['Mozilla/5.0 (compatible; coccocbot-web/1.0; +http://help.coccoc.com/searchengine)', 'CocCocBot'],
  ['Mozilla/5.0 (compatible; Bravebot/1.0; +https://search.brave.com/help/brave-search-crawler)', 'BraveBot'],
];

test('pixel: range-checked search crawlers, SEO tools and AI crawlers are not ingested for attribution', () => {
  const cases: Case[] = [
    ['declared Googlebot from its range', UA.googlebotSmartphone, IP.google, 'search', 'Googlebot', 'verified'],
    ['Google renderer: plain Nexus 5X Chrome UA from 66.249.66.x (range hit)', UA.googleRendererPlain, IP.google, 'search', 'Googlebot', 'verified'],
    ['Google renderer: HeadlessChrome from 66.249.66.x (range hit)', UA.headless, IP.google, 'search', 'Googlebot', 'verified'],
    ['spoofed Googlebot UA from a non-Google IP', UA.googlebotSmartphone, IP.residential, 'search', 'Googlebot', 'unverified'],
    ['Bingbot from a Bing range', UA.bingbot, IP.bing, 'search', 'Bingbot', 'verified'],
    ["a no-list search UA from a Google crawler IP (the IP is a crawler's)", UA.yandexBot, '66.249.66.1', 'search', 'YandexBot', 'verified'],
    ['Meta-ExternalAgent', UA.metaAgent, IP.hosting, 'ai', 'Meta-ExternalAgent'],
    ['GPTBot from its published range', UA.gptbot, IP.gptbot, 'ai', 'GPTBot (OpenAI)'],
    ['AhrefsBot', UA.ahrefs, IP.hosting, 'seo', 'AhrefsBot'],
  ];
  for (const c of cases) assert.equal(pixelGate(c), false, c[0]);
});

test("pixel: search bots with no published list ('unverifiable') are ingested, as on prod", () => {
  const cases: Case[] = [
    // Real people: those engines' broad UA rules also match their browsers and apps.
    ['Sogou Mobile Browser (a person)', UA.sogouMobileBrowser, IP.residential, 'search', 'Sogou', 'unverifiable'],
    ['Yandex app with its YandexSearch/ token (a person)', UA.yandexApp, IP.residential, 'search', 'YandexBot', 'unverifiable'],
    ...NO_LIST_SEARCH.map(([ua, name]): Case => [`declared ${name}`, ua, IP.hosting, 'search', name, 'unverifiable']),
  ];
  for (const c of cases) assert.equal(pixelGate(c), true, c[0]);
});

test('declared search bots are skipped exactly when their operator publishes crawler ranges', () => {
  for (const [ua, name] of [...LISTED_SEARCH, ...NO_LIST_SEARCH]) {
    const v = classifyVisitor(ua, IP.hosting, M); // an IP in no published list
    const listed = botOperator(name) !== null;
    assert.deepEqual([v.botCategory, v.botName], ['search', name], ua);
    assert.equal(v.botVerified, listed ? 'unverified' : 'unverifiable', name);
    assert.equal(shouldIngestForAttribution('pixel', v), !listed, name);
  }
  // The same bots from their operators' own ranges are 'verified' and skipped.
  for (const [ua, name, ip] of [[UA.googlebotSmartphone, 'Googlebot', IP.google], [UA.bingbot, 'Bingbot', IP.bing]] as const) {
    const v = classifyVisitor(ua, ip, M);
    assert.deepEqual([v.botName, v.botVerified, shouldIngestForAttribution('pixel', v)], [name, 'verified', false], name);
  }
});

test('pixel: user-initiated AI agents and fetchers are ingested', () => {
  const cases: Case[] = [
    ['ChatGPT-User from its range', UA.chatgptUser, IP.chatgptUser, 'ai', 'ChatGPT-User (OpenAI)'],
    ['plain Chrome UA from the broad 9.129.0.0/16 ChatGPT-User range', UA.chromeMac, IP.chatgptUserBroad, 'ai', 'ChatGPT-User (OpenAI)'],
    ['ChatGPT Agent (browses for a user)', UA.chatgptAgent, IP.chatgptUser, 'ai', 'ChatGPT Agent (OpenAI)'],
    ['Claude-User from its range', UA.claudeUser, IP.anthropic, 'ai', 'Claude-User (Anthropic)'],
    ['Perplexity-User via range with a plain UA', UA.chromeMac, IP.perplexityUser, 'ai', 'Perplexity-User'],
    ['Meta-ExternalFetcher', UA.metaFetcher, IP.hosting, 'ai', 'Meta-ExternalFetcher'],
    ['Diffbot-User (the /Diffbot/ rule names it Diffbot)', UA.diffbotUser, IP.hosting, 'ai', 'Diffbot'],
    ["plain UA from Anthropic's single list for all its bots (may be Claude-User)", UA.chromeMac, IP.anthropic, 'ai', 'Claude crawler (Anthropic)'],
  ];
  for (const c of cases) assert.equal(pixelGate(c), true, c[0]);
});

// Documented user-initiated agents that ua.ts has no rule for yet. They classify
// as human or `other` today; a new rule that files one as a crawler fails here.
test('pixel: user-initiated agents with no UA rule yet are ingested', () => {
  const cases: Array<[label: string, ua: string, ip: string]> = [
    ['Claude-Agent from its own IP list', UA.claudeAgent, IP.claudeAgent],
    ['Amzn-User', UA.amznUser, IP.hosting],
    ['Gemini Notebook from the user-triggered range', UA.geminiNotebook, IP.googleUserTriggered],
    ['Gemini Notebook from an unlisted IP', UA.geminiNotebook, IP.hosting],
    ['ChatGPT Work cloud browser: a plain browser UA (it signs requests, no UA token)', UA.chromeMac, IP.hosting],
  ];
  for (const [label, ua, ip] of cases) {
    const v = classifyVisitor(ua, ip, M);
    assert.equal(shouldIngestForAttribution('pixel', v), true, `${label} (${v.botCategory} / ${v.botName})`);
  }
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
  // A search verdict with no range check behind it is not enough to skip.
  assert.equal(shouldIngestForAttribution('pixel', { isBot: true, botCategory: 'search', botName: 'Googlebot' }), true);
  assert.equal(shouldIngestForAttribution('pixel', { isBot: true, botCategory: 'search', botName: 'Googlebot', botVerified: null }), true);
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
  ['Google-NotebookLM', 'Google AI Agent', true], // former token, supported until August 2026
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
