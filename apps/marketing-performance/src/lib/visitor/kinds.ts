/**
 * Visitor kind — what the "Type" filter on the reports means.
 *
 *   internal   any event came from one of our own IPs (VISITOR_INTERNAL_IPS)
 *   bot        a declared / verified crawler or tool (UA + published ranges, see classify.ts)
 *   suspected  looks automated but doesn't say so: part of a burst, or browsing
 *              from a data-centre / cloud network ("review")
 *   human      everyone else
 *
 * Precedence is internal > bot > suspected > human, so our own headless tests
 * show up as internal rather than inflating the bot numbers.
 *
 * Burst: at least `burstMin` visitors, each with a single pageview and no
 * interaction, first seen within `burstWindowS` seconds of each other on the
 * same site, from the same campaign source / referrer, with the same browser,
 * OS and screen size (e.g. 17 "YouTube" visitors in one second from Windows /
 * Chrome 1920×1080 = YouTube's link scanners when a description is edited).
 *
 * Pure: profiles and rules are passed in.
 */
import type { TrafficRules } from './traffic-rules';
import { hostingLabel, type AsnInfo } from './asn';

export type VisitorKind = 'human' | 'internal' | 'suspected' | 'bot';
export const VISITOR_KINDS: VisitorKind[] = ['human', 'internal', 'suspected', 'bot'];
export type KindFilter = 'human' | 'internal' | 'suspected' | 'bot' | 'all';

export const KIND_OPTIONS: Array<{ value: KindFilter; label: string }> = [
  { value: 'human', label: 'Humans' },
  { value: 'suspected', label: 'Suspected bots' },
  { value: 'internal', label: 'Internal (our IPs)' },
  { value: 'bot', label: 'Bots (crawlers)' },
  { value: 'all', label: 'Everything' },
];

export function parseKind(v: string | null | undefined, dflt: KindFilter = 'human'): KindFilter {
  return (KIND_OPTIONS.some((o) => o.value === v) ? v : dflt) as KindFilter;
}

export interface VisitorProfile {
  anonymous_id: string;
  first_seen: string; // 'YYYY-MM-DD HH:MM:SS' UTC
  site: string | null;
  any_bot: boolean;
  pageviews: number;
  /** Events other than pageview / exit / visibility / session renewal. */
  interactions: number;
  ips: string[];
  /** utm_source, else referrer domain, else '' (direct). */
  source_key: string;
  browser: string | null;
  os: string | null;
  device_type: string | null;
  screen: string | null; // '1920x1080'
}

export interface KindVerdict { kind: VisitorKind; reason: string | null }

export const PASSIVE_EVENTS = new Set(['pageview', 'page_view', 'page_exit', 'visibility_hidden', 'visibility_visible', 'session_renewed']);

const ts = (s: string) => Date.parse(s.replace(' ', 'T') + 'Z');

export function classifyKinds(
  profiles: VisitorProfile[],
  rules: TrafficRules,
  asnOf: (ip: string) => AsnInfo | null = () => null,
): Map<string, KindVerdict> {
  const out = new Map<string, KindVerdict>();

  // Bursts (computed over everyone; a member is "suspected" unless a stronger verdict applies).
  const burst = new Map<string, string>();
  const groups = new Map<string, VisitorProfile[]>();
  for (const p of profiles) {
    if (p.pageviews > 1 || p.interactions > 0 || !p.screen || !p.browser) continue;
    const k = [p.site ?? '', p.source_key, p.browser, p.os ?? '', p.device_type ?? '', p.screen].join('|');
    const g = groups.get(k);
    if (g) g.push(p);
    else groups.set(k, [p]);
  }
  const win = rules.burstWindowS * 1000;
  for (const g of groups.values()) {
    if (g.length < rules.burstMin) continue;
    g.sort((a, b) => ts(a.first_seen) - ts(b.first_seen));
    // Sliding window: mark every member of any window holding >= burstMin visitors.
    let lo = 0;
    for (let hi = 0; hi < g.length; hi++) {
      while (ts(g[hi]!.first_seen) - ts(g[lo]!.first_seen) > win) lo++;
      const n = hi - lo + 1;
      if (n >= rules.burstMin) {
        const p0 = g[lo]!;
        const label = `burst: ${n}+ single-page visitors within ${rules.burstWindowS}s · ${p0.source_key || 'direct'} · ${p0.browser}/${p0.os ?? '?'} ${p0.screen}`;
        for (let i = lo; i <= hi; i++) burst.set(g[i]!.anonymous_id, label);
      }
    }
  }

  for (const p of profiles) {
    let v: KindVerdict | null = null;
    for (const ip of p.ips) {
      const hit = rules.internal.match(ip);
      if (hit) {
        v = { kind: 'internal', reason: `internal IP ${hit.label}` };
        break;
      }
    }
    if (!v && p.any_bot) v = { kind: 'bot', reason: null };
    if (!v && burst.has(p.anonymous_id)) v = { kind: 'suspected', reason: burst.get(p.anonymous_id)! };
    if (!v) {
      for (const ip of p.ips) {
        const dc = rules.datacenter.match(ip);
        const host = dc ? dc.label : hostingLabel(asnOf(ip));
        if (host) {
          v = { kind: 'suspected', reason: `data centre: ${host}` };
          break;
        }
      }
    }
    out.set(p.anonymous_id, v ?? { kind: 'human', reason: null });
  }
  return out;
}

export function kindMatches(filter: KindFilter, kind: VisitorKind): boolean {
  return filter === 'all' || filter === kind;
}
