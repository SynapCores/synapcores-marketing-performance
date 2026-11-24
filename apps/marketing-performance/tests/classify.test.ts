/**
 * Human vs bot classification from UA + published crawler IP ranges.
 * Uses the bundled range snapshot (real operator data) and real-world UAs,
 * including the 66.249.x Nexus 5X Googlebot/GoogleOther traffic that used to
 * be counted as human.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import bundled from '../src/lib/visitor/crawler-ranges.bundled.json';
import { CrawlerMatcher, RANGE_SOURCES, parseCidr, parsePrefixes, type RangeSet } from '../src/lib/visitor/crawler-ranges';
import { CLASSIFIER_VERSION, botLabel, classifyVisitor } from '../src/lib/visitor/classify';
import { botOperator, parseUserAgent } from '../src/lib/visitor/ua';
import { buildEventRows, PM_EVENT_COLUMNS } from '../src/lib/visitor/events';
import { EMPTY_GEO } from '../src/lib/visitor/geo';

const M = new CrawlerMatcher(bundled as RangeSet);

const NEXUS = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Mobile Safari/537.36';
const UA = {
  googlebotSmartphone: `${NEXUS} (compatible; Googlebot/2.1; +http://www.google.com/bot.html)`,
  googleOtherSmartphone: `${NEXUS} (compatible; GoogleOther)`,
  inspectionTool: `${NEXUS} (compatible; Google-InspectionTool/1.0;)`,
  googleRendererPlain: NEXUS, // Google's renderer with no bot token
  googlebotDesktop: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/153.0.8010.52 Safari/537.36',
  googleOtherDesktop: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GoogleOther) Chrome/153.0.8010.52 Safari/537.36',
  adsbot: 'AdsBot-Google (+http://www.google.com/adsbot.html)',
  adsbotMobile: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1 (compatible; AdsBot-Google-Mobile; +http://www.google.com/mobile/adsbot.html)',
  mediapartners: 'Mediapartners-Google',
  apisGoogle: 'APIs-Google (+https://developers.google.com/webmasters/APIs-Google.html)',
  feedfetcher: 'FeedFetcher-Google; (+http://www.google.com/feedfetcher.html)',
  storebot: 'Mozilla/5.0 (X11; Linux x86_64; Storebot-Google/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36',
  bingbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/136.0.0.0 Safari/537.36',
  applebot: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
  duckduckbot: 'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
  yandex: 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
  baidu: 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  oaiSearch: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
  chatgptUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  claudebot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  claudeUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
  claudeSearch: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)',
  perplexityBot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  perplexityUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
  ccbot: 'CCBot/2.0 (https://commoncrawl.org/faq/)',
  bytespider: 'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
  amazonbot: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/600.2.5 (KHTML, like Gecko) Version/8.0.2 Safari/600.2.5 (Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)',
  metaAgent: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  fbHit: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  ahrefs: 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
  semrush: 'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
  mj12: 'Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)',
  dotbot: 'Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot; help@moz.com)',
  headless: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
  curl: 'curl/8.5.0',
  python: 'python-requests/2.32.3',
  go: 'Go-http-client/2.0',
  shapbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ShapBot/0.1.0',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Mobile/15E148 Safari/604.1',
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:159.0) Gecko/20100101 Firefox/159.0',
};
const RESIDENTIAL = '136.57.16.80';

// ── the reported case ────────────────────────────────────────────────────────
test('66.249.x Nexus 5X GoogleOther / Googlebot smartphone is a verified Google bot, not a human', () => {
  for (const ip of ['66.249.67.33', '66.249.66.12', '66.249.66.204']) {
    const c = classifyVisitor(UA.googleOtherSmartphone, ip, M);
    assert.deepEqual([c.isBot, c.botName, c.botVerified, c.deviceType], [true, 'GoogleOther', 'verified', 'bot'], ip);
  }
  const g = classifyVisitor(UA.googlebotSmartphone, '66.249.67.34', M);
  assert.deepEqual([g.isBot, g.botName, g.botCategory, g.botVerified], [true, 'Googlebot', 'search', 'verified']);
  assert.equal(botLabel(g.botName, g.botVerified), 'verified Googlebot');
});

test('a normal browser UA from a crawler range is still a bot (Google renderer)', () => {
  const c = classifyVisitor(UA.googleRendererPlain, '66.249.66.75', M);
  assert.deepEqual([c.isBot, c.botName, c.botVerified, c.deviceType], [true, 'Googlebot', 'verified', 'bot']);
  const chrome = classifyVisitor(UA.chromeMac, '66.249.66.1', M);
  assert.equal(chrome.isBot, true);
  const v6 = classifyVisitor(UA.chromeMac, '2001:4860:4801:10::5', M);
  assert.deepEqual([v6.isBot, v6.botVerified], [true, 'verified']);
  const mapped = classifyVisitor(UA.chromeMac, '::ffff:66.249.66.1', M);
  assert.equal(mapped.isBot, true);
  // Headless Chrome from Google's ranges is Google's renderer, named after the range.
  const h = classifyVisitor(UA.headless, '66.249.66.1', M);
  assert.deepEqual([h.isBot, h.botName, h.botVerified], [true, 'Googlebot', 'verified']);
});

test('spoofed crawler UAs are bots labelled "claims X, unverified"', () => {
  const cases: Array<[string, string]> = [
    [UA.googlebotSmartphone, 'Googlebot'], [UA.googleOtherDesktop, 'GoogleOther'], [UA.bingbot, 'Bingbot'],
    [UA.gptbot, 'GPTBot (OpenAI)'], [UA.claudebot, 'ClaudeBot (Anthropic)'], [UA.perplexityBot, 'PerplexityBot'],
    [UA.applebot, 'Applebot'],
  ];
  for (const [ua, name] of cases) {
    const c = classifyVisitor(ua, RESIDENTIAL, M);
    assert.deepEqual([c.isBot, c.botName, c.botVerified], [true, name, 'unverified'], ua);
    assert.equal(botLabel(c.botName, c.botVerified), `claims ${name}, unverified`);
  }
  // Claims Googlebot but comes from Bing's range: still unverified as Googlebot.
  assert.equal(classifyVisitor(UA.googlebotDesktop, '157.55.39.10', M).botVerified, 'unverified');
});

test('genuine crawlers from their published ranges are verified', () => {
  const cases: Array<[string, string, string]> = [
    [UA.googlebotDesktop, '66.249.66.1', 'Googlebot'],
    [UA.inspectionTool, '66.249.66.1', 'Google-InspectionTool'],
    [UA.bingbot, '65.55.210.48', 'Bingbot'],
    [UA.bingbot, '157.55.39.10', 'Bingbot'],
    [UA.gptbot, '132.196.86.5', 'GPTBot (OpenAI)'],
    [UA.claudebot, '216.73.216.10', 'ClaudeBot (Anthropic)'],
    [UA.perplexityBot, '107.20.236.150', 'PerplexityBot'],
    [UA.applebot, '17.241.208.161', 'Applebot'],
  ];
  for (const [ua, ip, name] of cases) {
    const c = classifyVisitor(ua, ip, M);
    assert.deepEqual([c.isBot, c.botName, c.botVerified], [true, name, 'verified'], `${name} ${ip}`);
  }
});

test('bots without a published list are bots, "unverifiable"', () => {
  for (const ua of [UA.yandex, UA.baidu, UA.ahrefs, UA.semrush, UA.mj12, UA.dotbot, UA.curl, UA.python, UA.go, UA.shapbot, UA.bytespider, UA.amazonbot, UA.metaAgent, UA.fbHit]) {
    const c = classifyVisitor(ua, '34.31.203.120', M);
    assert.deepEqual([c.isBot, c.botVerified], [true, 'unverifiable'], ua);
  }
});

test('real browsers from ordinary IPs stay human', () => {
  for (const [ua, ip] of [[UA.chromeMac, RESIDENTIAL], [UA.safariIphone, '176.54.64.146'], [UA.firefoxWin, '145.40.134.189'], [UA.chromeMac, '43.134.221.183']] as const) {
    const c = classifyVisitor(ua, ip, M);
    assert.deepEqual([c.isBot, c.botName, c.botVerified], [false, null, null], `${ua} ${ip}`);
  }
  // No IP at all: UA only.
  assert.equal(classifyVisitor(UA.chromeMac, null, M).isBot, false);
  assert.equal(classifyVisitor(UA.googleOtherSmartphone, null, M).isBot, true);
  // No matcher (ranges unavailable): UA verdict only, claims unverifiable.
  assert.deepEqual([classifyVisitor(UA.googlebotSmartphone, '66.249.66.1', null).isBot, classifyVisitor(UA.googlebotSmartphone, '66.249.66.1', null).botVerified], [true, 'unverifiable']);
});

// ── UA table ─────────────────────────────────────────────────────────────────
test('parseUserAgent names every documented crawler token', () => {
  const expect: Array<[string, string, string | null]> = [
    [UA.googleOtherSmartphone, 'GoogleOther', 'google'],
    [UA.inspectionTool, 'Google-InspectionTool', 'google'],
    [UA.adsbot, 'AdsBot-Google', 'google'],
    [UA.adsbotMobile, 'AdsBot-Google', 'google'],
    [UA.mediapartners, 'Mediapartners-Google (AdSense)', 'google'],
    [UA.apisGoogle, 'APIs-Google', 'google'],
    [UA.feedfetcher, 'FeedFetcher-Google', 'google'],
    [UA.storebot, 'Storebot-Google', 'google'],
    [UA.duckduckbot, 'DuckDuckBot', 'duckduckgo'],
    [UA.yandex, 'YandexBot', null],
    [UA.baidu, 'Baiduspider', null],
    [UA.oaiSearch, 'OAI-SearchBot (OpenAI)', 'openai'],
    [UA.chatgptUser, 'ChatGPT-User (OpenAI)', 'openai'],
    [UA.claudeUser, 'Claude-User (Anthropic)', 'anthropic'],
    [UA.claudeSearch, 'Claude-SearchBot (Anthropic)', 'anthropic'],
    [UA.perplexityUser, 'Perplexity-User', 'perplexity'],
    [UA.ccbot, 'CCBot (Common Crawl)', 'commoncrawl'],
    [UA.bytespider, 'Bytespider (ByteDance)', null],
    [UA.amazonbot, 'Amazonbot', null],
    [UA.metaAgent, 'Meta-ExternalAgent', null],
    [UA.fbHit, 'Facebook link preview', null],
    [UA.semrush, 'SemrushBot', null],
    [UA.mj12, 'MJ12bot (Majestic)', null],
    [UA.dotbot, 'DotBot (Moz)', null],
    [UA.go, 'Go HTTP client', null],
    [UA.headless, 'HeadlessChrome', null],
  ];
  for (const [ua, name, op] of expect) {
    const p = parseUserAgent(ua);
    assert.equal(p.isBot, true, ua);
    assert.equal(p.botName, name, ua);
    assert.equal(botOperator(p.botName), op, name);
  }
});

// ── ranges ───────────────────────────────────────────────────────────────────
test('bundled range snapshot covers every source and 66.249.64.0/19', () => {
  for (const s of RANGE_SOURCES) assert.ok(((bundled as RangeSet).sources[s.id] ?? []).length > 0, s.id);
  assert.ok(M.size > 1000);
  assert.equal(M.lookup('66.249.64.1')?.operator, 'google');
  assert.equal(M.lookup('8.8.8.8'), null);
  assert.equal(M.lookup('not-an-ip'), null);
});

test('CrawlerMatcher: v4/v6 CIDRs, most specific source wins, junk ignored', () => {
  const m = new CrawlerMatcher({
    fetchedAt: '2026-11-15T00:00:00Z',
    sources: { 'google-common': ['10.0.0.0/8', '2001:db8::/32', 'garbage', '1.2.3.4/40'], 'openai-gptbot': ['10.1.2.0/24'], 'nope': ['11.0.0.0/8'] },
  });
  assert.equal(m.lookup('10.9.9.9')?.sourceId, 'google-common');
  assert.equal(m.lookup('10.1.2.3')?.sourceId, 'openai-gptbot');
  assert.equal(m.lookup('2001:db8:1::1')?.label, 'Googlebot');
  assert.equal(m.lookup('11.0.0.1'), null); // unknown source id
  assert.equal(m.hasOperator('google'), true);
  assert.equal(m.hasOperator('bing'), false);
  assert.equal(m.size, 3);
  assert.equal(parseCidr('300.1.1.1/8'), null);
  assert.deepEqual(parsePrefixes({ prefixes: [{ ipv4Prefix: '1.2.3.0/24' }, { ipv6Prefix: '2001:db8::/48' }, { ipv4Prefix: 'x' }, {}] }), ['1.2.3.0/24', '2001:db8::/48']);
  assert.deepEqual(parsePrefixes(null), []);
});

test('buildEventRows stores the verification and classifier version', () => {
  const ua = classifyVisitor(UA.googleOtherSmartphone, '66.249.67.33', M);
  const rows = buildEventRows(
    { siteId: 'pk_x', userId: 'anon-1', sessionId: 's1', url: 'https://example.com/', events: [{ name: 'pageview', timestamp: Date.now() }] } as never,
    { tenantId: 't1', pixelId: 'pk_x', sourceKind: 'pixel', ip: '66.249.67.33', geo: EMPTY_GEO, ua, userAgent: UA.googleOtherSmartphone },
  );
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.deepEqual([r.is_bot, r.bot_name, r.bot_verified, r.bot_rules_version], [true, 'GoogleOther', 'verified', CLASSIFIER_VERSION]);
  assert.ok(PM_EVENT_COLUMNS.includes('bot_verified'));
  const human = buildEventRows(
    { siteId: 'pk_x', userId: 'anon-2', events: [{ name: 'pageview' }] } as never,
    { tenantId: 't1', pixelId: null, sourceKind: 'pixel', ip: RESIDENTIAL, geo: EMPTY_GEO, ua: classifyVisitor(UA.chromeMac, RESIDENTIAL, M), userAgent: UA.chromeMac },
  )[0]!;
  assert.deepEqual([human.is_bot, human.bot_verified], [false, null]);
});
