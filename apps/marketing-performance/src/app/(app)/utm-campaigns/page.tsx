import Link from 'next/link';
import { SortHeader, cmp, parseSort } from '@/components/SortHeader';
import { Suspense } from 'react';
import { AppPageHeader, Card, CardContent } from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import { campaignReport, filterOptions } from '@/lib/event-store';
import { KIND_OPTIONS, parseKind } from '@/lib/visitor/kinds';
import FilterBar, { type FilterField } from '@/components/FilterBar';
import CopyButton from '@/components/CopyButton';
import { when } from '../visitors/format';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

const STATUS_STYLE: Record<string, string> = {
  tracked: 'bg-emerald-500/15 text-emerald-500',
  untracked: 'bg-amber-500/15 text-amber-500',
  'no traffic yet': 'bg-muted text-muted-foreground',
};

export default async function UtmCampaignsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const session = await requireSession();
  const tenantId = session.tenant?.id;
  if (!tenantId) {
    return <AppPageHeader title="UTM Campaigns" description="Join or create a workspace to see its campaigns." />;
  }
  const sp = await searchParams;
  const kind = parseKind(one(sp.kind));
  const f = { kind, site: one(sp.site) || null, from: one(sp.from) || null, to: one(sp.to) || null, tz: one(sp.tz) || null };
  const [rows, opts] = await Promise.all([campaignReport(tenantId, f), filterOptions(tenantId)]);
  // Default: most recent visit first (never-visited saved links last). Headers re-sort.
  const SORTS = ['last_seen', 'visitors', 'sessions', 'pageviews', 'leads', 'signups', 'purchases', 'excluded'] as const;
  const { sort, dir } = parseSort(one(sp.sort), one(sp.dir), SORTS, 'last_seen');
  rows.sort((a, b) => cmp(a[sort], b[sort], dir) || cmp(a.last_seen ?? a.saved?.created_at ?? null, b.last_seen ?? b.saved?.created_at ?? null, 'desc'));
  const filterQs = (() => { const q = new URLSearchParams(); for (const [k, v] of Object.entries(sp)) { const x = one(v); if (x && k !== 'sort' && k !== 'dir') q.set(k, x); } return q.toString(); })();
  const sh = { query: filterQs, sort, dir };
  const fields: FilterField[] = [
    { name: 'kind', label: 'Type', type: 'select', defaultValue: 'human', options: KIND_OPTIONS },
    { name: 'site', label: 'Site', type: 'select', options: [{ value: '', label: 'All sites' }, ...opts.sites.map((s) => ({ value: s, label: s }))] },
    { name: 'from', label: 'From', type: 'date' },
    { name: 'to', label: 'To', type: 'date' },
  ];
  const tot = rows.reduce((a, r) => ({ v: a.v + r.visitors, s: a.s + r.signups + r.leads + r.purchases }), { v: 0, s: 0 });
  const visitorsLink = (r: (typeof rows)[number]) => {
    const q = new URLSearchParams({ kind });
    if (r.site) q.set('site', r.site);
    if (r.utm_source) q.set('utm_source', r.utm_source);
    if (r.utm_medium) q.set('utm_medium', r.utm_medium);
    if (r.utm_campaign) q.set('utm_campaign', r.utm_campaign);
    return `/visitors?${q}`;
  };

  return (
    <div className="space-y-6">
      <AppPageHeader
        title="UTM Campaigns"
        description={<>Visitors, sessions and conversions by utm_campaign / source / medium, per site. Campaigns seen in traffic but never created show as <b>untracked</b>. <Link prefetch={false} href="/utm-campaigns/builder" className="underline">Create a campaign link →</Link></>}
      />

      <Card>
        <CardContent className="pt-6">
          <Suspense>
            <FilterBar report="utm-campaigns" fields={fields} summary={<>{rows.length} campaign{rows.length === 1 ? '' : 's'} · {tot.v} visitor{tot.v === 1 ? '' : 's'} · {tot.s} conversion{tot.s === 1 ? '' : 's'}</>} />
          </Suspense>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No campaign traffic for these filters yet. Tag your links with utm_source / utm_medium / utm_campaign — the <Link prefetch={false} href="/utm-campaigns/builder" className="underline">link builder</Link> does it for you.
            </p>
          ) : (
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3">Campaign</th>
                  <th className="pr-3">Site</th>
                  <th className="pr-3">Source / medium</th>
                  <SortHeader label="Visitors" col="visitors" align="right" className="pr-3" {...sh} />
                  <SortHeader label="Sessions" col="sessions" align="right" className="pr-3" {...sh} />
                  <SortHeader label="Pageviews" col="pageviews" align="right" className="pr-3" {...sh} />
                  <SortHeader label="Leads" col="leads" align="right" className="pr-3" {...sh} />
                  <SortHeader label="Sign-ups" col="signups" align="right" className="pr-3" {...sh} />
                  <SortHeader label="Purchases" col="purchases" align="right" className="pr-3" {...sh} />
                  <SortHeader label="Filtered out" col="excluded" align="right" className="pr-3" title="Visitors of this campaign left out by the Type filter (internal, suspected bots, bots)" {...sh} />
                  <SortHeader label="Last visit" col="last_seen" {...sh} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-t border-border align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{r.saved?.name || r.utm_campaign || '(no utm_campaign)'}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                        <span className={'rounded px-1.5 py-0.5 text-[11px] font-medium ' + (STATUS_STYLE[r.status] ?? '')}>{r.status}</span>
                        {r.saved?.channel && <span className="text-muted-foreground">{r.saved.channel}</span>}
                        {r.saved && r.saved.name !== r.utm_campaign && <span className="font-mono text-muted-foreground">{r.utm_campaign}</span>}
                      </div>
                      {r.contents.length > 0 && <div className="mt-0.5 max-w-[260px] truncate text-xs text-muted-foreground" title={r.contents.join(', ')}>content: {r.contents.join(', ')}</div>}
                      {r.saved?.tagged_url && <div className="mt-1"><CopyButton text={r.saved.tagged_url} label="Copy link" /></div>}
                    </td>
                    <td className="pr-3">{r.site || '—'}</td>
                    <td className="pr-3">{r.utm_source || '—'} / {r.utm_medium || '—'}</td>
                    <td className="pr-3 text-right tabular-nums">{r.visitors > 0 ? <Link prefetch={false} href={visitorsLink(r)} className="underline">{r.visitors}</Link> : 0}</td>
                    <td className="pr-3 text-right tabular-nums">{r.sessions}</td>
                    <td className="pr-3 text-right tabular-nums">{r.pageviews}</td>
                    <td className="pr-3 text-right tabular-nums">{r.leads}</td>
                    <td className="pr-3 text-right tabular-nums">{r.signups}</td>
                    <td className="pr-3 text-right tabular-nums">{r.purchases}</td>
                    <td className="pr-3 text-right tabular-nums text-muted-foreground">{r.excluded}</td>
                    <td className="whitespace-nowrap text-xs">{r.last_seen ? when(r.last_seen) : r.saved ? <>created {when(r.saved.created_at)}</> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        A visitor counts for each campaign they arrived through; a lead / sign-up / purchase counts when it happened after that visitor&apos;s first visit from the campaign. The pixel keeps the landing page&apos;s UTM for the rest of the browser session, so conversions on later pages are attributed too.
      </p>
    </div>
  );
}
