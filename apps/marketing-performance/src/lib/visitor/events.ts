/**
 * Beacon batch → raw `pm_events` rows (one row per event, nothing dropped).
 *
 * This is the "who is the visitor" side of the collector: every event the
 * pixel sends is kept with its page, referrer, campaign params, the parsed
 * User-Agent + bot verdict, the client IP (as seen through our proxy) and the
 * IP-derived approximate location. The recipe tables (click events /
 * conversions / identity) are still fed separately by `mapBatch`, except for
 * pixel batches from search, SEO and AI crawlers (see
 * `shouldIngestForAttribution`).
 *
 * Pure: enrichment inputs (IP, geo, parsed UA, clock, id generator) are passed
 * in, so this is unit tested without a database or GeoIP file.
 */
import { randomUUID } from 'node:crypto';
import type { BeaconBatch, CollectSourceKind } from '../collector';
import type { GeoInfo } from './geo';
import { truncateIp } from './ip';
import type { ParsedUA } from './ua';
import { CLASSIFIER_VERSION, type BotVerification } from './classify';

export const PM_EVENTS_TABLE = 'pm_events';

/** Column order for INSERTs (kept in sync with PM_EVENTS_DDL). */
export const PM_EVENT_COLUMNS = [
  'event_id', 'tenant_id', 'pixel_id', 'source_kind', 'anonymous_id', 'session_id',
  'occurred_at', 'received_at', 'event_type',
  'page_url', 'page_path', 'page_title', 'site', 'referrer', 'referrer_domain',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'ttclid', 'msclkid',
  'user_agent', 'browser', 'browser_version', 'os', 'os_version', 'device_type',
  'is_bot', 'bot_name', 'bot_category', 'bot_verified', 'bot_rules_version',
  'ip', 'ip_prefix', 'ip_truncated',
  'country', 'country_name', 'region', 'city', 'latitude', 'longitude', 'timezone',
  'language', 'screen_w', 'screen_h', 'viewport_w', 'viewport_h', 'properties',
] as const;
export type PmEventColumn = (typeof PM_EVENT_COLUMNS)[number];
export type PmEventRow = Record<PmEventColumn, string | number | boolean | null>;

export const PM_EVENTS_DDL = [
  `CREATE TABLE IF NOT EXISTS pm_events (
    event_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, pixel_id TEXT, source_kind TEXT,
    anonymous_id TEXT, session_id TEXT, occurred_at TIMESTAMP, received_at TIMESTAMP, event_type TEXT,
    page_url TEXT, page_path TEXT, page_title TEXT, site TEXT, referrer TEXT, referrer_domain TEXT,
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
    gclid TEXT, fbclid TEXT, ttclid TEXT, msclkid TEXT,
    user_agent TEXT, browser TEXT, browser_version TEXT, os TEXT, os_version TEXT, device_type TEXT,
    is_bot BOOLEAN, bot_name TEXT, bot_category TEXT, bot_verified TEXT, bot_rules_version INTEGER,
    ip TEXT, ip_prefix TEXT, ip_truncated BOOLEAN,
    country TEXT, country_name TEXT, region TEXT, city TEXT, latitude DOUBLE, longitude DOUBLE, timezone TEXT,
    language TEXT, screen_w INTEGER, screen_h INTEGER, viewport_w INTEGER, viewport_h INTEGER, properties TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_pm_events_tenant ON pm_events(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pm_events_anon ON pm_events(anonymous_id)`,
];

/** Columns added after the first release: ALTERed onto existing tables by ensureEventsTable. */
export const PM_EVENTS_ADDED_COLUMNS: Array<[string, string]> = [
  ['bot_verified', 'TEXT'],
  ['bot_rules_version', 'INTEGER'],
];

export interface EnrichContext {
  tenantId: string;
  pixelId: string | null;
  sourceKind: CollectSourceKind;
  ip: string | null;
  geo: GeoInfo;
  ua: ParsedUA & { botVerified?: BotVerification | null };
  userAgent: string | null;
  /** Accept-Language header, used when the beacon did not send navigator.language. */
  acceptLanguage?: string | null;
  receivedAt?: Date;
  newId?: () => string;
}

const MAX_PROPS_BYTES = 4096;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function str(v: unknown, max = 2048): string | null {
  if (v == null || v === '') return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function int(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 && n < 100000 ? Math.round(n) : null;
}

/** 'YYYY-MM-DD HH:MM:SS' UTC — the warehouse timestamp format. */
export function sqlTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Event time from the client clock, clamped: a beacon can't claim to be from
 * the future (>5 min) or older than 7 days — those fall back to receipt time.
 */
export function eventTime(ts: unknown, received: Date): Date {
  const n = typeof ts === 'number' ? ts : typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (!Number.isFinite(n)) return received;
  const skew = n - received.getTime();
  if (skew > 5 * 60_000 || skew < -7 * 24 * 3600_000) return received;
  return new Date(n);
}

export function parseUrl(u: string | null): URL | null {
  if (!u) return null;
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

/** Host of a referrer without a leading www. */
export function referrerDomain(ref: string | null): string | null {
  const u = parseUrl(ref);
  if (!u || !/^https?:$/.test(u.protocol)) return null;
  return u.hostname.replace(/^www\./, '').toLowerCase() || null;
}

/** First language tag of an Accept-Language header ('en-US,en;q=0.9' → 'en-US'). */
export function primaryLanguage(h: string | null | undefined): string | null {
  const tag = h?.split(',')[0]?.split(';')[0]?.trim();
  return tag && /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(tag) ? tag : null;
}

/** JSON-encode event properties: redact e-mail addresses, cap the size. */
export function encodeProps(data: unknown): string | null {
  if (data == null || typeof data !== 'object') return null;
  if (Object.keys(data as object).length === 0) return null;
  let s: string;
  try {
    s = JSON.stringify(data, (_k, v) => (typeof v === 'string' ? v.replace(EMAIL, '[email]') : v));
  } catch {
    return null;
  }
  if (s.length > MAX_PROPS_BYTES) return JSON.stringify({ _truncated: true, preview: s.slice(0, 1024) });
  return s;
}

const PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'ttclid', 'msclkid'] as const;

/** Build one `pm_events` row per beacon event. Empty when there's no first-party id. */
export function buildEventRows(batch: BeaconBatch, ctx: EnrichContext): PmEventRow[] {
  const received = ctx.receivedAt ?? new Date();
  const newId = ctx.newId ?? randomUUID;
  const anonymousId = str(batch.userId, 128);
  if (!anonymousId) return [];
  const ipPrefix = truncateIp(ctx.ip);
  const language = str(batch.language, 35) ?? primaryLanguage(ctx.acceptLanguage);
  const tz = str(batch.timezone, 64) ?? ctx.geo.timezone;

  return (batch.events ?? []).map((ev) => {
    const data = (ev && typeof ev.data === 'object' && ev.data) ? (ev.data as Record<string, unknown>) : {};
    const qp = (ev && typeof ev.queryParams === 'object' && ev.queryParams) ? (ev.queryParams as Record<string, unknown>) : {};
    const pageUrl = str(typeof data.url === 'string' && /^https?:/i.test(data.url) ? data.url : batch.url);
    const u = parseUrl(pageUrl);
    const param = (k: string) => str(qp[k], 512) ?? str(u?.searchParams.get(k) ?? null, 512);
    const referrer = str(typeof data.referrer === 'string' ? data.referrer : batch.referrer);
    const occurred = eventTime(ev?.timestamp ?? batch.timestamp, received);
    const row: PmEventRow = {
      event_id: newId(),
      tenant_id: ctx.tenantId,
      pixel_id: ctx.pixelId,
      source_kind: ctx.sourceKind,
      anonymous_id: anonymousId,
      session_id: str(batch.sessionId, 128),
      occurred_at: sqlTs(occurred),
      received_at: sqlTs(received),
      event_type: (str(ev?.name, 64) ?? 'unknown').toLowerCase(),
      page_url: pageUrl,
      page_path: str(typeof data.path === 'string' ? data.path : null, 1024) ?? (u ? u.pathname || '/' : null),
      page_title: str(typeof data.title === 'string' ? data.title : batch.title, 512),
      site: u ? u.host.toLowerCase() : null,
      referrer,
      referrer_domain: referrerDomain(referrer),
      utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null,
      gclid: null, fbclid: null, ttclid: null, msclkid: null,
      user_agent: str(ctx.userAgent, 1024),
      browser: ctx.ua.browser,
      browser_version: ctx.ua.browserVersion,
      os: ctx.ua.os,
      os_version: ctx.ua.osVersion,
      device_type: ctx.ua.deviceType,
      is_bot: ctx.ua.isBot,
      bot_name: ctx.ua.botName,
      bot_category: ctx.ua.botCategory,
      bot_verified: ctx.ua.isBot ? ctx.ua.botVerified ?? null : null,
      bot_rules_version: CLASSIFIER_VERSION,
      ip: ctx.ip,
      ip_prefix: ipPrefix,
      ip_truncated: false,
      country: ctx.geo.country,
      country_name: ctx.geo.countryName,
      region: ctx.geo.region,
      city: ctx.geo.city,
      latitude: ctx.geo.latitude,
      longitude: ctx.geo.longitude,
      timezone: tz,
      language,
      screen_w: int(batch.screen?.width),
      screen_h: int(batch.screen?.height),
      viewport_w: int(batch.viewport?.width),
      viewport_h: int(batch.viewport?.height),
      properties: encodeProps(data),
    };
    for (const k of PARAMS) row[k] = param(k);
    return row;
  });
}
