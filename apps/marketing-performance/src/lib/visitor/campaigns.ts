/**
 * UTM campaigns: the link builder and the per-campaign report.
 *
 * A campaign is identified by (site, utm_source, utm_medium, utm_campaign),
 * compared case-insensitively. Saved campaigns (pm_campaigns) with no traffic
 * still show; campaigns seen in traffic that were never saved show as
 * "untracked" so nothing is invisible.
 *
 * Attribution: a visitor counts for every campaign they arrived through
 * (any session that carried the campaign's UTM). A lead / sign-up / purchase
 * counts for a campaign when it happened at or after the visitor's first touch
 * on that campaign.
 *
 * Pure (rows in, rows out) so it is unit tested without a database.
 */
import { funnelStep } from './funnel';

export { UTM_KEYS, CHANNELS, cleanParam, buildCampaignUrl, type UtmKey, type CampaignInput } from './campaign-links';

const norm = (v: unknown) => (v == null ? '' : String(v).trim().toLowerCase());
const normSite = (v: unknown) => norm(v).replace(/^www\./, '');

export function campaignKey(site: unknown, source: unknown, medium: unknown, campaign: unknown): string {
  return [normSite(site), norm(source), norm(medium), norm(campaign)].join('|');
}

export interface SavedCampaign {
  campaign_id: string;
  name: string;
  channel: string | null;
  site: string | null;
  site_url: string | null;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string | null;
  utm_term: string | null;
  tagged_url: string;
  notes: string | null;
  created_at: string;
}

/** One row per (site, source, medium, campaign, visitor, session) that carried UTM. */
export interface TouchRow {
  site: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  anonymous_id: string;
  session_id: string | null;
  first_at: string;
  pageviews: number;
}

/** First time each visitor fired each event type. */
export interface ConversionRow { anonymous_id: string; event_type: string; first_at: string }

export interface CampaignReportRow {
  key: string;
  site: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  contents: string[];
  saved: SavedCampaign | null;
  status: 'tracked' | 'untracked' | 'no traffic yet';
  visitors: number;
  sessions: number;
  pageviews: number;
  leads: number;
  signups: number;
  purchases: number;
  /** Visitors left out by the kind filter (internal / suspected / bots). */
  excluded: number;
  first_seen: string | null;
  last_seen: string | null;
}

export function buildCampaignReport(
  touches: TouchRow[],
  conversions: ConversionRow[],
  saved: SavedCampaign[],
  include: (anonymousId: string) => boolean,
): CampaignReportRow[] {
  const conv = new Map<string, Array<{ step: string; at: string }>>();
  for (const c of conversions) {
    const step = funnelStep(c.event_type);
    if (step !== 'lead' && step !== 'signup' && step !== 'purchase') continue;
    const l = conv.get(c.anonymous_id) ?? [];
    l.push({ step, at: c.first_at });
    conv.set(c.anonymous_id, l);
  }

  interface Acc {
    row: CampaignReportRow;
    visitors: Map<string, string>; // anon → first touch
    excludedIds: Set<string>;
    sessions: Set<string>;
    contents: Set<string>;
  }
  const accs = new Map<string, Acc>();
  const blank = (key: string, site: string, s: string, m: string, c: string): Acc => ({
    row: {
      key, site, utm_source: s, utm_medium: m, utm_campaign: c, contents: [], saved: null, status: 'untracked',
      visitors: 0, sessions: 0, pageviews: 0, leads: 0, signups: 0, purchases: 0, excluded: 0, first_seen: null, last_seen: null,
    },
    visitors: new Map(), excludedIds: new Set(), sessions: new Set(), contents: new Set(),
  });

  for (const t of touches) {
    const key = campaignKey(t.site, t.utm_source, t.utm_medium, t.utm_campaign);
    let a = accs.get(key);
    if (!a) {
      a = blank(key, normSite(t.site), String(t.utm_source ?? ''), String(t.utm_medium ?? ''), String(t.utm_campaign ?? ''));
      accs.set(key, a);
    }
    if (!include(t.anonymous_id)) {
      a.excludedIds.add(t.anonymous_id);
      continue;
    }
    const prev = a.visitors.get(t.anonymous_id);
    if (!prev || t.first_at < prev) a.visitors.set(t.anonymous_id, t.first_at);
    a.sessions.add(`${t.anonymous_id}|${t.session_id ?? ''}`);
    a.row.pageviews += t.pageviews;
    if (t.utm_content) a.contents.add(t.utm_content);
    if (!a.row.first_seen || t.first_at < a.row.first_seen) a.row.first_seen = t.first_at;
    if (!a.row.last_seen || t.first_at > a.row.last_seen) a.row.last_seen = t.first_at;
  }

  for (const s of saved) {
    const key = campaignKey(s.site, s.utm_source, s.utm_medium, s.utm_campaign);
    let a = accs.get(key);
    if (!a) {
      a = blank(key, normSite(s.site), s.utm_source, s.utm_medium, s.utm_campaign);
      accs.set(key, a);
    }
    if (!a.row.saved) a.row.saved = s;
  }

  const rows: CampaignReportRow[] = [];
  for (const a of accs.values()) {
    const r = a.row;
    r.visitors = a.visitors.size;
    r.sessions = a.sessions.size;
    r.excluded = [...a.excludedIds].filter((id) => !a.visitors.has(id)).length;
    r.contents = [...a.contents].sort();
    for (const [anon, firstTouch] of a.visitors) {
      const steps = new Set((conv.get(anon) ?? []).filter((c) => c.at >= firstTouch).map((c) => c.step));
      if (steps.has('lead')) r.leads++;
      if (steps.has('signup')) r.signups++;
      if (steps.has('purchase')) r.purchases++;
    }
    r.status = r.saved ? (r.visitors + r.excluded > 0 ? 'tracked' : 'no traffic yet') : 'untracked';
    // Hide untracked campaigns whose only traffic was filtered out — unless the
    // filter is showing those kinds, they'd be empty rows. (Saved ones always show.)
    if (!r.saved && r.visitors === 0 && r.excluded === 0) continue;
    rows.push(r);
  }
  rows.sort((x, y) => y.visitors - x.visitors || (y.last_seen ?? y.saved?.created_at ?? '').localeCompare(x.last_seen ?? x.saved?.created_at ?? ''));
  return rows;
}
