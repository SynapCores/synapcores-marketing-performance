/**
 * Conversion funnel over raw pixel events (`pm_events`).
 *
 * Steps, in order: visit → viewed pricing → lead → sign-up → began checkout →
 * purchase. Each step counts distinct (human) visitors who sent at least one
 * event of that step in the window — "reached", not strictly sequential, so a
 * visitor who signed up without the pricing section ever scrolling into view
 * still counts as a sign-up. Lead, sign-up and purchase are the conversions;
 * view-pricing and begin-checkout are funnel steps only.
 *
 * Pure: the store hands in (site, event_type, anonymous_id, events) rows.
 */
import {
  BEGIN_CHECKOUT_EVENTS, LEAD_EVENTS, PURCHASE_EVENTS, SIGNUP_EVENTS, TOUCH_EVENTS, VIEW_PRICING_EVENTS,
} from '../collector';

export type FunnelStepId = 'visit' | 'view_pricing' | 'lead' | 'signup' | 'begin_checkout' | 'purchase';

export const FUNNEL_STEPS: ReadonlyArray<{ id: FunnelStepId; label: string; conversion: boolean; names: ReadonlySet<string> }> = [
  { id: 'visit', label: 'Visited', conversion: false, names: TOUCH_EVENTS },
  { id: 'view_pricing', label: 'Viewed pricing', conversion: false, names: VIEW_PRICING_EVENTS },
  { id: 'lead', label: 'Lead', conversion: true, names: LEAD_EVENTS },
  { id: 'signup', label: 'Signed up', conversion: true, names: SIGNUP_EVENTS },
  { id: 'begin_checkout', label: 'Began checkout', conversion: false, names: BEGIN_CHECKOUT_EVENTS },
  { id: 'purchase', label: 'Purchased', conversion: true, names: PURCHASE_EVENTS },
];

/** Every raw event_type that belongs to some funnel step (for the SQL IN list). */
export const FUNNEL_EVENT_TYPES: string[] = [...new Set(FUNNEL_STEPS.flatMap((s) => [...s.names]))].sort();

/** Raw event_type (any case) → funnel step, or null for events outside the funnel. */
export function funnelStep(eventType: string | null | undefined): FunnelStepId | null {
  const n = (eventType ?? '').toLowerCase();
  for (const s of FUNNEL_STEPS) if (s.names.has(n)) return s.id;
  return null;
}

export interface FunnelInputRow {
  site: string | null;
  event_type: string | null;
  anonymous_id: string | null;
  /** Events of this type from this visitor on this site (defaults to 1). */
  events?: number | null;
}

export interface FunnelStepResult {
  id: FunnelStepId;
  label: string;
  conversion: boolean;
  visitors: number;
  events: number;
  /** visitors / visitors at the first step, 0–100 (one decimal); null when nobody visited. */
  pct_of_visits: number | null;
}

export interface FunnelReport {
  steps: FunnelStepResult[];
  /** Same steps, per site (host the pixel fired on), busiest site first. */
  sites: Array<{ site: string; steps: FunnelStepResult[] }>;
}

function shape(acc: Map<FunnelStepId, { ids: Set<string>; events: number }>): FunnelStepResult[] {
  const base = acc.get('visit')?.ids.size ?? 0;
  return FUNNEL_STEPS.map((s) => {
    const a = acc.get(s.id);
    const visitors = a?.ids.size ?? 0;
    return {
      id: s.id,
      label: s.label,
      conversion: s.conversion,
      visitors,
      events: a?.events ?? 0,
      pct_of_visits: base ? Math.round((visitors / base) * 1000) / 10 : null,
    };
  });
}

export function buildFunnel(rows: FunnelInputRow[]): FunnelReport {
  const all = new Map<FunnelStepId, { ids: Set<string>; events: number }>();
  const bySite = new Map<string, Map<FunnelStepId, { ids: Set<string>; events: number }>>();
  const add = (m: Map<FunnelStepId, { ids: Set<string>; events: number }>, step: FunnelStepId, id: string, n: number) => {
    let a = m.get(step);
    if (!a) m.set(step, (a = { ids: new Set(), events: 0 }));
    a.ids.add(id);
    a.events += n;
  };
  for (const r of rows) {
    const step = funnelStep(r.event_type);
    if (!step || !r.anonymous_id) continue;
    const n = Number(r.events ?? 1) || 1;
    add(all, step, r.anonymous_id, n);
    const site = r.site || '(unknown)';
    if (!bySite.has(site)) bySite.set(site, new Map());
    add(bySite.get(site)!, step, r.anonymous_id, n);
  }
  const sites = [...bySite.entries()]
    .map(([site, m]) => ({ site, steps: shape(m) }))
    .sort((a, b) => (b.steps[0]?.visitors ?? 0) - (a.steps[0]?.visitors ?? 0) || a.site.localeCompare(b.site));
  return { steps: shape(all), sites };
}
