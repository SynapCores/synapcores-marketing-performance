import { Suspense } from 'react';
import { AppPageHeader, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import FilterBar, { type FilterField } from '@/components/FilterBar';
import { downloadFunnel, importIntervalMs, installsFeedEnabledFor, loadInstallsFeed, type DownloadFunnel } from '@/lib/installs-store';
import { buildInstallsReport, displayNet, parseGranularity, parseRange, parseShow } from '@/lib/installs/report';
import { BucketChart, BucketTable, ClassBadge, FunnelSteps, MixTable, Tile, ago, fmt, utc, type FunnelStep } from './parts';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

const DESCRIPTION = 'New SynapCores installs and people from the product telemetry feed, next to download-page traffic and GitHub release downloads.';
const STALE_MS = 3600_000;

const FIELDS: FilterField[] = [
  {
    name: 'range', label: 'Range', type: 'select', defaultValue: '30',
    options: [{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: 'all', label: 'All time' }],
  },
  { name: 'granularity', label: 'Buckets', type: 'select', defaultValue: 'week', options: [{ value: 'week', label: 'Weekly (rolling 7 days)' }, { value: 'day', label: 'Daily (UTC)' }] },
  {
    name: 'show', label: 'Show', type: 'select', defaultValue: 'external',
    options: [{ value: 'external', label: 'External installs' }, { value: 'all', label: 'All classes (CI, internal, partner, test too)' }],
  },
];

const plural = (n: number, word: string, many = `${word}s`) => `${fmt(n)} ${n === 1 ? word : many}`;

export default async function InstallsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const session = await requireSession();
  const tenantId = session.tenant?.id;
  if (!tenantId || !installsFeedEnabledFor(tenantId)) {
    return (
      <AppPageHeader
        title="Installs"
        description="Install reporting isn't configured for this workspace. It reads a sanitized feed from the SynapCores telemetry export, which is set up per deployment."
      />
    );
  }

  const sp = await searchParams;
  const range = parseRange(one(sp.range));
  const granularity = parseGranularity(one(sp.granularity));
  const show = parseShow(one(sp.show));
  const now = Date.now();
  const feed = await loadInstallsFeed(tenantId);
  const rep = buildInstallsReport(feed, { now, range, granularity, show });
  const funnel: DownloadFunnel | null = await downloadFunnel(tenantId, rep.window.days).catch(() => null);
  const t = rep.totals;
  const d = rep.downloads;
  const meta = feed.meta.installs;
  const dlMeta = feed.meta.downloads;
  const windowLabel = range === 'all' ? `since ${new Date(rep.window.start).toISOString().slice(0, 10)}` : `last ${range} days`;
  const genAge = meta ? now - Date.parse(meta.header.generated_at) : null;
  const everyMin = Math.round(importIntervalMs() / 60_000);

  const filters = (
    <Card>
      <CardContent className="pt-6">
        <Suspense>
          <FilterBar
            report="installs"
            fields={FIELDS}
            summary={<>{plural(t.new_installs, 'new external install')} · {plural(t.new_people, 'new person', 'new people')} · {windowLabel}</>}
          />
        </Suspense>
      </CardContent>
    </Card>
  );

  if (!meta && !rep.has_rows) {
    return (
      <div className="space-y-6">
        <AppPageHeader title="Installs" description={DESCRIPTION} />
        <Card>
          <CardHeader>
            <CardTitle>No installs feed imported yet</CardTitle>
            <CardDescription>
              The importer checks the drop directory every {everyMin} minute{everyMin === 1 ? '' : 's'} (the first run is about a minute after the server starts).
              Numbers appear here once the telemetry export job has written <code>installs-v1.jsonl</code>.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const steps: FunnelStep[] = [
    funnel ? { label: 'Human visitors on /download', value: funnel.visitors, note: `(${plural(funnel.pageviews, 'page view')})` } : { label: 'Human visitors on /download', value: null, note: 'unavailable' },
    funnel?.cta_tracked
      ? { label: 'Install-command copies / download clicks', value: funnel.cta_visitors, note: 'visitors' }
      : { label: 'Install-command copies / download clicks', value: null, note: funnel ? 'not tracked yet' : 'unavailable' },
    { label: 'New external installs', value: t.new_installs },
    { label: 'New people', value: t.new_people },
  ];

  return (
    <div className="space-y-6">
      <AppPageHeader title="Installs" description={DESCRIPTION} />

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {meta ? (
            <>
              Feed generated {utc(meta.header.generated_at)} UTC{genAge !== null ? ` (${ago(genAge)} ago)` : ''} · imported {utc(meta.imported_at)} UTC ·{' '}
              {fmt(meta.header.source.rows)} telemetry rows, {fmt(meta.header.source.installations)} installation ids · classifier rules {meta.header.classifier.rules ?? '—'}
            </>
          ) : (
            <>Feed details unavailable.</>
          )}
          {dlMeta ? <> · GitHub counters {utc(dlMeta.header.generated_at)} UTC</> : null}
          {feed.invalid ? <> · {plural(feed.invalid, 'stored row')} skipped (failed re-validation)</> : null}
        </p>
        {meta && genAge !== null && genAge > STALE_MS ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
            The feed was generated {ago(genAge)} ago. The export job normally refreshes it every 15 minutes, so the numbers below are as of {utc(meta.header.generated_at)} UTC.
          </div>
        ) : null}
      </div>

      {filters}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Tile label="New external installs" value={t.new_installs} hint={windowLabel} />
        <Tile label="New people" value={t.new_people} hint={windowLabel} />
        <Tile label="Active installs" value={t.active_installs_7d} hint="last 7 days" />
        <Tile label="Active people" value={t.active_people_7d} hint="last 7 days" />
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">
        Counted separately ({windowLabel}): {plural(t.ci_ids, 'CI id')} and {plural(t.internal_ids, 'internal / test id')} first seen.{' '}
        {t.partner_active_ids
          ? <>Design partner: {plural(t.partner_active_ids, 'install')} active on {plural(t.partner_active_days, 'day')}{t.partner_last_seen ? <>, last seen {utc(t.partner_last_seen)} UTC</> : null}.</>
          : <>No design-partner activity in this period.</>}
      </p>

      <Card>
        <CardHeader>
          <CardTitle>From the download page to installs — {windowLabel}</CardTitle>
          <CardDescription>
            Steps are not linked per person (telemetry carries no visitor id), so ratios are indicative.
            {funnel ? <> /download visits are from {funnel.sites.join(', ')}; bots, internal and suspected visitors are left out.</> : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-8 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2">
              <FunnelSteps steps={steps} />
            </div>
            <div className="min-w-0 text-sm">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">GitHub release downloads</h4>
              {d.snapshots === 0 ? (
                <p className="text-muted-foreground">No counter snapshots yet (github-downloads-v1.jsonl is refreshed daily).</p>
              ) : (
                <>
                  <div className="text-2xl font-bold tabular-nums">{fmt(d.window_total)}</div>
                  <div className="text-xs text-muted-foreground">
                    archive downloads, {windowLabel}{d.window_deltas ? ` (${plural(d.window_deltas, 'daily snapshot')})` : ''}
                  </div>
                  {d.baseline?.in_window ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Counting starts at the first snapshot ({d.baseline.date}, {fmt(d.baseline.archives)} cumulative): that is the baseline, not downloads.
                    </p>
                  ) : null}
                  {d.latest ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      All-time: {fmt(d.latest.archives)} archive downloads ({fmt(d.latest.all_assets)} assets incl. checksums / installer)
                      {d.latest.latest_release ? <> · {d.latest.latest_release}: {fmt(d.latest.latest_archives)}</> : null}
                    </p>
                  ) : null}
                  {d.by_platform.length ? (
                    <table className="mt-3 w-full text-xs">
                      <thead>
                        <tr className="text-left uppercase text-muted-foreground">
                          <th className="py-1 font-medium">Platform</th>
                          <th className="text-right font-medium">Period</th>
                          <th className="text-right font-medium">All-time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.by_platform.slice(0, 8).map((p) => (
                          <tr key={p.platform} className="border-t border-border">
                            <td className="py-1">{p.platform}</td>
                            <td className="text-right tabular-nums">{fmt(p.downloads)}</td>
                            <td className="text-right tabular-nums text-muted-foreground">{fmt(p.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    GitHub counts every download, CI and bots included. Each daily snapshot&apos;s growth counts on the day between it and the previous one.
                    {d.gaps ? ` ${plural(d.gaps, 'interval')} spanned more than a day (missed refreshes); each counts in the middle of its gap.` : ''}
                    {d.adjusted ? ` ${plural(d.adjusted, 'day')} where the counter went down (a release asset was removed) count as 0.` : ''}
                  </p>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{granularity === 'week' ? 'Week by week' : 'Day by day'} — {windowLabel}</CardTitle>
          <CardDescription>
            {granularity === 'week' ? 'Rolling 7-day windows ending now, oldest first (like the installs log).' : 'UTC days, oldest first.'} Active = any telemetry event in the period.
            {show === 'all' ? ' Grey bars: CI, internal, partner and test ids first seen in the period.' : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BucketChart buckets={rep.buckets} showOther={show === 'all'} />
          <BucketTable buckets={rep.buckets} showDownloads={d.snapshots > 0} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mix</CardTitle>
          <CardDescription>
            New = {show === 'all' ? 'installs of every class' : 'new external installs'} first seen {windowLabel} ({fmt(rep.mixes.new_total)}); active = {show === 'all' ? 'installs of every class' : 'external installs'} with an event in the last 7 days ({fmt(rep.mixes.active_total)}).
            Version: as first installed for new installs, latest reported for active ones.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            <MixTable title="Version" rows={rep.mixes.version} newLabel="New" activeLabel="Active 7 d" />
            <MixTable title="OS / arch" rows={rep.mixes.osarch} newLabel="New" activeLabel="Active 7 d" />
            <MixTable title="Deployment" rows={rep.mixes.deployment} newLabel="New" activeLabel="Active 7 d" />
            <MixTable title="Country" rows={rep.mixes.country} newLabel="New" activeLabel="Active 7 d" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent installs</CardTitle>
          <CardDescription>
            {show === 'all' ? 'Installations of every class' : 'New external installs'} first seen {windowLabel}, newest first
            {rep.recent_total > rep.recent.length ? ` (latest ${rep.recent.length} of ${fmt(rep.recent_total)})` : ''}.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rep.recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No installs first seen in this period.</p>
          ) : (
            <table className="w-full min-w-[1040px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3">First seen (UTC)</th>
                  <th className="pr-3">Class</th>
                  <th className="pr-3">Country</th>
                  <th className="pr-3">Network</th>
                  <th className="pr-3">Deployment</th>
                  <th className="pr-3">OS / arch</th>
                  <th className="pr-3">Version</th>
                  <th className="pr-3 text-right">Events</th>
                  <th className="pr-3 text-right">Active days</th>
                  <th className="pr-3">Last seen (UTC)</th>
                  <th>Person</th>
                </tr>
              </thead>
              <tbody>
                {rep.recent.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums">{utc(r.first_seen)}</td>
                    <td className="pr-3"><ClassBadge cls={r.class} reason={r.reason} /></td>
                    <td className="pr-3">{r.country || '—'}</td>
                    <td className="whitespace-nowrap pr-3 font-mono text-xs">{displayNet(r.net) ?? '—'}</td>
                    <td className="pr-3">{r.deployment || '—'}</td>
                    <td className="whitespace-nowrap pr-3">{r.os || r.arch ? `${r.os || '?'}/${r.arch || '?'}` : '—'}</td>
                    <td className="whitespace-nowrap pr-3">{r.version || '—'}</td>
                    <td className="pr-3 text-right tabular-nums">{fmt(r.events_total)}</td>
                    <td className="pr-3 text-right tabular-nums">{fmt(r.active_days)}</td>
                    <td className="whitespace-nowrap pr-3 tabular-nums">{utc(r.last_seen)}</td>
                    <td className="font-mono text-xs text-muted-foreground">{r.person ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Definitions match the SynapCores installs log. A <b>new install</b> is an external installation (not CI, internal, likely-internal, partner or test) whose first install
        signal — created, started, version changed or heartbeat — falls in the period. A <b>new person</b> is the first install of a person: external installs that share a
        network, or match on country, deployment and OS within 48 hours. <b>Active</b> means any telemetry event that day. Days are UTC; weekly periods are rolling 7-day windows
        ending now. Data source: a sanitized one-way feed from the telemetry engine — networks only to /24 (IPv6 /40), hashed installation ids, no IP addresses.
      </p>
    </div>
  );
}
