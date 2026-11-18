/**
 * Visitor kinds (internal / bot / suspected / human), UTM campaign report +
 * link builder, and track.js session attribution.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

import { CidrList, parseCidrList, rulesFromEnv } from '../src/lib/visitor/traffic-rules';
import { classifyKinds, parseKind, type VisitorProfile } from '../src/lib/visitor/kinds';
import { hostingLabel } from '../src/lib/visitor/asn';
import { buildCampaignReport, buildCampaignUrl, campaignKey, type SavedCampaign, type TouchRow } from '../src/lib/visitor/campaigns';

const RULES = rulesFromEnv({
  VISITOR_INTERNAL_IPS: '136.57.16.0/24 office, 100.51.180.101 agentNet\n98.121.244.0/24 Pineville; bogus, 2001:db8::/32 v6lab',
  VISITOR_DATACENTER_IPS: '203.0.113.0/24 test-dc',
});

test('traffic rules: parse CIDR lists with labels, match v4/v6/mapped, most specific wins', () => {
  assert.equal(RULES.internal.size, 4); // 'bogus' dropped
  assert.equal(RULES.internal.match('136.57.16.80')?.label, 'office');
  assert.equal(RULES.internal.match('::ffff:136.57.16.9')?.label, 'office');
  assert.equal(RULES.internal.match('100.51.180.101')?.label, 'agentNet');
  assert.equal(RULES.internal.match('100.51.180.102'), null);
  assert.equal(RULES.internal.match('2001:db8::1')?.label, 'v6lab');
  assert.equal(RULES.internal.match('8.8.8.8'), null);
  assert.equal(RULES.internal.match(null), null);
  const l = new CidrList(parseCidrList('10.0.0.0/8 wide, 10.1.2.0/24 narrow'));
  assert.equal(l.match('10.1.2.3')?.label, 'narrow');
  assert.equal(RULES.burstMin, 5);
  assert.equal(RULES.burstWindowS, 60);
  assert.equal(rulesFromEnv({ VISITOR_BURST_MIN: '1' }).burstMin, 5); // out of range → default
});

const base = (id: string, over: Partial<VisitorProfile> = {}): VisitorProfile => ({
  anonymous_id: id, first_seen: '2026-11-17 19:53:54', site: 'werkor.us', any_bot: false, pageviews: 1, interactions: 0,
  ips: ['50.203.161.6'], source_key: 'youtube', browser: 'Chrome', os: 'Windows', device_type: 'desktop', screen: '1920x1080', ...over,
});

test('kinds: the 2026-11-17 YouTube burst (17 single-page Windows/Chrome 1920×1080 in ~1 s) is suspected', () => {
  const burst = Array.from({ length: 17 }, (_, i) => base(`b${i}`, { first_seen: `2026-11-17 19:53:5${4 + (i % 2)}`, ips: [`136.22.14${i % 9}.7`] }));
  const real = base('real', { first_seen: '2026-11-17 21:00:00' }); // same device, an hour later
  const k = classifyKinds([...burst, real], RULES);
  assert.equal(burst.filter((p) => k.get(p.anonymous_id)?.kind === 'suspected').length, 17);
  assert.match(k.get('b0')!.reason!, /burst: \d+\+ single-page visitors within 60s · youtube · Chrome\/Windows 1920x1080/);
  assert.equal(k.get('real')?.kind, 'human');
});

test('kinds: no burst below the threshold, or when visitors interact / browse', () => {
  const four = Array.from({ length: 4 }, (_, i) => base(`f${i}`));
  assert.ok([...classifyKinds(four, RULES).values()].every((v) => v.kind === 'human'));
  const engaged = Array.from({ length: 6 }, (_, i) => base(`e${i}`, { interactions: i === 0 ? 0 : 1 }));
  assert.ok([...classifyKinds(engaged, RULES).values()].every((v) => v.kind === 'human'));
  const spread = Array.from({ length: 6 }, (_, i) => base(`s${i}`, { first_seen: `2026-11-17 19:5${i}:00` })); // 1 per minute
  assert.ok([...classifyKinds(spread, RULES).values()].every((v) => v.kind === 'human'));
  const mixedScreens = Array.from({ length: 6 }, (_, i) => base(`m${i}`, { screen: `${1200 + i}x800` }));
  assert.ok([...classifyKinds(mixedScreens, RULES).values()].every((v) => v.kind === 'human'));
});

test('kinds: precedence internal > bot > suspected; data centres by ASN and by configured ranges', () => {
  const asn = (ip: string) => (ip.startsWith('3.216.') ? { asn: 14618, org: 'AMAZON-AES' } : ip.startsWith('17.') ? { asn: 13335, org: 'Cloudflare, Inc.' } : null);
  const k = classifyKinds([
    base('office', { ips: ['136.57.16.80'], any_bot: true }),
    base('gbot', { ips: ['66.249.66.1'], any_bot: true }),
    base('aws', { ips: ['3.216.230.219'], source_key: 'google.com', browser: 'Chrome', os: 'Linux', screen: '1280x720' }),
    base('dc', { ips: ['203.0.113.9'], screen: '1x1' }),
    base('relay', { ips: ['17.1.2.3'], screen: '2x2' }),
    base('pineville', { ips: ['8.8.4.4', '98.121.244.181'], screen: '3x3' }),
  ], RULES, asn);
  assert.deepEqual(k.get('office'), { kind: 'internal', reason: 'internal IP office' });
  assert.equal(k.get('gbot')?.kind, 'bot');
  assert.deepEqual(k.get('aws'), { kind: 'suspected', reason: 'data centre: AWS' });
  assert.deepEqual(k.get('dc'), { kind: 'suspected', reason: 'data centre: test-dc' });
  assert.equal(k.get('relay')?.kind, 'human'); // privacy relays are people
  assert.equal(k.get('pineville')?.kind, 'internal'); // any internal IP of the visitor
});

test('hostingLabel: known ASNs and hosting-sounding orgs; ISPs and relays are not hosting', () => {
  assert.equal(hostingLabel({ asn: 16509, org: 'AMAZON-02' }), 'AWS');
  assert.equal(hostingLabel({ asn: 132203, org: 'Tencent' }), 'Tencent Cloud');
  assert.equal(hostingLabel({ asn: 99999, org: 'Example Hosting LLC' }), 'Example Hosting LLC');
  assert.equal(hostingLabel({ asn: 7922, org: 'Comcast Cable Communications, LLC' }), null);
  assert.equal(hostingLabel({ asn: 13335, org: 'Cloudflare, Inc.' }), null);
  assert.equal(hostingLabel(null), null);
});

test('parseKind defaults to human; accepts the five options', () => {
  assert.equal(parseKind(undefined), 'human');
  assert.equal(parseKind('nope'), 'human');
  for (const k of ['human', 'internal', 'suspected', 'bot', 'all']) assert.equal(parseKind(k), k);
});

test('buildCampaignUrl: tags, keeps other params, replaces old utm, validates', () => {
  const r = buildCampaignUrl({ siteUrl: 'werkor.us/pricing?ref=x&utm_source=old', source: ' youtube ', medium: 'video', campaign: 'test jarvis', content: '05-estimates' });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.url, 'https://werkor.us/pricing?ref=x&utm_source=youtube&utm_medium=video&utm_campaign=test-jarvis&utm_content=05-estimates');
  assert.equal(r.site, 'werkor.us');
  assert.equal(buildCampaignUrl({ siteUrl: 'https://www.Werkor.us/', source: 'a', medium: 'b', campaign: 'c' }).ok && 'ok', 'ok');
  const www = buildCampaignUrl({ siteUrl: 'https://www.Werkor.us/', source: 'a', medium: 'b', campaign: 'c' });
  assert.equal(www.ok && www.site, 'werkor.us');
  assert.equal(buildCampaignUrl({ siteUrl: '', source: 'a', medium: 'b', campaign: 'c' }).ok, false);
  assert.equal(buildCampaignUrl({ siteUrl: 'https://werkor.us', source: 'a', medium: '', campaign: 'c' }).ok, false);
  assert.equal(buildCampaignUrl({ siteUrl: 'javascript:alert(1)', source: 'a', medium: 'b', campaign: 'c' }).ok, false);
  assert.equal(buildCampaignUrl({ siteUrl: 'localhost', source: 'a', medium: 'b', campaign: 'c' }).ok, false);
});

const touch = (anon: string, over: Partial<TouchRow> = {}): TouchRow => ({
  site: 'werkor.us', utm_source: 'youtube', utm_medium: 'video', utm_campaign: 'tutorials', utm_content: '01-onboarding',
  anonymous_id: anon, session_id: `s-${anon}`, first_at: '2026-11-17 19:53:54', pageviews: 1, ...over,
});
const saved = (over: Partial<SavedCampaign> = {}): SavedCampaign => ({
  campaign_id: 'c1', name: 'Tutorials', channel: 'youtube', site: 'werkor.us', site_url: 'https://werkor.us/', utm_source: 'youtube', utm_medium: 'video',
  utm_campaign: 'tutorials', utm_content: null, utm_term: null, tagged_url: 'https://werkor.us/?utm_source=youtube', notes: null, created_at: '2026-11-18 10:00:00', ...over,
});

test('campaign report: tracked vs untracked vs no traffic, conversions after first touch, filtered-out count', () => {
  const touches = [
    touch('h1'), touch('h1', { session_id: 's2', first_at: '2026-11-18 09:00:00', utm_content: '02-jobs' }),
    touch('h2', { utm_source: 'YouTube' }), // case-insensitive same campaign
    touch('bot1'),
    touch('r1', { utm_source: 'reddit', utm_medium: 'social', utm_campaign: 'launch', site: 'www.werkor.us' }),
  ];
  const conversions = [
    { anonymous_id: 'h1', event_type: 'sign_up', first_at: '2026-11-18 09:05:00' },
    { anonymous_id: 'h2', event_type: 'lead', first_at: '2026-11-01 00:00:00' }, // before the touch → not counted
    { anonymous_id: 'r1', event_type: 'purchase', first_at: '2026-11-18 00:00:00' },
  ];
  const rows = buildCampaignReport(touches, conversions, [saved(), saved({ campaign_id: 'c2', name: 'Empty', utm_campaign: 'spring' })], (id) => id !== 'bot1');
  const by = new Map(rows.map((r) => [r.key, r]));
  const tut = by.get(campaignKey('werkor.us', 'youtube', 'video', 'tutorials'))!;
  assert.equal(tut.status, 'tracked');
  assert.equal(tut.visitors, 2);
  assert.equal(tut.sessions, 3);
  assert.equal(tut.signups, 1);
  assert.equal(tut.leads, 0);
  assert.equal(tut.excluded, 1);
  assert.deepEqual(tut.contents, ['01-onboarding', '02-jobs']);
  const launch = by.get(campaignKey('werkor.us', 'reddit', 'social', 'launch'))!;
  assert.equal(launch.status, 'untracked');
  assert.equal(launch.purchases, 1);
  const spring = by.get(campaignKey('werkor.us', 'youtube', 'video', 'spring'))!;
  assert.equal(spring.status, 'no traffic yet');
  assert.equal(spring.visitors, 0);
  assert.equal(rows[0]!.key, tut.key); // most visitors first
});

// ── track.js: campaign params persist for the session; SPA landing hand-over ──
const SRC = readFileSync(join(__dirname, '..', '..', 'public', 'track.js'), 'utf8');

function page(url: string, store: Map<string, string>, landing?: { url: string; path?: string }) {
  const sent: Array<{ events: Array<{ name: string; queryParams: Record<string, string>; data: Record<string, string> }> }> = [];
  class FakeXHR {
    status = 200; statusText = ''; response = '';
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    open() {} setRequestHeader() {} getResponseHeader() { return null; }
    send(body: string) { sent.push(JSON.parse(body)); this.onload?.(); }
  }
  const u = new URL(url);
  const noop = () => {};
  const el = () => ({ addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], getAttribute: () => null });
  let tick: (() => void) | null = null;
  const sandbox: Record<string, unknown> = {
    location: { href: u.href, pathname: u.pathname, search: u.search, hostname: u.hostname, origin: u.origin },
    document: { currentScript: null, readyState: 'complete', title: 't', referrer: '', cookie: '', addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], body: el(), documentElement: { lang: 'en' }, createElement: el, getElementsByTagName: () => [] },
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    innerWidth: 1, innerHeight: 1, screen: { width: 1, height: 1 }, addEventListener: noop,
    navigator: { userAgent: 'test', language: 'en' }, XMLHttpRequest: FakeXHR, URL,
    setInterval: (fn: () => void) => { tick = fn; return 1; }, setTimeout: () => 1, clearTimeout: noop, clearInterval: noop,
    console, Date, Math, JSON, Intl, Promise, Set, Object, Array, String, Number, parseInt, parseFloat,
    IntersectionObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} },
    EcommTrackerLanding: landing,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SRC, sandbox);
  const T = sandbox.EcommTracker as { init(c: object): void; track(n: string, d?: object): void };
  T.init({ endpoint: '/c', siteId: 'pk_x', automaticEvents: false, autoTrackProductViews: false, autoTrackAddToCart: false, autoTrackCheckout: false, autoTrackPurchase: false });
  return { T, sent, flush: () => tick?.() };
}

test('track.js: landing UTM is kept for the session and sent with later pages and conversions', () => {
  const store = new Map<string, string>();
  const p1 = page('https://werkor.us/?utm_source=youtube&utm_medium=video&utm_campaign=test-jarvis&x=1', store);
  p1.flush();
  assert.equal(p1.sent[0]!.events[0]!.queryParams.utm_campaign, 'test-jarvis');
  const p2 = page('https://werkor.us/pricing/', store);
  p2.T.track('sign_up', { plan: 'crew' });
  p2.flush();
  const evs = p2.sent.flatMap((b) => b.events);
  assert.ok(evs.length >= 2);
  for (const e of evs) {
    assert.equal(e.queryParams.utm_source, 'youtube');
    assert.equal(e.queryParams.utm_campaign, 'test-jarvis');
    assert.equal(e.queryParams.x, undefined); // only campaign keys persist
  }
  // A new campaign link in the same tab replaces the old one.
  const p3 = page('https://werkor.us/?utm_source=reddit&utm_medium=social&utm_campaign=launch', store);
  p3.flush();
  assert.equal(p3.sent[0]!.events[0]!.queryParams.utm_source, 'reddit');
  assert.equal(p3.sent[0]!.events[0]!.queryParams.utm_content, undefined);
});

test('track.js: an SPA hands over its original landing URL (address already rewritten to /)', () => {
  const store = new Map<string, string>();
  const p = page('https://werkor.us/', store, { url: 'https://werkor.us/app?utm_source=youtube&utm_medium=video&utm_campaign=tutorials', path: '/app' });
  p.flush();
  const pv = p.sent[0]!.events[0]!;
  assert.equal(pv.name, 'pageview');
  assert.equal(pv.data.path, '/app');
  assert.equal(pv.data.url, 'https://werkor.us/app?utm_source=youtube&utm_medium=video&utm_campaign=tutorials');
  assert.equal(pv.queryParams.utm_campaign, 'tutorials');
  // Cross-origin landing URLs are ignored for the page URL.
  const q = page('https://werkor.us/', new Map(), { url: 'https://evil.example/?utm_source=x&utm_medium=y&utm_campaign=z' });
  q.flush();
  assert.equal(q.sent[0]!.events[0]!.data.url, 'https://werkor.us/');
});
