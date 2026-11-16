import Link from 'next/link';
import {
  AppPageHeader, Card, CardContent, CardHeader, CardTitle, CardDescription, Button,
} from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import { kpis, scorecard, clickTruth, creativeAngle, type Row } from '@/lib/warehouse';
import FlipConnect, { type FlipRow } from './FlipConnect';
import AngleScatter, { type AngleRow } from './AngleScatter';
import AskCard from './AskCard';
import VisitorCard from './VisitorCard';
import FunnelCard from './FunnelCard';

export const dynamic = 'force-dynamic';

const usd = (n: unknown) => n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
const usd2 = (n: unknown) => n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n: unknown, d = 2) => n == null ? '—' : Number(n).toFixed(d);
const pdot = (p: unknown) => ({ facebook: '#4267B2', tiktok: '#ff0050', google: '#ea4335' } as Record<string, string>)[String(p)] ?? '#888';
const short = (n: unknown) => String(n ?? '').replace(/_/g, ' ');

export default async function DashboardPage() {
  const session = await requireSession();
  const k = await kpis();

  if (!k.new_customers) {
    return (
      <div className="space-y-6">
        <AppPageHeader title="Dashboard" description="True ROAS and 90-day LTV across Facebook, TikTok and Google." />
        <Card>
          <CardHeader><CardTitle>No campaign data yet</CardTitle>
            <CardDescription>Ingest your ad-platform spend and clickstream, or load the sample dataset to see the full attribution and LTV analysis.</CardDescription></CardHeader>
          <CardContent><Link href="/ingest"><Button>Go to Ingest Data →</Button></Link></CardContent>
        </Card>
        <VisitorCard tenantId={session.tenant?.id} />
        <FunnelCard tenantId={session.tenant?.id} />
      </div>
    );
  }

  const [sc, clicks, angle] = await Promise.all([scorecard(), clickTruth(), creativeAngle()]);
  const byDay0 = [...sc].sort((a, b) => Number(b.day0_roas) - Number(a.day0_roas));
  const byLtv = [...sc].sort((a, b) => Number(b.ltv_roas) - Number(a.ltv_roas));
  const rankOf = (arr: Row[], id: unknown) => arr.findIndex((r) => r.campaign_id === id);
  const top = byLtv[0];
  if (!top) return null;

  const flipRows: FlipRow[] = sc.map((r) => ({
    campaign_id: String(r.campaign_id),
    campaign_name: String(r.campaign_name),
    platform: String(r.platform ?? ''),
    day0_roas: Number(r.day0_roas),
    ltv_roas: Number(r.ltv_roas),
  }));
  const angleRows: AngleRow[] = angle.map((r) => ({
    campaign_id: String(r.campaign_id),
    campaign_name: String(r.campaign_name),
    discount_affinity: Number(r.discount_affinity),
    ltv_90d: Number(r.ltv_90d),
  }));

  const tiles = [
    { label: 'Total Media Spend', value: usd(k.total_spend) },
    { label: 'Attributed Customers', value: k.new_customers },
    { label: 'Blended CAC', value: usd2(k.blended_cac) },
    { label: 'Campaigns', value: k.campaigns },
    { label: 'Ad Platforms', value: k.platforms },
  ];

  return (
    <div className="space-y-6">
      <AppPageHeader title="Dashboard" description="True ROAS and 90-day LTV across Facebook, TikTok and Google — computed live in SynapCores." />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {tiles.map((t) => (
          <Card key={t.label} className="tile-gradient"><CardContent className="pt-5">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</div>
            <div className="glow-text mt-1 text-2xl font-bold">{t.value}</div>
          </CardContent></Card>
        ))}
      </div>

      <VisitorCard tenantId={session.tenant?.id} />
      <FunnelCard tenantId={session.tenant?.id} />

      <Card className="tile-gradient">
        <CardHeader><CardTitle>The ROAS Flip</CardTitle>
          <CardDescription>Day-0 ROAS is what the ad platforms show you. 90-day LTV:CAC is what actually happened. The ranking reverses.</CardDescription></CardHeader>
        <CardContent>
          <FlipConnect rows={flipRows} />
          <p className="mt-4 text-sm text-muted-foreground">
            <b>{short(top.campaign_name)}</b> ranks #{rankOf(byDay0, top.campaign_id) + 1} on day-0 ROAS but <b>#1 on 90-day LTV:CAC ({num(top.ltv_roas)}×)</b> — the budget it deserves is the opposite of what the platform&apos;s number suggests.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Campaign Scorecard</CardTitle>
          <CardDescription>Margin ROAS &gt; 1 is contribution-positive; below 1 loses money on every dollar.</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase text-muted-foreground">
              <th className="py-2">Campaign</th><th className="text-right">Spend</th><th className="text-right">Cust.</th>
              <th className="text-right">CAC</th><th className="text-right">Day-0 ROAS</th><th className="text-right">90d LTV</th>
              <th className="text-right">LTV ROAS</th><th className="text-right">Margin ROAS</th></tr></thead>
            <tbody>
              {byLtv.map((r) => (
                <tr key={String(r.campaign_id)} className="border-t border-border">
                  <td className="py-2"><span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: pdot(r.platform) }} />{short(r.campaign_name)}</span></td>
                  <td className="text-right">{usd(r.spend)}</td><td className="text-right">{String(r.new_customers)}</td>
                  <td className="text-right">{usd2(r.cac)}</td><td className="text-right">{num(r.day0_roas, 3)}</td>
                  <td className="text-right">{usd(r.ltv_90d)}</td>
                  <td className={'text-right ' + (Number(r.ltv_roas) >= 1 ? 'text-emerald-500' : 'text-rose-500')}>{num(r.ltv_roas)}×</td>
                  <td className={'text-right font-semibold ' + (Number(r.margin_roas) >= 1 ? 'text-emerald-500' : 'text-rose-500')}>{num(r.margin_roas)}×</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>The Click Truth</CardTitle><CardDescription>Platform-reported clicks (dashed) vs. what your site actually recorded (filled). The gap silently corrupts every CPC.</CardDescription></CardHeader>
          <CardContent>
            <div className="space-y-4">
              {clicks.map((r) => {
                const max = Math.max(...clicks.map((c) => Math.max(Number(c.clicks_reported), Number(c.clicks_observed))));
                const wRep = Math.min(100, Number(r.clicks_reported) / max * 100);
                const wObs = Math.min(100, Number(r.clicks_observed) / max * 100);
                const infl = Number(r.inflation_pct);
                return (
                  <div key={String(r.campaign_id)} className="flex items-center gap-3 text-sm">
                    <span className="w-36 shrink-0 text-muted-foreground">{String(r.campaign_id)} · {usd2(r.true_cpc)} CPC</span>
                    <div className="relative h-[9px] flex-1">
                      <div className="bar-track absolute inset-y-0 left-0" style={{ width: `${wRep}%` }} />
                      <div className="bar-observed" style={{ width: `${wObs}%` }} />
                    </div>
                    <span className={'w-12 text-right font-semibold ' + (infl >= 40 ? 'text-rose-400' : infl > 0 ? 'text-muted-foreground' : 'text-emerald-400')}>{infl > 0 ? '+' : ''}{num(infl, 0)}%</span>
                  </div>
                );
              })}
            </div>
            <p className="pt-4 text-xs text-muted-foreground">
              <span className="text-muted-foreground/70">▨ reported</span> · <span className="brand-gradient-text font-semibold">▬ observed</span> · % = click inflation. TikTok claims <b>50% more clicks</b> than your site saw.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>The Creative Angle</CardTitle><CardDescription>Discount-&amp;-urgency affinity of the ad copy vs. the LTV it bought.</CardDescription></CardHeader>
          <CardContent>
            <AngleScatter rows={angleRows} />
            <p className="pt-2 text-xs text-muted-foreground">The trend is <b>inverse</b>: the education-led creative scores <b>negative</b> on discount affinity yet buys the highest LTV, while the &ldquo;70% OFF TODAY&rdquo; creative scores highest and buys the lowest — a near-monotonic reversal.</p>
          </CardContent>
        </Card>
      </div>

      <AskCard />
    </div>
  );
}
