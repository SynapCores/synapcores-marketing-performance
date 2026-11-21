import { AppPageHeader, Card, CardContent, CardHeader, CardTitle, CardDescription } from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import { attribution } from '@/lib/warehouse';

export const dynamic = 'force-dynamic';

const usd2 = (n: unknown) => n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pdot = (p: unknown) => ({ facebook: '#4267B2', tiktok: '#ff0050', google: '#ea4335' } as Record<string, string>)[String(p)] ?? '#888';

export default async function AttributionPage() {
  const session = await requireSession();
  const rows = await attribution(session.tenant?.id);

  return (
    <div className="space-y-6">
      <AppPageHeader title="Attribution" description="Last-touch across all platforms — a ROW_NUMBER over your own clickstream. The join the ad platforms structurally cannot do." />
      <Card>
        <CardHeader><CardTitle>Attribution ledger</CardTitle>
          <CardDescription>Each conversion resolved to the most recent pre-conversion click, within a 30-day lookback.</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase text-muted-foreground">
              <th className="py-2">Conv.</th><th>Visitor</th><th>Customer</th><th>Credited campaign</th><th>Platform</th><th className="text-right">1st order</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const proof = Number(r.conversion_id) === 1 || Number(r.conversion_id) === 11;
                return (
                  <tr key={String(r.conversion_id)} className={'border-t border-border ' + (proof ? 'bg-primary/5' : '')}>
                    <td className="py-2">#{String(r.conversion_id)}</td>
                    <td>{String(r.anonymous_id)}</td>
                    <td>{String(r.customer_id)}</td>
                    <td>{String(r.campaign_name ?? r.campaign_id).replace(/_/g, ' ')}</td>
                    <td><span className="inline-flex items-center gap-2 capitalize"><span className="h-2 w-2 rounded-full" style={{ background: pdot(r.platform) }} />{String(r.platform)}</span></td>
                    <td className="text-right">{usd2(r.first_order_revenue)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > 0 && (
            <div className="mt-4 rounded-md border-l-2 border-primary bg-muted px-4 py-3 text-xs text-muted-foreground">
              <b className="text-primary">Conversion #11</b> is credited to Google non-brand, not TikTok — TikTok would have claimed it in its own dashboard; last-touch across all platforms corrects the cross-platform steal. <b className="text-primary">Conversion #1</b> ignores a retargeting click that happened 12 days <i>after</i> the purchase (the <code>click ≤ conversion</code> guard).
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
