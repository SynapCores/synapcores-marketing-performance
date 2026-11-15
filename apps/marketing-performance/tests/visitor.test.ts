/**
 * Visitor capture: IP handling, UA/bot parsing, GeoIP, event mapping,
 * retention and privacy signals. Run: pnpm test (tsc → node --test).
 *
 * The GeoIP reader test uses a real DB-IP City Lite file when one is available
 * (GEOIP_TEST_DB, else GEOIP_DB_PATH, else the production default path) and is
 * skipped otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { clientIpFromHeaders, ipToBytes, isPrivateIp, normalizeIp, truncateIp } from '../src/lib/visitor/ip';
import { parseUserAgent } from '../src/lib/visitor/ua';
import { EMPTY_GEO, shapeCityRecord, geoDbPath } from '../src/lib/visitor/geo';
import { MmdbReader } from '../src/lib/visitor/mmdb';
import { buildEventRows, encodeProps, eventTime, primaryLanguage, referrerDomain, PM_EVENT_COLUMNS } from '../src/lib/visitor/events';
import { applyRetention, retentionCutoff, retentionDays, sweepIntervalMs, truncationSql } from '../src/lib/visitor/retention';
import { mustDropForPrivacy } from '../src/lib/visitor/privacy';
import { visitorSource } from '../src/lib/visitor/source';
import { mapBatch, type BeaconBatch } from '../src/lib/collector';

const H = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70',
  firefoxLinux: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  samsungTablet: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  chatgptUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  claudebot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  perplexity: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  ccbot: 'CCBot/2.0 (https://commoncrawl.org/faq/)',
  bytespider: 'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
  googleExtended: 'Mozilla/5.0 (compatible; Google-Extended)',
  metaAgent: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  amazonbot: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/600.2.5 (KHTML, like Gecko) Version/8.0.2 Safari/600.2.5 (Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)',
  googlebot: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.69 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bingbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
  fbPreview: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  ahrefs: 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
  headless: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
  curl: 'curl/8.5.0',
  python: 'python-requests/2.32.3',
  unknownBot: 'Mozilla/5.0 (compatible; FooCrawler/3.1; +https://foo.example/bot)',
  fbInApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.40.98;FBBV/123]',
};

// ── IP ───────────────────────────────────────────────────────────────────────
test('normalizeIp handles ports, brackets, zones and IPv4-mapped IPv6', () => {
  assert.equal(normalizeIp('203.0.113.9'), '203.0.113.9');
  assert.equal(normalizeIp('203.0.113.9:443'), '203.0.113.9');
  assert.equal(normalizeIp('[2001:DB8::1]:8443'), '2001:db8::1');
  assert.equal(normalizeIp('::ffff:198.51.100.7'), '198.51.100.7');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp('unknown'), null);
  assert.equal(normalizeIp('not-an-ip'), null);
  assert.equal(normalizeIp(''), null);
});

test('clientIpFromHeaders trusts only the proxy-appended hop', () => {
  // Client forged "1.1.1.1"; Apache appended the real peer last.
  assert.equal(clientIpFromHeaders(H({ 'x-forwarded-for': '1.1.1.1, 203.0.113.50' })), '203.0.113.50');
  assert.equal(clientIpFromHeaders(H({ 'x-forwarded-for': '203.0.113.50' })), '203.0.113.50');
  // Two trusted hops (e.g. CDN + Apache) → second from the right.
  assert.equal(clientIpFromHeaders(H({ 'x-forwarded-for': '9.9.9.9, 203.0.113.50, 10.0.0.2' }), 2), '203.0.113.50');
  assert.equal(clientIpFromHeaders(H({ 'x-real-ip': '198.51.100.1' })), '198.51.100.1');
  assert.equal(clientIpFromHeaders(H({})), null);
  assert.equal(clientIpFromHeaders(H({ 'x-forwarded-for': 'garbage' })), null);
});

test('ipToBytes parses v4, compressed v6 and embedded-v4 v6', () => {
  assert.deepEqual(ipToBytes('1.2.3.4'), [1, 2, 3, 4]);
  assert.deepEqual(ipToBytes('::1'), [...Array(15).fill(0), 1]);
  assert.deepEqual(ipToBytes('2001:db8::'), [0x20, 0x01, 0x0d, 0xb8, ...Array(12).fill(0)]);
  assert.deepEqual(ipToBytes('64:ff9b::1.2.3.4')!.slice(12), [1, 2, 3, 4]);
  assert.equal(ipToBytes('nope'), null);
});

test('isPrivateIp classifies reserved ranges', () => {
  for (const ip of ['10.1.2.3', '192.168.0.1', '172.16.5.5', '127.0.0.1', '100.64.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1'])
    assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '100.51.180.101', '172.32.0.1', '2001:4860:4860::8888'])
    assert.equal(isPrivateIp(ip), false, ip);
});

test('truncateIp cuts IPv4 to /24 and IPv6 to /48', () => {
  assert.equal(truncateIp('203.0.113.77'), '203.0.113.0');
  assert.equal(truncateIp('2001:db8:abcd:12:34::5'), '2001:db8:abcd::');
  assert.equal(truncateIp('2001:db8::1'), '2001:db8:0::');
  assert.equal(truncateIp('::ffff:198.51.100.7'), '198.51.100.0');
  assert.equal(truncateIp(null), null);
  assert.equal(truncateIp('bogus'), null);
});

// ── UA / bots ────────────────────────────────────────────────────────────────
test('parseUserAgent: real browsers are human with browser/OS/device', () => {
  const c = parseUserAgent(UA.chromeMac);
  assert.deepEqual([c.browser, c.browserVersion, c.os, c.osVersion, c.deviceType, c.isBot], ['Chrome', '131', 'macOS', '10.15', 'desktop', false]);
  const s = parseUserAgent(UA.safariIphone);
  assert.deepEqual([s.browser, s.browserVersion, s.os, s.osVersion, s.deviceType, s.isBot], ['Mobile Safari', '18.1', 'iOS', '18.1', 'mobile', false]);
  const e = parseUserAgent(UA.edgeWin);
  assert.deepEqual([e.browser, e.os, e.osVersion, e.deviceType], ['Edge', 'Windows', '10/11', 'desktop']);
  const f = parseUserAgent(UA.firefoxLinux);
  assert.deepEqual([f.browser, f.browserVersion, f.os, f.deviceType], ['Firefox', '133', 'Ubuntu', 'desktop']);
  const t = parseUserAgent(UA.samsungTablet);
  assert.deepEqual([t.browser, t.os, t.osVersion, t.deviceType], ['Samsung Internet', 'Android', '14', 'tablet']);
  const a = parseUserAgent(UA.chromeAndroid);
  assert.deepEqual([a.browser, a.os, a.deviceType, a.isBot], ['Chrome', 'Android', 'mobile', false]);
  const fb = parseUserAgent(UA.fbInApp);
  assert.deepEqual([fb.browser, fb.os, fb.isBot], ['Facebook in-app', 'iOS', false]);
});

test('parseUserAgent: AI crawlers and agents are flagged as ai bots', () => {
  const cases: Array<[string, RegExp]> = [
    [UA.gptbot, /GPTBot/], [UA.chatgptUser, /ChatGPT-User/], [UA.claudebot, /ClaudeBot/],
    [UA.perplexity, /PerplexityBot/], [UA.ccbot, /CCBot/], [UA.bytespider, /Bytespider/],
    [UA.googleExtended, /Google-Extended/], [UA.metaAgent, /Meta-ExternalAgent/], [UA.amazonbot, /Amazonbot/],
  ];
  for (const [ua, name] of cases) {
    const p = parseUserAgent(ua);
    assert.equal(p.isBot, true, ua);
    assert.equal(p.botCategory, 'ai', ua);
    assert.match(p.botName ?? '', name);
    assert.equal(p.deviceType, 'bot');
  }
});

test('parseUserAgent: search, social, seo, headless, tools and unknown bots', () => {
  assert.deepEqual([parseUserAgent(UA.googlebot).botName, parseUserAgent(UA.googlebot).botCategory], ['Googlebot', 'search']);
  assert.equal(parseUserAgent(UA.bingbot).botCategory, 'search');
  assert.equal(parseUserAgent(UA.fbPreview).botCategory, 'social');
  assert.equal(parseUserAgent(UA.ahrefs).botCategory, 'seo');
  const h = parseUserAgent(UA.headless);
  assert.deepEqual([h.isBot, h.botCategory, h.deviceType], [true, 'headless', 'desktop']);
  assert.equal(parseUserAgent(UA.curl).botName, 'curl');
  assert.equal(parseUserAgent(UA.python).botCategory, 'tool');
  const u = parseUserAgent(UA.unknownBot);
  assert.deepEqual([u.isBot, u.botName, u.botCategory], [true, 'FooCrawler', 'other']);
  const empty = parseUserAgent('');
  assert.equal(empty.isBot, true);
});

// ── GeoIP ────────────────────────────────────────────────────────────────────
test('shapeCityRecord maps a GeoIP2-City record', () => {
  const g = shapeCityRecord({
    city: { names: { en: 'Ashburn' } },
    country: { iso_code: 'US', names: { en: 'United States' } },
    subdivisions: [{ names: { en: 'Virginia' } }],
    location: { latitude: 39.0438, longitude: -77.4874 },
  });
  assert.deepEqual(g, { country: 'US', countryName: 'United States', region: 'Virginia', city: 'Ashburn', latitude: 39, longitude: -77.5, timezone: null });
  assert.deepEqual(shapeCityRecord(null), EMPTY_GEO);
});

const realDb = [process.env.GEOIP_TEST_DB, geoDbPath(), '/tmp/geoip-dl/dbip-city-lite.mmdb'].find((p) => p && existsSync(p));
test('MmdbReader resolves real IPs from the DB-IP City Lite file', { skip: !realDb && 'no GeoIP DB available' }, () => {
  const r = MmdbReader.open(realDb!);
  try {
    assert.equal(r.metadata.database_type, 'DBIP-City-Lite');
    const google = shapeCityRecord(r.get('8.8.8.8'));
    assert.equal(google.country, 'US');
    const v6 = shapeCityRecord(r.get('2001:4860:4860::8888'));
    assert.match(v6.country ?? '', /^[A-Z]{2}$/); // resolved (DB-IP's answer moves between releases)
    assert.ok(google.city, 'city resolved');
    assert.equal(r.get('10.0.0.1'), null);
  } finally {
    r.close();
  }
});

// ── event mapping ────────────────────────────────────────────────────────────
const batch: BeaconBatch = {
  siteId: 'pk_test',
  userId: 'anon-123',
  sessionId: 'sess-1',
  timestamp: Date.parse('2026-11-15T17:00:05Z'),
  url: 'https://www.synapcores.com/pricing?utm_source=newsletter&utm_medium=email&gclid=G1',
  referrer: 'https://www.google.com/search?q=vector+db',
  title: 'Pricing — SynapCores',
  userAgent: UA.chromeMac,
  language: 'en-US',
  timezone: 'America/New_York',
  viewport: { width: 1440, height: 900 },
  screen: { width: 2560, height: 1440 },
  events: [
    { name: 'pageview', timestamp: Date.parse('2026-11-15T17:00:00Z'), data: { title: 'Pricing — SynapCores', url: 'https://www.synapcores.com/pricing?utm_source=newsletter&utm_medium=email&gclid=G1', path: '/pricing', referrer: 'https://www.google.com/search?q=vector+db' }, queryParams: { utm_source: 'newsletter', utm_medium: 'email', gclid: 'G1' } },
    { name: 'navigation_click', timestamp: Date.parse('2026-11-15T17:00:04Z'), data: { text: 'Contact', href: '/contact', email: 'jane@example.com' } },
  ],
};

const ctx = {
  tenantId: 'tenant-A',
  pixelId: 'pk_test',
  sourceKind: 'pixel' as const,
  ip: '203.0.113.77',
  geo: { country: 'US', countryName: 'United States', region: 'Virginia', city: 'Ashburn', latitude: 39, longitude: -77.5, timezone: null },
  ua: parseUserAgent(UA.chromeMac),
  userAgent: UA.chromeMac,
  receivedAt: new Date('2026-11-15T17:00:06Z'),
  newId: (() => { let i = 0; return () => `ev-${++i}`; })(),
};

test('buildEventRows keeps every event, enriched, with all columns', () => {
  const rows = buildEventRows(batch, ctx);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), [...PM_EVENT_COLUMNS].sort());
  const [pv, click] = rows as unknown as [Record<string, unknown>, Record<string, unknown>];
  assert.equal(pv.event_id, 'ev-1');
  assert.equal(pv.tenant_id, 'tenant-A');
  assert.equal(pv.event_type, 'pageview');
  assert.equal(pv.occurred_at, '2026-11-15 17:00:00');
  assert.equal(pv.received_at, '2026-11-15 17:00:06');
  assert.equal(pv.page_path, '/pricing');
  assert.equal(pv.site, 'www.synapcores.com');
  assert.equal(pv.referrer_domain, 'google.com');
  assert.deepEqual([pv.utm_source, pv.utm_medium, pv.gclid, pv.fbclid], ['newsletter', 'email', 'G1', null]);
  assert.deepEqual([pv.browser, pv.os, pv.device_type, pv.is_bot], ['Chrome', 'macOS', 'desktop', false]);
  assert.deepEqual([pv.ip, pv.ip_prefix, pv.ip_truncated], ['203.0.113.77', '203.0.113.0', false]);
  assert.deepEqual([pv.country, pv.city, pv.timezone, pv.language], ['US', 'Ashburn', 'America/New_York', 'en-US']);
  assert.deepEqual([pv.screen_w, pv.screen_h, pv.viewport_w, pv.viewport_h], [2560, 1440, 1440, 900]);
  // Non-pageview events are kept too, with the batch page context + props.
  assert.equal(click.event_type, 'navigation_click');
  assert.equal(click.page_path, '/pricing');
  assert.equal(click.utm_source, 'newsletter'); // from the page URL
  const props = JSON.parse(String(click.properties));
  assert.equal(props.text, 'Contact');
  assert.equal(props.email, '[email]'); // e-mail addresses are redacted
});

test('buildEventRows: no first-party id → nothing; bot UA flagged; language falls back to header', () => {
  assert.deepEqual(buildEventRows({ ...batch, userId: null }, ctx), []);
  const botRows = buildEventRows({ ...batch, language: null, timezone: null }, { ...ctx, ua: parseUserAgent(UA.gptbot), userAgent: UA.gptbot, acceptLanguage: 'fr-CA,fr;q=0.9' });
  assert.deepEqual([botRows[0]!.is_bot, botRows[0]!.bot_category, botRows[0]!.language, botRows[0]!.timezone], [true, 'ai', 'fr-CA', null]);
});

test('eventTime clamps implausible client clocks to receipt time', () => {
  const rec = new Date('2026-11-15T12:00:00Z');
  assert.equal(eventTime(rec.getTime() - 1000, rec).toISOString(), '2026-11-15T11:59:59.000Z');
  assert.equal(eventTime(rec.getTime() + 3600_000, rec), rec); // future
  assert.equal(eventTime(rec.getTime() - 30 * 86400_000, rec), rec); // way past
  assert.equal(eventTime('garbage', rec), rec);
});

test('helpers: referrerDomain, primaryLanguage, encodeProps', () => {
  assert.equal(referrerDomain('https://www.Bing.com/search?q=x'), 'bing.com');
  assert.equal(referrerDomain('android-app://com.google.android.gm'), null);
  assert.equal(referrerDomain(''), null);
  assert.equal(primaryLanguage('pt-BR,pt;q=0.9,en;q=0.8'), 'pt-BR');
  assert.equal(primaryLanguage('*'), null);
  assert.equal(encodeProps({}), null);
  assert.match(encodeProps({ big: 'x'.repeat(10000) })!, /"_truncated":true/);
});

test('visitorSource: utm → click id → referral → direct', () => {
  assert.equal(visitorSource({ utm_source: 'newsletter', utm_medium: 'email' }), 'newsletter / email');
  assert.equal(visitorSource({ fbclid: 'x' }), 'facebook / paid');
  assert.equal(visitorSource({ referrer_domain: 'news.ycombinator.com', site: 'synapcores.com' }), 'news.ycombinator.com / referral');
  assert.equal(visitorSource({ referrer_domain: 'synapcores.com', site: 'www.synapcores.com' }), 'direct');
  assert.equal(visitorSource({}), 'direct');
});

// ── retention ────────────────────────────────────────────────────────────────
test('retention: configurable window, cutoff, SQL and semantics', () => {
  assert.equal(retentionDays({}), 90);
  assert.equal(retentionDays({ IP_RETENTION_DAYS: '30' }), 30);
  assert.equal(retentionDays({ IP_RETENTION_DAYS: 'abc' }), 90);
  assert.equal(retentionDays({ IP_RETENTION_DAYS: '0' }), 1);
  assert.equal(sweepIntervalMs({}), 6 * 3600_000);
  const cutoff = retentionCutoff(new Date('2026-11-15T00:00:00Z'), 90);
  assert.equal(cutoff, '2026-08-17 00:00:00');
  assert.equal(
    truncationSql(cutoff),
    "UPDATE pm_events SET ip = ip_prefix, ip_truncated = TRUE WHERE received_at < '2026-08-17 00:00:00' AND ip_truncated = FALSE",
  );
  assert.throws(() => truncationSql("2026-01-01'; DROP TABLE x; --"));
  const rows = [
    { id: 'old', ip: '203.0.113.77', ip_prefix: '203.0.113.0', ip_truncated: false, received_at: '2026-08-01 10:00:00' },
    { id: 'new', ip: '198.51.100.9', ip_prefix: '198.51.100.0', ip_truncated: false, received_at: '2026-11-01 10:00:00' },
    { id: 'v6', ip: '2001:db8:abcd:12::5', ip_prefix: '2001:db8:abcd::', ip_truncated: false, received_at: '2026-05-01 00:00:00' },
  ];
  const out = applyRetention(rows, cutoff);
  assert.deepEqual(out.map((r) => [r.id, r.ip, r.ip_truncated]), [
    ['old', '203.0.113.0', true],
    ['new', '198.51.100.9', false],
    ['v6', '2001:db8:abcd::', true],
  ]);
});

// ── privacy signals ──────────────────────────────────────────────────────────
test('DNT / GPC are honoured for renascai.com (default) and configurable hosts', () => {
  assert.equal(mustDropForPrivacy(H({ 'sec-gpc': '1' }), 'renascai.com', {}), true);
  assert.equal(mustDropForPrivacy(H({ dnt: '1' }), 'www.renascai.com', {}), true);
  assert.equal(mustDropForPrivacy(H({}), 'renascai.com', {}), false);
  assert.equal(mustDropForPrivacy(H({ dnt: '1' }), 'synapcores.com', {}), false);
  assert.equal(mustDropForPrivacy(H({ dnt: '1' }), 'synapcores.com', { COLLECT_PRIVACY_SIGNAL_HOSTS: '*' }), true);
});

// ── attribution feed is unchanged ────────────────────────────────────────────
test('mapBatch still feeds click events from page views only', () => {
  const m = mapBatch(batch);
  assert.equal(m.clickstream.length, 1);
  assert.equal(m.clickstream[0]!.landing_path, '/pricing');
  assert.equal(m.clickstream[0]!.click_id, 'G1');
  assert.equal(m.clickstream[0]!.site, 'www.synapcores.com');
});
