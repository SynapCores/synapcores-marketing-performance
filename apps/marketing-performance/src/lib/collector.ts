/**
 * First-party beacon → warehouse mapping.
 *
 * Translates a batch posted by `public/track.js` (the ported EcommTracker
 * beacon) into the recipe-121 source rows the warehouse already ingests. This
 * is the clean-room replacement for Adaptus's `EcommTrackerModule.js`: it uses
 * only built-ins (no `uuid`, no `ua-parser-js`, no `express`, no `mysql`), so
 * none of Adaptus's flagged dependency tree comes along.
 *
 * Pure functions only — no `server-only`, no DB — so the mapping is unit
 * testable on its own. The route handler (`/api/v1/collect`) owns auth + the
 * actual writes.
 */

/** One event inside a beacon batch (shape produced by `EcommTracker.track`). */
export interface BeaconEvent {
  name?: string;
  timestamp?: number;
  data?: Record<string, unknown>;
  queryParams?: Record<string, unknown>;
}

/** The POST body `public/track.js` sends to the collector. */
export interface BeaconBatch {
  siteId?: string;
  userId?: string | null;
  sessionId?: string | null;
  timestamp?: number;
  url?: string;
  referrer?: string;
  title?: string;
  userAgent?: string;
  /** navigator.language, e.g. 'en-US'. */
  language?: string | null;
  /** IANA zone from Intl, e.g. 'America/New_York'. */
  timezone?: string | null;
  viewport?: { width?: number | null; height?: number | null };
  screen?: { width?: number | null; height?: number | null };
  /**
   * End-user IP — honoured ONLY on the authenticated server-to-server path
   * (sk_ key), where the request's own IP is the customer's server. Ignored
   * for browser beacons, whose IP comes from the proxy-appended XFF hop.
   */
  ip?: string | null;
  events?: BeaconEvent[];
}

/** Source-shaped record buckets, keyed by the warehouse source id (see sources.ts). */
export interface MappedBatch {
  clickstream: Array<Record<string, unknown>>;
  identity: Array<Record<string, unknown>>;
  conversions: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
}

// Event-name sets (lowercased). A landing/navigation touch becomes a click
// event; a purchase, lead or sign-up becomes a conversion; an identify (or a
// sign-up that carries a customer id) resolves anon → customer.
export const TOUCH_EVENTS = new Set(['page_view', 'pageview', 'page', 'navigation', 'session_start', 'landing']);
export const PURCHASE_EVENTS = new Set(['purchase', 'order_completed', 'order', 'conversion', 'checkout_completed']);
export const LEAD_EVENTS = new Set(['lead', 'generate_lead']);
export const SIGNUP_EVENTS = new Set(['signup', 'sign_up', 'complete_registration', 'registration_complete']);
const IDENTIFY_EVENTS = new Set(['identify', 'identified', 'login', ...SIGNUP_EVENTS]);
// Funnel steps between a visit and a conversion. Not conversions and not
// attribution touches: they live in `pm_events` (with their properties) and
// feed the funnel report (see visitor/funnel.ts).
export const VIEW_PRICING_EVENTS = new Set(['view_pricing', 'pricing_view']);
export const BEGIN_CHECKOUT_EVENTS = new Set(['begin_checkout', 'initiate_checkout', 'checkout_started', 'checkout']);

/**
 * `recipe_pm_conversions.event_name` values. Only `first_purchase` is a paying
 * customer: attribution / CAC / ROAS count it alone (see ATTRIBUTION in
 * recipe-sql.ts); `lead` and `signup` are reported as conversions alongside it.
 */
export const CONVERSION_PURCHASE = 'first_purchase';
export const CONVERSION_LEAD = 'lead';
export const CONVERSION_SIGNUP = 'signup';
export const NON_PURCHASE_CONVERSIONS = [CONVERSION_LEAD, CONVERSION_SIGNUP] as const;

/** Coarse device class from a User-Agent — enough for the clickstream `device` column. */
export function uaToDevice(ua: string | undefined): string {
  const s = (ua ?? '').toLowerCase();
  if (/ipad|tablet|playbook|silk/.test(s) || (/android/.test(s) && !/mobile/.test(s))) return 'tablet';
  if (/mobi|iphone|ipod|android.*mobile|windows phone/.test(s)) return 'mobile';
  return 'desktop';
}

/** Epoch-ms or date string → 'YYYY-MM-DD HH:MM:SS' (UTC), the warehouse timestamp format. */
export function toSqlTs(input: number | string | undefined): string {
  const d = input == null ? new Date() : new Date(input);
  const ts = Number.isNaN(d.getTime()) ? new Date() : d;
  return ts.toISOString().slice(0, 19).replace('T', ' ');
}

/** Pathname from a full URL, defaulting to '/'. */
export function pathFromUrl(url: string | undefined): string {
  if (!url) return '/';
  try {
    return new URL(url).pathname || '/';
  } catch {
    // Already a path, or malformed — take the leading path-looking segment.
    const m = /^(\/[^?#]*)/.exec(url);
    return m?.[1] ?? '/';
  }
}

/**
 * Host (domain) from a full URL, or null. This is the `site` dimension that
 * lets one pixel/collector serve several of your domains and still tell their
 * traffic apart — `shop.acme.com` vs `acme.io` vs `blog.acme.com`. `landing_path`
 * alone collides across domains (every site has a `/`), so the host is what
 * makes per-domain analysis possible.
 */
export function hostFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  if (v == null || v === '') return null;
  return String(v);
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** First non-empty paid click id across the known platforms. */
function firstClickId(qp: Record<string, unknown>): string | null {
  for (const k of ['fbclid', 'gclid', 'ttclid', 'msclkid', 'click_id', 'clickId']) {
    const v = str(qp[k]);
    if (v) return v;
  }
  return null;
}

/**
 * Map one beacon batch into source-shaped record buckets.
 *
 * `anonymous_id` is the beacon's first-party cookie id (`batch.userId`) — kept
 * consistent across clickstream / identity / conversions so recipe 121's
 * attribution join on `anonymous_id` lights up.
 */
export function mapBatch(batch: BeaconBatch): MappedBatch {
  const out: MappedBatch = { clickstream: [], identity: [], conversions: [], orders: [] };
  const anonymousId = str(batch.userId);
  if (!anonymousId) return out; // no first-party id → nothing attributable
  const device = uaToDevice(batch.userAgent);
  const site = hostFromUrl(batch.url); // the domain this pixel fired on

  for (const ev of batch.events ?? []) {
    const name = (ev.name ?? '').toLowerCase();
    const qp = (ev.queryParams ?? {}) as Record<string, unknown>;
    const data = (ev.data ?? {}) as Record<string, unknown>;
    const occurredAt = toSqlTs(ev.timestamp ?? batch.timestamp);

    if (TOUCH_EVENTS.has(name)) {
      out.clickstream.push({
        anonymous_id: anonymousId,
        occurred_at: occurredAt,
        landing_path: str(data.path) ?? str(data.url) ?? pathFromUrl(batch.url),
        utm_source: str(qp.utm_source),
        utm_medium: str(qp.utm_medium),
        utm_campaign: str(qp.utm_campaign),
        click_id: firstClickId(qp),
        device,
        site,
      });
    }

    const conversion = PURCHASE_EVENTS.has(name) ? CONVERSION_PURCHASE
      : LEAD_EVENTS.has(name) ? CONVERSION_LEAD
      : SIGNUP_EVENTS.has(name) ? CONVERSION_SIGNUP
      : null;
    if (conversion) {
      // Same shape (and the same no-dedupe semantics) for all three: one row per
      // event. Leads / sign-ups only carry revenue if the site sent a value.
      out.conversions.push({
        anonymous_id: anonymousId,
        occurred_at: occurredAt,
        event_name: conversion,
        revenue: num(data.revenue ?? data.value ?? data.total ?? data.amount),
        site,
      });
    }

    if (IDENTIFY_EVENTS.has(name)) {
      const customerId = num(data.customer_id ?? data.customerId ?? data.userId ?? data.user_id);
      if (customerId != null) {
        out.identity.push({
          anonymous_id: anonymousId,
          customer_id: customerId,
          identified_at: occurredAt,
        });
      }
    }
  }
  return out;
}
