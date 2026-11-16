/**
 * Collector gap: lead / signup / begin_checkout / view_pricing from the
 * voiceagent.synapcores.com pixel (voice-service tracking-core.ts eventCalls).
 *
 * - every one lands in pm_events with its properties (buildEventRows)
 * - lead + signup become recipe_pm_conversions rows (mapBatch), like purchase
 * - begin_checkout + view_pricing are funnel steps only (no warehouse rows)
 * - the funnel report counts each step per distinct visitor
 * - attribution counts purchases only (leads/sign-ups don't inflate CAC/ROAS)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapBatch, type BeaconBatch } from '../src/lib/collector';
import { buildEventRows } from '../src/lib/visitor/events';
import { parseUserAgent } from '../src/lib/visitor/ua';
import { buildFunnel, funnelStep, FUNNEL_EVENT_TYPES, FUNNEL_STEPS } from '../src/lib/visitor/funnel';
import { ATTRIBUTION } from '../src/lib/recipe-sql';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const T0 = Date.parse('2026-11-16T13:00:00Z');

/** One batch per event, shaped exactly as voice-service's EcommTracker.track calls produce. */
function vsBatch(name: string, data: Record<string, unknown>, userId = 'anon-vs-1'): BeaconBatch {
  return {
    siteId: 'pk_aQU5gM3yLd4YTwrpdVXGBB4g',
    userId,
    sessionId: 'sess-1',
    timestamp: T0,
    url: 'https://voiceagent.synapcores.com/roofers?utm_source=fb&utm_campaign=c1',
    userAgent: UA,
    events: [{ name, timestamp: T0, data }],
  };
}

const ctx = () => ({
  tenantId: 'tenant-A',
  pixelId: 'pk_aQU5gM3yLd4YTwrpdVXGBB4g',
  sourceKind: 'pixel' as const,
  ip: '203.0.113.77',
  geo: { country: 'US', countryName: 'United States', region: null, city: null, latitude: null, longitude: null, timezone: null },
  ua: parseUserAgent(UA),
  userAgent: UA,
  receivedAt: new Date(T0 + 1000),
  newId: (() => { let i = 0; return () => `ev-${++i}`; })(),
});

// Exact payloads from voice-service apps/portal/src/marketing/tracking-core.ts (PR #168).
const PAYLOADS = {
  lead: { method: 'demo_call', event_id: 'ev_e3f41ed17952444fb0646ce009b41102' },
  signup: { method: 'email', event_id: 'ev_signup0001' },
  begin_checkout: { plan: 'pro', value: 99, currency: 'USD' },
  view_pricing: { page: 'roofers' },
} as const;

// ── persistence: pm_events keeps the event and its properties ───────────────
for (const [name, data] of Object.entries(PAYLOADS)) {
  test(`${name}: stored in pm_events with event_type and full properties`, () => {
    const rows = buildEventRows(vsBatch(name, { ...data }), ctx());
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(r.event_type, name);
    assert.equal(r.site, 'voiceagent.synapcores.com');
    assert.equal(r.anonymous_id, 'anon-vs-1');
    assert.equal(r.utm_campaign, 'c1');
    assert.deepEqual(JSON.parse(String(r.properties)), data);
  });
}

// ── warehouse mapping ───────────────────────────────────────────────────────
test('lead → one conversion row (event_name lead, no revenue), nothing else', () => {
  const m = mapBatch(vsBatch('lead', { ...PAYLOADS.lead }));
  assert.deepEqual(m.conversions, [{
    anonymous_id: 'anon-vs-1', occurred_at: '2026-11-16 13:00:00', event_name: 'lead', revenue: null, site: 'voiceagent.synapcores.com',
  }]);
  assert.equal(m.clickstream.length + m.identity.length + m.orders.length, 0);
});

test('signup → one conversion row (event_name signup); identity only when a customer id is sent', () => {
  const m = mapBatch(vsBatch('signup', { ...PAYLOADS.signup }));
  assert.deepEqual(m.conversions.map((c) => [c.event_name, c.revenue, c.site]), [['signup', null, 'voiceagent.synapcores.com']]);
  assert.equal(m.identity.length, 0, 'voice-service sends no customer id at sign-up (no account enumeration)');
  const withId = mapBatch(vsBatch('sign_up', { method: 'email', customer_id: 42 }));
  assert.equal(withId.conversions[0]!.event_name, 'signup');
  assert.deepEqual(withId.identity.map((i) => i.customer_id), [42]);
});

test('voice-service complete_registration fires signup + lead (same event_id) → two conversions, one per type', () => {
  const b = vsBatch('signup', {});
  b.events = [
    { name: 'signup', timestamp: T0, data: { method: 'email', event_id: 'ev_x' } },
    { name: 'lead', timestamp: T0, data: { method: 'signup', event_id: 'ev_x' } },
  ];
  assert.deepEqual(mapBatch(b).conversions.map((c) => c.event_name), ['signup', 'lead']);
});

test('lead / signup with a value carry it as revenue (same parsing as purchase)', () => {
  assert.equal(mapBatch(vsBatch('lead', { value: '25.50' })).conversions[0]!.revenue, 25.5);
  assert.equal(mapBatch(vsBatch('generate_lead', { value: 10 })).conversions[0]!.event_name, 'lead');
});

test('begin_checkout → funnel step only: no conversion, no click touch, no identity', () => {
  const m = mapBatch(vsBatch('begin_checkout', { ...PAYLOADS.begin_checkout }));
  assert.deepEqual(m, { clickstream: [], identity: [], conversions: [], orders: [] });
  assert.equal(funnelStep('begin_checkout'), 'begin_checkout');
  assert.equal(funnelStep('initiate_checkout'), 'begin_checkout');
});

test('view_pricing → funnel step only: no conversion, no click touch (would steal last-touch credit)', () => {
  const m = mapBatch(vsBatch('view_pricing', { ...PAYLOADS.view_pricing }));
  assert.deepEqual(m, { clickstream: [], identity: [], conversions: [], orders: [] });
  assert.equal(funnelStep('VIEW_PRICING'), 'view_pricing');
});

test('purchase is unchanged: first_purchase with revenue; identify still resolves', () => {
  const b = vsBatch('identify', { customer_id: 7 });
  b.events!.push({ name: 'purchase', timestamp: T0, data: { order_id: 'ev_p', revenue: 99, value: 99, currency: 'USD' } });
  const m = mapBatch(b);
  assert.deepEqual(m.conversions.map((c) => [c.event_name, c.revenue]), [['first_purchase', 99]]);
  assert.deepEqual(m.identity.map((i) => i.customer_id), [7]);
});

test('idempotency matches purchase: a re-sent batch maps to the same rows again (no dedupe at this layer)', () => {
  for (const name of ['purchase', 'lead', 'signup']) {
    const b = vsBatch(name, { event_id: 'ev_same', value: 1 });
    assert.deepEqual(mapBatch(b).conversions, mapBatch(b).conversions);
    assert.equal(mapBatch(b).conversions.length, 1);
  }
});

// ── funnel report ───────────────────────────────────────────────────────────
test('funnel: steps in order, distinct visitors per step, conversions flagged, per-site split', () => {
  assert.deepEqual(FUNNEL_STEPS.map((s) => s.id), ['visit', 'view_pricing', 'lead', 'signup', 'begin_checkout', 'purchase']);
  assert.deepEqual(FUNNEL_STEPS.filter((s) => s.conversion).map((s) => s.id), ['lead', 'signup', 'purchase']);
  for (const n of ['pageview', 'page_view', 'view_pricing', 'lead', 'signup', 'begin_checkout', 'purchase']) assert.ok(FUNNEL_EVENT_TYPES.includes(n), n);

  const VA = 'voiceagent.synapcores.com';
  const f = buildFunnel([
    { site: VA, event_type: 'pageview', anonymous_id: 'a', events: 3 },
    { site: VA, event_type: 'page_view', anonymous_id: 'a', events: 1 }, // alias: still one visitor
    { site: VA, event_type: 'pageview', anonymous_id: 'b', events: 1 },
    { site: VA, event_type: 'pageview', anonymous_id: 'c', events: 1 },
    { site: VA, event_type: 'pageview', anonymous_id: 'd', events: 1 },
    { site: VA, event_type: 'view_pricing', anonymous_id: 'a', events: 1 },
    { site: VA, event_type: 'view_pricing', anonymous_id: 'b', events: 1 },
    { site: VA, event_type: 'lead', anonymous_id: 'a', events: 2 },
    { site: VA, event_type: 'signup', anonymous_id: 'a', events: 1 },
    { site: VA, event_type: 'begin_checkout', anonymous_id: 'a', events: 1 },
    { site: 'synapcores.com', event_type: 'pageview', anonymous_id: 'z', events: 1 },
    { site: VA, event_type: 'scroll_depth', anonymous_id: 'a', events: 9 }, // not a funnel event
  ]);
  const by = Object.fromEntries(f.steps.map((s) => [s.id, s]));
  assert.deepEqual(
    f.steps.map((s) => [s.id, s.visitors]),
    [['visit', 5], ['view_pricing', 2], ['lead', 1], ['signup', 1], ['begin_checkout', 1], ['purchase', 0]],
  );
  assert.equal(by.visit!.events, 8); // 3+1+1+1+1 on voiceagent + 1 on synapcores.com
  assert.equal(by.lead!.events, 2);
  assert.equal(by.view_pricing!.pct_of_visits, 40);
  assert.equal(by.lead!.pct_of_visits, 20);
  assert.deepEqual(f.sites.map((s) => [s.site, s.steps[0]!.visitors]), [[VA, 4], ['synapcores.com', 1]]);
  assert.equal(f.sites[0]!.steps.find((s) => s.id === 'view_pricing')!.pct_of_visits, 50);
});

test('funnel: empty input → zeros and no percentages', () => {
  const f = buildFunnel([]);
  assert.ok(f.steps.every((s) => s.visitors === 0 && s.pct_of_visits === null));
  assert.deepEqual(f.sites, []);
});

// ── attribution only credits purchases ──────────────────────────────────────
test('ATTRIBUTION excludes lead/signup conversions and filters on projected columns only', () => {
  const sql = ATTRIBUTION.replace(/\s+/g, ' ');
  assert.match(sql, /WHERE rn = 1 AND COALESCE\(event_name, 'first_purchase'\) NOT IN \('lead', 'signup'\)/);
  // The window SELECT must not carry its own WHERE on base-table columns (engine applies it after projection).
  const windowSelect = sql.slice(sql.indexOf('ROW_NUMBER()'), sql.indexOf('FROM ( SELECT v.conversion_id'));
  assert.doesNotMatch(windowSelect, /WHERE/);
  assert.match(sql, /\) touches \) ranked/);
});
