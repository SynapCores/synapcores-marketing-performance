import 'server-only';
import { getAdminClient } from '@synapcores/app-framework/db/server';
import { PM_EVENTS_ADDED_COLUMNS, PM_EVENTS_DDL, PM_EVENT_COLUMNS, sqlTs, type PmEventRow } from './visitor/events';
import { CLASSIFIER_VERSION, classifyVisitor, type Classification } from './visitor/classify';
import type { CrawlerMatcher } from './visitor/crawler-ranges';
import { retentionCutoff, retentionDays, truncationSql } from './visitor/retention';
import { visitorSource } from './visitor/source';
import { buildFunnel, FUNNEL_EVENT_TYPES, FUNNEL_STEPS, type FunnelReport } from './visitor/funnel';
import { classifyKinds, kindMatches, PASSIVE_EVENTS, type KindFilter, type KindVerdict, type VisitorKind, type VisitorProfile } from './visitor/kinds';
import { trafficRules } from './visitor/traffic-rules';
import { lookupAsn } from './visitor/asn';
import { buildCampaignReport, type CampaignReportRow, type ConversionRow, type SavedCampaign, type TouchRow } from './visitor/campaigns';
import { randomUUID } from 'node:crypto';

/**
 * Raw visitor events (`pm_events`) — writes from the collector, retention
 * sweep, and the tenant-scoped reads behind the Visitors pages + dashboard.
 *
 * Every read takes the workspace's tenant id and filters on it; values from the
 * request go through bound parameters ($n), never string concatenation.
 */

const db = () => getAdminClient();
type Row = Record<string, unknown>;

let ensured: Promise<void> | null = null;
export function ensureEventsTable(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      for (const ddl of PM_EVENTS_DDL) await db().sql(ddl);
      for (const [col, type] of PM_EVENTS_ADDED_COLUMNS) {
        try {
          await db().sql(`SELECT ${col} FROM pm_events LIMIT 1`);
        } catch {
          await db().sql(`ALTER TABLE pm_events ADD COLUMN ${col} ${type}`);
        }
      }
    })().catch((e) => {
      ensured = null;
      throw e;
    });
  }
  return ensured;
}

function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  // Standard SQL literal: the engine treats backslash literally, so doubling
  // single quotes is a complete escape. NULs are stripped.
  return `'${String(v).replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}

/** Insert enriched rows in one multi-row statement. Returns rows written. */
export async function insertEvents(rows: PmEventRow[]): Promise<number> {
  if (!rows.length) return 0;
  await ensureEventsTable();
  const values = rows.map((r) => '(' + PM_EVENT_COLUMNS.map((c) => lit(r[c])).join(',') + ')').join(',');
  await db().sql(`INSERT INTO pm_events (${PM_EVENT_COLUMNS.join(',')}) VALUES ${values}`);
  return rows.length;
}

/** Retention sweep: full IP → /24 or /48 prefix for events older than the window. */
export async function truncateExpiredIps(now = new Date()): Promise<{ cutoff: string; days: number; updated: number }> {
  await ensureEventsTable();
  const days = retentionDays();
  const cutoff = retentionCutoff(now, days);
  const res = await db().sql(truncationSql(cutoff));
  // The engine answers an UPDATE with a single [[count]] row.
  const first = res.rows[0] ? Object.values(res.rows[0] as Row)[0] : undefined;
  const updated = Number(typeof first === 'number' ? first : res.rowCount) || 0;
  return { cutoff, days, updated };
}

// ── reads ────────────────────────────────────────────────────────────────────
export interface VisitorFilters {
  kind?: KindFilter;
  site?: string | null;
  country?: string | null;
  from?: string | null; // YYYY-MM-DD
  to?: string | null; // YYYY-MM-DD (inclusive)
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function whereClause(tenantId: string, f: VisitorFilters): { sql: string; params: unknown[] } {
  const params: unknown[] = [tenantId];
  const parts = ['tenant_id = $1'];
  const add = (cond: string, v: unknown) => {
    params.push(v);
    parts.push(cond.replace('?', `$${params.length}`));
  };
  if (f.site) add('site = ?', f.site);
  if (f.country) add('country = ?', f.country.toUpperCase());
  if (f.from && DAY.test(f.from)) add('occurred_at >= ?', `${f.from} 00:00:00`);
  if (f.to && DAY.test(f.to)) add('occurred_at <= ?', `${f.to} 23:59:59`);
  return { sql: parts.join(' AND '), params };
}

export interface VisitorSummary {
  anonymous_id: string;
  first_seen: string;
  last_seen: string;
  events: number;
  sessions: number;
  pageviews: number;
  pages: number;
  is_bot: boolean;
  bot_name: string | null;
  bot_category: string | null;
  bot_verified: string | null;
  ip: string | null;
  ip_truncated: boolean;
  country: string | null;
  country_name: string | null;
  region: string | null;
  city: string | null;
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  device_type: string | null;
  site: string | null;
  landing_path: string | null;
  source: string;
  kind: VisitorKind;
  kind_reason: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
}

function placeholders(start: number, n: number): string {
  return Array.from({ length: n }, (_, i) => `$${start + i}`).join(',');
}

const asStr = (v: unknown) => (v == null ? null : String(v));
const asBool = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

export async function listVisitors(tenantId: string, f: VisitorFilters, limit = 200): Promise<VisitorSummary[]> {
  await ensureEventsTable();
  const w = whereClause(tenantId, f);
  const lim = Math.max(1, Math.min(500, Math.floor(limit)));
  const kindF: KindFilter = f.kind ?? 'all';
  const [agg, ctx] = await Promise.all([
    db().sql<Row>(
      `SELECT anonymous_id, MIN(occurred_at) AS first_seen, MAX(occurred_at) AS last_seen, COUNT(*) AS events,
              COUNT(DISTINCT session_id) AS sessions,
              SUM(CASE WHEN event_type = 'pageview' OR event_type = 'page_view' THEN 1 ELSE 0 END) AS pageviews,
              COUNT(DISTINCT page_path) AS pages,
              MAX(CASE WHEN is_bot = TRUE THEN 1 ELSE 0 END) AS any_bot
         FROM pm_events WHERE ${w.sql}
        GROUP BY anonymous_id ORDER BY last_seen DESC LIMIT ${MAX_VISITORS}`,
      w.params,
    ),
    visitorContext(tenantId),
  ]);
  const utmWanted = f.utm_source || f.utm_medium || f.utm_campaign;
  const lc = (v: unknown) => (v == null ? '' : String(v).toLowerCase());
  const utmOk = (id: string) =>
    !utmWanted ||
    (ctx.touches.get(id) ?? []).some(
      (t) => (!f.utm_source || lc(t.utm_source) === lc(f.utm_source)) && (!f.utm_medium || lc(t.utm_medium) === lc(f.utm_medium)) && (!f.utm_campaign || lc(t.utm_campaign) === lc(f.utm_campaign)),
    );
  const kept = agg.rows
    .filter((r) => {
      const id = String(r.anonymous_id);
      const k = ctx.kinds.get(id)?.kind ?? (Number(r.any_bot ?? 0) > 0 ? 'bot' : 'human');
      return kindMatches(kindF, k) && utmOk(id);
    })
    .slice(0, lim);
  const ids = kept.map((r) => String(r.anonymous_id));
  if (!ids.length) return [];
  const inList = placeholders(2, ids.length);
  // NB: tenant_id must be in the inner projection — SynapCores CE applies the
  // inner WHERE after projecting a window-function subquery.
  const latest = await db().sql<Row>(
    `SELECT * FROM (SELECT tenant_id, anonymous_id, ip, ip_truncated, country, country_name, region, city, browser, browser_version, os,
            device_type, is_bot, bot_name, bot_category, bot_verified, site,
            ROW_NUMBER() OVER (PARTITION BY anonymous_id ORDER BY is_bot DESC, occurred_at DESC) AS rn
       FROM pm_events WHERE tenant_id = $1 AND anonymous_id IN (${inList})) z WHERE rn = 1`,
    [tenantId, ...ids],
  );
  const first = await db().sql<Row>(
    `SELECT * FROM (SELECT tenant_id, anonymous_id, site, page_path, referrer_domain, utm_source, utm_medium, utm_campaign, utm_content, gclid, fbclid, ttclid, msclkid,
            ROW_NUMBER() OVER (PARTITION BY anonymous_id ORDER BY occurred_at ASC) AS rn
       FROM pm_events WHERE tenant_id = $1 AND anonymous_id IN (${inList})) z WHERE rn = 1`,
    [tenantId, ...ids],
  );
  const L = new Map(latest.rows.map((r) => [String(r.anonymous_id), r]));
  const F = new Map(first.rows.map((r) => [String(r.anonymous_id), r]));
  return kept.map((a) => {
    const id = String(a.anonymous_id);
    const l = L.get(id) ?? {};
    const fr = F.get(id) ?? {};
    const isBot = Number(a.any_bot ?? 0) > 0;
    const verdict: KindVerdict = ctx.kinds.get(id) ?? { kind: isBot ? 'bot' : 'human', reason: null };
    const touch = (ctx.touches.get(id) ?? [])[0];
    return {
      anonymous_id: id,
      first_seen: String(a.first_seen ?? ''),
      last_seen: String(a.last_seen ?? ''),
      events: Number(a.events ?? 0),
      sessions: Number(a.sessions ?? 0),
      pageviews: Number(a.pageviews ?? 0),
      pages: Number(a.pages ?? 0),
      is_bot: isBot,
      bot_name: asStr(l.bot_name),
      bot_category: asStr(l.bot_category),
      bot_verified: asStr(l.bot_verified),
      ip: asStr(l.ip),
      ip_truncated: asBool(l.ip_truncated),
      country: asStr(l.country),
      country_name: asStr(l.country_name),
      region: asStr(l.region),
      city: asStr(l.city),
      browser: asStr(l.browser),
      browser_version: asStr(l.browser_version),
      os: asStr(l.os),
      device_type: asStr(l.device_type),
      site: asStr(l.site) ?? asStr(fr.site),
      landing_path: asStr(fr.page_path),
      source: visitorSource(fr),
      kind: verdict.kind,
      kind_reason: verdict.reason,
      utm_campaign: asStr(fr.utm_campaign) ?? asStr(touch?.utm_campaign),
      utm_content: asStr(fr.utm_content) ?? asStr(touch?.utm_content),
    };
  });
}

// ── visitor kinds (internal / bot / suspected / human) ──────────────────────
const MAX_VISITORS = 20_000;

interface VisitorContext {
  kinds: Map<string, KindVerdict>;
  /** UTM touches per visitor, earliest first. */
  touches: Map<string, TouchRow[]>;
  touchRows: TouchRow[];
}

const ctxCache = new Map<string, { at: number; p: Promise<VisitorContext> }>();
const CTX_TTL_MS = 30_000;

/** Drop the cached kinds/touches (after a write that changes them). */
export function invalidateVisitorContext(tenantId?: string) {
  if (tenantId) ctxCache.delete(tenantId);
  else ctxCache.clear();
}

/**
 * Kind verdict for every visitor of the workspace, plus their UTM touches.
 * Computed over all of the tenant's visitors (bursts need the neighbours, not
 * just the filtered page) and cached for 30 s.
 */
export function visitorContext(tenantId: string): Promise<VisitorContext> {
  const hit = ctxCache.get(tenantId);
  if (hit && Date.now() - hit.at < CTX_TTL_MS) return hit.p;
  const p = loadVisitorContext(tenantId).catch((e) => {
    ctxCache.delete(tenantId);
    throw e;
  });
  ctxCache.set(tenantId, { at: Date.now(), p });
  return p;
}

const PASSIVE_LIST = [...PASSIVE_EVENTS].map(lit).join(',');

async function loadVisitorContext(tenantId: string): Promise<VisitorContext> {
  await ensureEventsTable();
  const [agg, first, ips, touches] = await Promise.all([
    db().sql<Row>(
      `SELECT anonymous_id, MIN(occurred_at) AS first_seen,
              SUM(CASE WHEN event_type = 'pageview' OR event_type = 'page_view' THEN 1 ELSE 0 END) AS pageviews,
              SUM(CASE WHEN event_type IN (${PASSIVE_LIST}) THEN 0 ELSE 1 END) AS interactions,
              MAX(CASE WHEN is_bot = TRUE THEN 1 ELSE 0 END) AS any_bot
         FROM pm_events WHERE tenant_id = $1 GROUP BY anonymous_id LIMIT ${MAX_VISITORS}`,
      [tenantId],
    ),
    db().sql<Row>(
      `SELECT * FROM (SELECT tenant_id, anonymous_id, site, utm_source, referrer_domain, browser, os, device_type, screen_w, screen_h,
              ROW_NUMBER() OVER (PARTITION BY anonymous_id ORDER BY occurred_at ASC) AS rn
         FROM pm_events WHERE tenant_id = $1) z WHERE rn = 1 LIMIT ${MAX_VISITORS}`,
      [tenantId],
    ),
    db().sql<Row>(`SELECT anonymous_id, ip FROM pm_events WHERE tenant_id = $1 AND ip IS NOT NULL GROUP BY anonymous_id, ip LIMIT ${MAX_VISITORS * 3}`, [tenantId]),
    utmTouches(tenantId, null),
  ]);
  const F = new Map(first.rows.map((r) => [String(r.anonymous_id), r]));
  const I = new Map<string, string[]>();
  for (const r of ips.rows) {
    const id = String(r.anonymous_id);
    const l = I.get(id) ?? [];
    l.push(String(r.ip));
    I.set(id, l);
  }
  const profiles: VisitorProfile[] = agg.rows.map((a) => {
    const id = String(a.anonymous_id);
    const fr = F.get(id) ?? {};
    const sw = Number(fr.screen_w ?? 0);
    const sh = Number(fr.screen_h ?? 0);
    return {
      anonymous_id: id,
      first_seen: String(a.first_seen ?? ''),
      site: asStr(fr.site),
      any_bot: Number(a.any_bot ?? 0) > 0,
      pageviews: Number(a.pageviews ?? 0),
      interactions: Number(a.interactions ?? 0),
      ips: I.get(id) ?? [],
      source_key: (asStr(fr.utm_source) ?? asStr(fr.referrer_domain) ?? '').toLowerCase(),
      browser: asStr(fr.browser),
      os: asStr(fr.os),
      device_type: asStr(fr.device_type),
      screen: sw && sh ? `${sw}x${sh}` : null,
    };
  });
  const kinds = classifyKinds(profiles, trafficRules(), lookupAsn);
  const byVisitor = new Map<string, TouchRow[]>();
  for (const t of [...touches].sort((x, y) => x.first_at.localeCompare(y.first_at))) {
    const l = byVisitor.get(t.anonymous_id) ?? [];
    l.push(t);
    byVisitor.set(t.anonymous_id, l);
  }
  return { kinds, touches: byVisitor, touchRows: touches };
}

/** Visitor counts per kind for a window (dashboard / reports). */
export async function kindCounts(tenantId: string, sinceTs: string | null, site?: string | null): Promise<Record<VisitorKind, number>> {
  await ensureEventsTable();
  const params: unknown[] = [tenantId];
  let where = 'tenant_id = $1';
  if (sinceTs) {
    params.push(sinceTs);
    where += ` AND occurred_at >= $${params.length}`;
  }
  if (site) {
    params.push(site);
    where += ` AND site = $${params.length}`;
  }
  const [r, ctx] = await Promise.all([
    db().sql<Row>(`SELECT anonymous_id, MAX(CASE WHEN is_bot = TRUE THEN 1 ELSE 0 END) AS any_bot FROM pm_events WHERE ${where} GROUP BY anonymous_id LIMIT ${MAX_VISITORS}`, params),
    visitorContext(tenantId),
  ]);
  const out: Record<VisitorKind, number> = { human: 0, internal: 0, suspected: 0, bot: 0 };
  for (const x of r.rows) {
    const k = ctx.kinds.get(String(x.anonymous_id))?.kind ?? (Number(x.any_bot ?? 0) > 0 ? 'bot' : 'human');
    out[k]++;
  }
  return out;
}

// ── UTM campaigns ────────────────────────────────────────────────────────────
async function utmTouches(tenantId: string, f: { site?: string | null; from?: string | null; to?: string | null } | null): Promise<TouchRow[]> {
  const params: unknown[] = [tenantId];
  const parts = ['tenant_id = $1', '(utm_source IS NOT NULL OR utm_campaign IS NOT NULL)'];
  const add = (cond: string, v: unknown) => {
    params.push(v);
    parts.push(cond.replace('?', `$${params.length}`));
  };
  if (f?.site) add('site = ?', f.site);
  if (f?.from && DAY.test(f.from)) add('occurred_at >= ?', `${f.from} 00:00:00`);
  if (f?.to && DAY.test(f.to)) add('occurred_at <= ?', `${f.to} 23:59:59`);
  const r = await db().sql<Row>(
    `SELECT site, utm_source, utm_medium, utm_campaign, utm_content, anonymous_id, session_id, MIN(occurred_at) AS first_at,
            SUM(CASE WHEN event_type = 'pageview' OR event_type = 'page_view' THEN 1 ELSE 0 END) AS pageviews
       FROM pm_events WHERE ${parts.join(' AND ')}
      GROUP BY site, utm_source, utm_medium, utm_campaign, utm_content, anonymous_id, session_id LIMIT 100000`,
    params,
  );
  return r.rows.map((x) => ({
    site: asStr(x.site), utm_source: asStr(x.utm_source), utm_medium: asStr(x.utm_medium), utm_campaign: asStr(x.utm_campaign),
    utm_content: asStr(x.utm_content), anonymous_id: String(x.anonymous_id), session_id: asStr(x.session_id),
    first_at: String(x.first_at ?? ''), pageviews: Number(x.pageviews ?? 0),
  }));
}

const CONVERSION_TYPES = FUNNEL_STEPS.filter((s) => s.conversion).flatMap((s) => [...s.names]);

export interface CampaignFilters { kind?: KindFilter; site?: string | null; from?: string | null; to?: string | null }

export async function campaignReport(tenantId: string, f: CampaignFilters): Promise<CampaignReportRow[]> {
  await Promise.all([ensureEventsTable(), ensureCampaignsTable()]);
  const [touches, conv, saved, ctx] = await Promise.all([
    utmTouches(tenantId, f),
    db().sql<Row>(
      `SELECT anonymous_id, event_type, MIN(occurred_at) AS first_at FROM pm_events
        WHERE tenant_id = $1 AND event_type IN (${CONVERSION_TYPES.map(lit).join(',')}) GROUP BY anonymous_id, event_type LIMIT 100000`,
      [tenantId],
    ),
    listCampaigns(tenantId),
    visitorContext(tenantId),
  ]);
  const kindF: KindFilter = f.kind ?? 'human';
  const conversions: ConversionRow[] = conv.rows.map((x) => ({ anonymous_id: String(x.anonymous_id), event_type: String(x.event_type), first_at: String(x.first_at ?? '') }));
  const site = f.site ? f.site.toLowerCase().replace(/^www\./, '') : null;
  return buildCampaignReport(
    touches,
    conversions,
    site ? saved.filter((s) => (s.site ?? '') === site) : saved,
    (id) => kindMatches(kindF, ctx.kinds.get(id)?.kind ?? 'human'),
  );
}

export const PM_CAMPAIGNS_DDL = `CREATE TABLE IF NOT EXISTS pm_campaigns (
  campaign_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT, channel TEXT, site TEXT, site_url TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
  tagged_url TEXT, notes TEXT, created_by TEXT, created_at TIMESTAMP)`;

let campaignsEnsured: Promise<void> | null = null;
export function ensureCampaignsTable(): Promise<void> {
  if (!campaignsEnsured) {
    campaignsEnsured = (async () => {
      await db().sql(PM_CAMPAIGNS_DDL);
      await db().sql(`CREATE INDEX IF NOT EXISTS idx_pm_campaigns_tenant ON pm_campaigns(tenant_id)`);
    })().catch((e) => {
      campaignsEnsured = null;
      throw e;
    });
  }
  return campaignsEnsured;
}

export async function listCampaigns(tenantId: string): Promise<SavedCampaign[]> {
  await ensureCampaignsTable();
  const r = await db().sql<Row>(`SELECT * FROM pm_campaigns WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1000`, [tenantId]);
  return r.rows.map((x) => ({
    campaign_id: String(x.campaign_id), name: String(x.name ?? x.utm_campaign ?? ''), channel: asStr(x.channel), site: asStr(x.site),
    site_url: asStr(x.site_url), utm_source: String(x.utm_source ?? ''), utm_medium: String(x.utm_medium ?? ''), utm_campaign: String(x.utm_campaign ?? ''),
    utm_content: asStr(x.utm_content), utm_term: asStr(x.utm_term), tagged_url: String(x.tagged_url ?? ''), notes: asStr(x.notes),
    created_at: String(x.created_at ?? ''),
  }));
}

export async function insertCampaign(c: Omit<SavedCampaign, 'campaign_id' | 'created_at'> & { tenantId: string; createdBy: string | null }): Promise<SavedCampaign> {
  await ensureCampaignsTable();
  const row = { ...c, campaign_id: randomUUID(), created_at: sqlTs(new Date()) };
  await db().sql(
    `INSERT INTO pm_campaigns (campaign_id, tenant_id, name, channel, site, site_url, utm_source, utm_medium, utm_campaign, utm_content, utm_term, tagged_url, notes, created_by, created_at)
     VALUES (${[row.campaign_id, c.tenantId, c.name, c.channel, c.site, c.site_url, c.utm_source, c.utm_medium, c.utm_campaign, c.utm_content, c.utm_term, c.tagged_url, c.notes, c.createdBy, row.created_at].map(lit).join(',')})`,
  );
  const { tenantId: _t, createdBy: _c, ...saved } = row;
  return saved;
}

export async function deleteCampaign(tenantId: string, campaignId: string): Promise<void> {
  await ensureCampaignsTable();
  await db().sql(`DELETE FROM pm_campaigns WHERE tenant_id = $1 AND campaign_id = $2`, [tenantId, campaignId]);
}

export async function visitorEvents(tenantId: string, anonymousId: string, limit = 2000): Promise<Row[]> {
  await ensureEventsTable();
  const lim = Math.max(1, Math.min(5000, Math.floor(limit)));
  const res = await db().sql<Row>(
    `SELECT * FROM pm_events WHERE tenant_id = $1 AND anonymous_id = $2 ORDER BY occurred_at ASC LIMIT ${lim}`,
    [tenantId, anonymousId],
  );
  return res.rows;
}

export interface FilterOptions {
  sites: string[];
  countries: Array<{ code: string; name: string }>;
  utm_sources: string[];
  utm_mediums: string[];
  utm_campaigns: string[];
}

export async function filterOptions(tenantId: string): Promise<FilterOptions> {
  await ensureEventsTable();
  const sites = await db().sql<Row>(
    `SELECT site, COUNT(*) AS n FROM pm_events WHERE tenant_id = $1 AND site IS NOT NULL GROUP BY site ORDER BY n DESC LIMIT 50`,
    [tenantId],
  );
  const countries = await db().sql<Row>(
    `SELECT country, country_name, COUNT(*) AS n FROM pm_events WHERE tenant_id = $1 AND country IS NOT NULL
      GROUP BY country, country_name ORDER BY n DESC LIMIT 100`,
    [tenantId],
  );
  const utm = await db().sql<Row>(
    `SELECT utm_source, utm_medium, utm_campaign, COUNT(*) AS n FROM pm_events
      WHERE tenant_id = $1 AND (utm_source IS NOT NULL OR utm_campaign IS NOT NULL)
      GROUP BY utm_source, utm_medium, utm_campaign ORDER BY n DESC LIMIT 500`,
    [tenantId],
  );
  const uniq = (k: string) => [...new Set(utm.rows.map((r) => asStr(r[k])).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b));
  return {
    sites: sites.rows.map((r) => String(r.site)),
    countries: countries.rows.map((r) => ({ code: String(r.country), name: String(r.country_name ?? r.country) })),
    utm_sources: uniq('utm_source'),
    utm_mediums: uniq('utm_medium'),
    utm_campaigns: uniq('utm_campaign'),
  };
}

export interface VisitorBreakdown {
  since: string;
  humans: { visitors: number; events: number };
  bots: { visitors: number; events: number };
  internal: { visitors: number; events: number };
  suspected: { visitors: number; events: number };
  countries: Array<{ country: string; country_name: string; visitors: number }>;
  bots_by_name: Array<{ bot_name: string; bot_category: string; bot_verified: string | null; events: number }>;
}

export async function visitorBreakdown(tenantId: string, days = 30): Promise<VisitorBreakdown> {
  await ensureEventsTable();
  const since = sqlTs(new Date(Date.now() - days * 86400_000));
  const [perVisitor, bots, ctx] = await Promise.all([
    db().sql<Row>(
      `SELECT anonymous_id, country, country_name, COUNT(*) AS events, MAX(CASE WHEN is_bot = TRUE THEN 1 ELSE 0 END) AS any_bot
         FROM pm_events WHERE tenant_id = $1 AND occurred_at >= $2 GROUP BY anonymous_id, country, country_name LIMIT ${MAX_VISITORS * 2}`,
      [tenantId, since],
    ),
    db().sql<Row>(
      `SELECT bot_name, bot_category, bot_verified, COUNT(*) AS events
         FROM pm_events WHERE tenant_id = $1 AND occurred_at >= $2 AND is_bot = TRUE
        GROUP BY bot_name, bot_category, bot_verified ORDER BY events DESC LIMIT 10`,
      [tenantId, since],
    ),
    visitorContext(tenantId),
  ]);
  const acc: Record<VisitorKind, { ids: Set<string>; events: number }> = {
    human: { ids: new Set(), events: 0 }, bot: { ids: new Set(), events: 0 }, internal: { ids: new Set(), events: 0 }, suspected: { ids: new Set(), events: 0 },
  };
  const countryIds = new Map<string, { name: string; ids: Set<string> }>();
  for (const r of perVisitor.rows) {
    const id = String(r.anonymous_id);
    const k = ctx.kinds.get(id)?.kind ?? (Number(r.any_bot ?? 0) > 0 ? 'bot' : 'human');
    acc[k].ids.add(id);
    acc[k].events += Number(r.events ?? 0);
    if (k === 'human' && r.country) {
      const c = countryIds.get(String(r.country)) ?? { name: String(r.country_name ?? r.country), ids: new Set<string>() };
      c.ids.add(id);
      countryIds.set(String(r.country), c);
    }
  }
  const pack = (k: VisitorKind) => ({ visitors: acc[k].ids.size, events: acc[k].events });
  return {
    since,
    humans: pack('human'),
    bots: pack('bot'),
    internal: pack('internal'),
    suspected: pack('suspected'),
    countries: [...countryIds.entries()]
      .map(([country, c]) => ({ country, country_name: c.name, visitors: c.ids.size }))
      .sort((x, y) => y.visitors - x.visitors)
      .slice(0, 10),
    bots_by_name: bots.rows.map((r) => ({ bot_name: String(r.bot_name ?? 'Unknown'), bot_category: String(r.bot_category ?? 'other'), bot_verified: asStr(r.bot_verified), events: Number(r.events ?? 0) })),
  };
}

/**
 * Conversion funnel (visit → pricing → lead → sign-up → checkout → purchase)
 * for human visitors in the last `days` days. Reads distinct (site, event,
 * visitor) triples — bounded by the LIMIT — and counts per step in JS so a
 * visitor is counted once per step even when a step has several event names.
 */
export async function conversionFunnel(tenantId: string, days = 30): Promise<FunnelReport & { since: string; truncated: boolean }> {
  await ensureEventsTable();
  const since = sqlTs(new Date(Date.now() - days * 86400_000));
  const cap = 50_000;
  const r = await db().sql<Row>(
    `SELECT site, event_type, anonymous_id, COUNT(*) AS events
       FROM pm_events
      WHERE tenant_id = $1 AND occurred_at >= $2 AND is_bot = FALSE
        AND event_type IN (${FUNNEL_EVENT_TYPES.map(lit).join(',')})
      GROUP BY site, event_type, anonymous_id
      LIMIT ${cap}`,
    [tenantId, since],
  );
  // Humans only: internal and suspected visitors are left out like bots.
  const ctx = await visitorContext(tenantId);
  const rows = r.rows.filter((x) => (ctx.kinds.get(String(x.anonymous_id))?.kind ?? 'human') === 'human');
  const report = buildFunnel(rows.map((x) => ({
    site: asStr(x.site),
    event_type: asStr(x.event_type),
    anonymous_id: asStr(x.anonymous_id),
    events: Number(x.events ?? 1),
  })));
  return { ...report, since, truncated: r.rows.length >= cap };
}

// ── reclassification (backfill) ──────────────────────────────────────────────
export interface ReclassifyResult {
  scanned: number;
  changed: number;
  before: { human: number; bot: number };
  after: { human: number; bot: number };
}

async function botSplit(): Promise<{ human: number; bot: number }> {
  const r = await db().sql<Row>(`SELECT is_bot, COUNT(*) AS n FROM pm_events GROUP BY is_bot`);
  const n = (b: boolean) => Number(r.rows.find((x) => asBool(x.is_bot) === b)?.n ?? 0);
  return { human: n(false), bot: n(true) };
}

const sameVerdict = (r: Row, c: Classification) =>
  asBool(r.is_bot) === c.isBot && asStr(r.bot_name) === c.botName && asStr(r.bot_category) === c.botCategory &&
  asStr(r.bot_verified) === c.botVerified && asStr(r.device_type) === c.deviceType;

/**
 * Re-run the classifier (UA + crawler IP ranges) over stored events whose
 * `bot_rules_version` is older than CLASSIFIER_VERSION (or missing). Rows are
 * grouped by verdict and updated with one statement per verdict per batch.
 * Idempotent: every scanned row is stamped with the current version.
 */
export async function reclassifyEvents(matcher: CrawlerMatcher, batchSize = 500): Promise<ReclassifyResult> {
  await ensureEventsTable();
  const before = await botSplit();
  let scanned = 0;
  let changed = 0;
  const seen = new Set<string>();
  for (let guard = 0; guard < 10_000; guard++) {
    const res = await db().sql<Row>(
      `SELECT event_id, user_agent, ip, is_bot, bot_name, bot_category, bot_verified, device_type
         FROM pm_events WHERE bot_rules_version IS NULL OR bot_rules_version < ${CLASSIFIER_VERSION} LIMIT ${batchSize}`,
    );
    if (!res.rows.length) break;
    if (res.rows.some((r) => seen.has(String(r.event_id)))) throw new Error('reclassify: UPDATE did not persist; stopping');
    for (const r of res.rows) seen.add(String(r.event_id));
    const groups = new Map<string, { c: Classification; ids: string[] }>();
    const stampOnly: string[] = [];
    for (const r of res.rows) {
      const c = classifyVisitor(asStr(r.user_agent), asStr(r.ip), matcher);
      if (sameVerdict(r, c)) {
        stampOnly.push(String(r.event_id));
        continue;
      }
      const k = JSON.stringify([c.isBot, c.botName, c.botCategory, c.botVerified, c.deviceType]);
      const g = groups.get(k) ?? { c, ids: [] };
      g.ids.push(String(r.event_id));
      groups.set(k, g);
    }
    for (const { c, ids } of groups.values()) {
      await db().sql(
        `UPDATE pm_events SET is_bot = ${lit(c.isBot)}, bot_name = ${lit(c.botName)}, bot_category = ${lit(c.botCategory)},
                bot_verified = ${lit(c.botVerified)}, device_type = ${lit(c.deviceType)}, bot_rules_version = ${CLASSIFIER_VERSION}
          WHERE event_id IN (${ids.map(lit).join(',')})`,
      );
      changed += ids.length;
    }
    if (stampOnly.length) {
      await db().sql(`UPDATE pm_events SET bot_rules_version = ${CLASSIFIER_VERSION} WHERE event_id IN (${stampOnly.map(lit).join(',')})`);
    }
    scanned += res.rows.length;
  }
  return { scanned, changed, before, after: await botSplit() };
}
