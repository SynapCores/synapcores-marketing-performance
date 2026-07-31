import { AppPageHeader, Card, CardContent, CardHeader, CardTitle, CardDescription } from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import { creativeAngle } from '@/lib/warehouse';

export const dynamic = 'force-dynamic';

const usd = (n: unknown) => n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
const num = (n: unknown, d = 2) => n == null ? '—' : Number(n).toFixed(d);

export default async function CreativePage() {
  await requireSession();
  const rows = await creativeAngle(); // sorted by discount_affinity DESC

  return (
    <div className="space-y-6">
      <AppPageHeader title="Creative" description="Every ad's copy is embedded (EMBED → 384-dim) and scored against a discount-&-urgency angle with COSINE_SIMILARITY. The angle — not the channel — predicts customer LTV." />
      {rows.length === 0 ? (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">No creative ingested yet.</CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((r) => {
            const aff = Number(r.discount_affinity);
            const hot = aff > 0.3;
            return (
              <Card key={String(r.campaign_id)}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{String(r.campaign_name).replace(/_/g, ' ')}</CardTitle>
                    <span className={'rounded-full px-2 py-0.5 text-xs ' + (hot ? 'bg-rose-500/15 text-rose-500' : 'bg-emerald-500/15 text-emerald-500')}>
                      affinity {num(r.discount_affinity, 3)}
                    </span>
                  </div>
                  <CardDescription className="italic">&ldquo;{String(r.headline)}&rdquo;</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-6 text-sm">
                    <div><span className="text-muted-foreground">90-day LTV</span><div className="text-lg font-semibold">{usd(r.ltv_90d)}</div></div>
                    <div><span className="text-muted-foreground">LTV ROAS</span><div className={'text-lg font-semibold ' + (Number(r.ltv_roas) >= 1 ? 'text-emerald-500' : 'text-rose-500')}>{num(r.ltv_roas)}×</div></div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        Sorted by discount affinity. The education-led comparison ad scores lowest (even negative) and produced the highest LTV; the &ldquo;70% OFF TODAY&rdquo; creative scores highest and produced the lowest. Angle beats channel.
      </p>
    </div>
  );
}
