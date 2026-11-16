import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@synapcores/app-framework';
import { conversionFunnel } from '@/lib/event-store';
import type { FunnelStepResult } from '@/lib/visitor/funnel';

function Steps({ steps }: { steps: FunnelStepResult[] }) {
  const max = Math.max(1, ...steps.map((s) => s.visitors));
  return (
    <ul className="space-y-1.5 text-sm">
      {steps.map((s) => (
        <li key={s.id} className="flex items-center gap-2">
          <span className="w-32 shrink-0 truncate">
            {s.label}
            {s.conversion ? <span className="ml-1 text-[10px] uppercase text-emerald-400">conv</span> : null}
          </span>
          <span className="h-1.5 rounded bg-primary/60" style={{ width: `${(s.visitors / max) * 100}%` }} />
          <span className="ml-auto whitespace-nowrap tabular-nums text-muted-foreground">
            {s.visitors}
            {s.id !== 'visit' && s.pct_of_visits != null ? ` · ${s.pct_of_visits}%` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Dashboard: pixel conversion funnel (humans), last 30 days, overall + per site. */
export default async function FunnelCard({ tenantId }: { tenantId: string | null | undefined }) {
  if (!tenantId) return null;
  let f;
  try {
    f = await conversionFunnel(tenantId, 30);
  } catch {
    return null; // never take the dashboard down over this card
  }
  const any = f.steps.some((s) => s.visitors > 0);
  const conv = f.steps.filter((s) => s.conversion);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversion funnel — last 30 days</CardTitle>
        <CardDescription>
          Human visitors who reached each step via your pixel: visit → pricing → lead → sign-up → checkout → purchase.
          Lead, sign-up and purchase are conversions; % is of visitors.{f.truncated ? ' (Sampled: very high volume.)' : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!any ? (
          <p className="text-sm text-muted-foreground">No funnel events yet in the last 30 days.</p>
        ) : (
          <div className="grid gap-6 md:grid-cols-3">
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">All sites</h4>
              <Steps steps={f.steps} />
              <p className="mt-3 text-xs text-muted-foreground">
                {conv.map((s) => `${s.events} ${s.label.toLowerCase()} event${s.events === 1 ? '' : 's'}`).join(' · ')}
              </p>
            </div>
            {f.sites.slice(0, 2).map((s) => (
              <div key={s.site}>
                <h4 className="mb-2 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.site}</h4>
                <Steps steps={s.steps} />
              </div>
            ))}
          </div>
        )}
        {f.sites.length > 2 ? (
          <table className="mt-6 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-muted-foreground">
                <th className="py-1 pr-3">Site</th>
                {f.steps.map((s) => <th key={s.id} className="pr-3 text-right">{s.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {f.sites.map((site) => (
                <tr key={site.site} className="border-t border-border">
                  <td className="py-1 pr-3">{site.site}</td>
                  {site.steps.map((s) => <td key={s.id} className="pr-3 text-right tabular-nums">{s.visitors}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </CardContent>
    </Card>
  );
}
