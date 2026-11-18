import Link from 'next/link';
import { Suspense } from 'react';
import { AppPageHeader, Card, CardContent } from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import { filterOptions, listVisitors, type VisitorFilters } from '@/lib/event-store';
import { KIND_OPTIONS, parseKind } from '@/lib/visitor/kinds';
import FilterBar, { type FilterField } from '@/components/FilterBar';
import { GEO_ATTRIBUTION, KindBadge, flag, place, when } from './format';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export default async function VisitorsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const session = await requireSession();
  const tenantId = session.tenant?.id;
  if (!tenantId) {
    return (
      <div className="space-y-6">
        <AppPageHeader title="Visitors" description="Join or create a workspace to see its visitors." />
      </div>
    );
  }
  const sp = await searchParams;
  const filters: VisitorFilters = {
    kind: parseKind(one(sp.kind)),
    site: one(sp.site) || null,
    country: one(sp.country) || null,
    from: one(sp.from) || null,
    to: one(sp.to) || null,
    utm_source: one(sp.utm_source) || null,
    utm_medium: one(sp.utm_medium) || null,
    utm_campaign: one(sp.utm_campaign) || null,
    tz: one(sp.tz) || null,
  };
  const [visitors, opts] = await Promise.all([listVisitors(tenantId, filters, 200), filterOptions(tenantId)]);
  const counts = { human: 0, internal: 0, suspected: 0, bot: 0 };
  for (const v of visitors) counts[v.kind]++;
  const any = (label: string) => ({ value: '', label });
  const fields: FilterField[] = [
    { name: 'kind', label: 'Type', type: 'select', defaultValue: 'human', options: KIND_OPTIONS },
    { name: 'site', label: 'Site', type: 'select', options: [any('All sites'), ...opts.sites.map((s) => ({ value: s, label: s }))] },
    { name: 'country', label: 'Country', type: 'select', options: [any('All countries'), ...opts.countries.map((c) => ({ value: c.code, label: `${flag(c.code)} ${c.name}` }))] },
    { name: 'utm_source', label: 'UTM source', type: 'select', options: [any('Any source'), ...opts.utm_sources.map((x) => ({ value: x, label: x }))] },
    { name: 'utm_medium', label: 'UTM medium', type: 'select', options: [any('Any medium'), ...opts.utm_mediums.map((x) => ({ value: x, label: x }))] },
    { name: 'utm_campaign', label: 'Campaign', type: 'select', options: [any('Any campaign'), ...opts.utm_campaigns.map((x) => ({ value: x, label: x }))] },
    { name: 'from', label: 'From', type: 'date' },
    { name: 'to', label: 'To', type: 'date' },
  ];

  return (
    <div className="space-y-6">
      <AppPageHeader
        title="Visitors"
        description={<>Everyone your pixel has seen — where they are, what they browse with, how they arrived, and whether they are a person or a bot (incl. AI crawlers). Most recent first. {GEO_ATTRIBUTION}</>}
      />

      <Card>
        <CardContent className="pt-6">
          <Suspense>
            <FilterBar
              report="visitors"
              fields={fields}
              summary={<>{visitors.length} visitor{visitors.length === 1 ? '' : 's'} shown · {counts.human} human · {counts.internal} internal · {counts.suspected} suspected · {counts.bot} bot</>}
            />
          </Suspense>
          <p className="mt-3 text-xs text-muted-foreground">
            <b>Humans</b> leaves out our own IPs (internal), declared/verified crawlers (bots) and traffic that looks automated without saying so — bursts of identical single-page visits and data-centre networks (suspected). Pick those types above to review them; nothing is deleted.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          {visitors.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No visitors match. Once a page carrying your pixel is loaded, its visitors show up here within seconds — see <Link href="/settings/pixels" className="underline">Tracking Pixels</Link>.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3">Visitor</th>
                  <th className="pr-3">Location</th>
                  <th className="pr-3">Device / browser / OS</th>
                  <th className="pr-3">Source · campaign</th>
                  <th className="pr-3">Site · landing</th>
                  <th className="pr-3 text-right">Pages</th>
                  <th className="pr-3 text-right">Events</th>
                  <th className="pr-3">First seen</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {visitors.map((v) => (
                  <tr key={v.anonymous_id} className="border-t border-border align-top">
                    <td className="py-2 pr-3">
                      <Link href={`/visitors/${encodeURIComponent(v.anonymous_id)}`} className="font-mono text-xs underline">{v.anonymous_id.slice(0, 8)}…</Link>
                      <div className="mt-1"><KindBadge kind={v.kind} reason={v.kind_reason} isBot={v.is_bot} name={v.bot_name} category={v.bot_category} verified={v.bot_verified} /></div>
                    </td>
                    <td className="pr-3">
                      <div>{flag(v.country)} {place(v)}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">{v.ip ?? '—'}{v.ip_truncated ? ' (/24·/48)' : ''}</div>
                    </td>
                    <td className="pr-3">
                      <div className="capitalize">{v.device_type ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{[v.browser && `${v.browser}${v.browser_version ? ' ' + v.browser_version : ''}`, v.os].filter(Boolean).join(' · ') || '—'}</div>
                    </td>
                    <td className="pr-3">
                      <div>{v.source}</div>
                      {v.utm_campaign && <div className="max-w-[200px] truncate text-xs text-muted-foreground" title={[v.utm_campaign, v.utm_content].filter(Boolean).join(' · ')}>{v.utm_campaign}{v.utm_content ? ` · ${v.utm_content}` : ''}</div>}
                    </td>
                    <td className="pr-3">
                      <div>{v.site ?? '—'}</div>
                      <div className="max-w-[220px] truncate text-xs text-muted-foreground" title={v.landing_path ?? ''}>{v.landing_path ?? ''}</div>
                    </td>
                    <td className="pr-3 text-right tabular-nums">{v.pages}</td>
                    <td className="pr-3 text-right tabular-nums">{v.events}</td>
                    <td className="whitespace-nowrap pr-3 text-xs">{when(v.first_seen)}</td>
                    <td className="whitespace-nowrap text-xs">{when(v.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
