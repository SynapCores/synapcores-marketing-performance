import Link from 'next/link';
import { AppPageHeader, Button, Card, CardContent } from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import { filterOptions, listVisitors, type VisitorFilters } from '@/lib/event-store';
import { BotBadge, GEO_ATTRIBUTION, flag, place, when } from './format';

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
  const kindRaw = one(sp.kind);
  const filters: VisitorFilters = {
    kind: kindRaw === 'bot' || kindRaw === 'human' ? kindRaw : 'all',
    site: one(sp.site) || null,
    country: one(sp.country) || null,
    from: one(sp.from) || null,
    to: one(sp.to) || null,
  };
  const [visitors, opts] = await Promise.all([listVisitors(tenantId, filters, 200), filterOptions(tenantId)]);
  const bots = visitors.filter((v) => v.is_bot).length;

  return (
    <div className="space-y-6">
      <AppPageHeader
        title="Visitors"
        description={<>Everyone your pixel has seen — where they are, what they browse with, how they arrived, and whether they are a person or a bot (incl. AI crawlers). Most recent first. {GEO_ATTRIBUTION}</>}
      />

      <Card>
        <CardContent className="pt-6">
          <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Type</span>
              <select name="kind" defaultValue={filters.kind} className="rounded-md border border-border bg-background px-2 py-1.5">
                <option value="all">Humans + bots</option>
                <option value="human">Humans only</option>
                <option value="bot">Bots only</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Site</span>
              <select name="site" defaultValue={filters.site ?? ''} className="rounded-md border border-border bg-background px-2 py-1.5">
                <option value="">All sites</option>
                {opts.sites.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Country</span>
              <select name="country" defaultValue={filters.country ?? ''} className="rounded-md border border-border bg-background px-2 py-1.5">
                <option value="">All countries</option>
                {opts.countries.map((c) => <option key={c.code} value={c.code}>{flag(c.code)} {c.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">From</span>
              <input type="date" name="from" defaultValue={filters.from ?? ''} className="rounded-md border border-border bg-background px-2 py-1" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">To</span>
              <input type="date" name="to" defaultValue={filters.to ?? ''} className="rounded-md border border-border bg-background px-2 py-1" />
            </label>
            <Button type="submit" size="sm">Apply</Button>
            <Link href="/visitors" className="pb-1.5 text-xs text-muted-foreground underline">reset</Link>
            <span className="ml-auto pb-1.5 text-xs text-muted-foreground">
              {visitors.length} visitor{visitors.length === 1 ? '' : 's'} shown · {visitors.length - bots} human · {bots} bot
            </span>
          </form>
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
                  <th className="pr-3">Source</th>
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
                      <div className="mt-1"><BotBadge isBot={v.is_bot} name={v.bot_name} category={v.bot_category} /></div>
                    </td>
                    <td className="pr-3">
                      <div>{flag(v.country)} {place(v)}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">{v.ip ?? '—'}{v.ip_truncated ? ' (/24·/48)' : ''}</div>
                    </td>
                    <td className="pr-3">
                      <div className="capitalize">{v.device_type ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{[v.browser && `${v.browser}${v.browser_version ? ' ' + v.browser_version : ''}`, v.os].filter(Boolean).join(' · ') || '—'}</div>
                    </td>
                    <td className="pr-3">{v.source}</td>
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
