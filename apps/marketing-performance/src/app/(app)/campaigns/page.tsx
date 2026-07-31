import { AppPageHeader, Card, CardContent } from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import { scorecard } from '@/lib/warehouse';

export const dynamic = 'force-dynamic';

const usd = (n: unknown) => n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
const usd2 = (n: unknown) => n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n: unknown, d = 2) => n == null ? '—' : Number(n).toFixed(d);
const pdot = (p: unknown) => ({ facebook: '#4267B2', tiktok: '#ff0050', google: '#ea4335' } as Record<string, string>)[String(p)] ?? '#888';

export default async function CampaignsPage() {
  await requireSession();
  const sc = (await scorecard()).sort((a, b) => Number(b.spend) - Number(a.spend));

  return (
    <div className="space-y-6">
      <AppPageHeader title="Campaigns" description="Every campaign with its true economics — spend, CAC, day-0 vs 90-day ROAS, and the contribution-margin cut line." />
      <Card><CardContent className="overflow-x-auto pt-6">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs uppercase text-muted-foreground">
            <th className="py-2">Campaign</th><th>Platform</th><th className="text-right">Spend</th><th className="text-right">New Cust.</th>
            <th className="text-right">CAC</th><th className="text-right">Day-0 ROAS</th><th className="text-right">90d LTV</th>
            <th className="text-right">LTV ROAS</th><th className="text-right">Margin ROAS</th><th className="text-right">Verdict</th></tr></thead>
          <tbody>
            {sc.map((r) => {
              const positive = Number(r.margin_roas) >= 1;
              return (
                <tr key={String(r.campaign_id)} className="border-t border-border">
                  <td className="py-2 font-medium">{String(r.campaign_name).replace(/_/g, ' ')}</td>
                  <td><span className="inline-flex items-center gap-2 capitalize"><span className="h-2 w-2 rounded-full" style={{ background: pdot(r.platform) }} />{String(r.platform)}</span></td>
                  <td className="text-right">{usd(r.spend)}</td><td className="text-right">{String(r.new_customers)}</td>
                  <td className="text-right">{usd2(r.cac)}</td><td className="text-right">{num(r.day0_roas, 3)}</td>
                  <td className="text-right">{usd(r.ltv_90d)}</td>
                  <td className="text-right">{num(r.ltv_roas)}×</td>
                  <td className={'text-right font-semibold ' + (positive ? 'text-emerald-500' : 'text-rose-500')}>{num(r.margin_roas)}×</td>
                  <td className="text-right">
                    <span className={'rounded-full px-2 py-0.5 text-xs ' + (positive ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500')}>
                      {positive ? 'Scale' : 'Cut'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent></Card>
    </div>
  );
}
