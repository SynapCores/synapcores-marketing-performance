import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@synapcores/app-framework';
import { visitorBreakdown } from '@/lib/event-store';
import { flag } from '../visitors/format';
import { botLabel } from '@/lib/visitor/classify';

/** Dashboard: humans vs bots (incl. AI crawlers) and top countries, last 30 days. */
export default async function VisitorCard({ tenantId }: { tenantId: string | null | undefined }) {
  if (!tenantId) return null;
  let b;
  try {
    b = await visitorBreakdown(tenantId, 30);
  } catch {
    return null; // never take the dashboard down over this card
  }
  const totalV = b.humans.visitors + b.bots.visitors + b.internal.visitors + b.suspected.visitors;
  const nonHuman = b.bots.visitors + b.suspected.visitors;
  const botPct = totalV ? Math.round((nonHuman / Math.max(1, totalV - b.internal.visitors)) * 100) : 0;
  const maxC = Math.max(1, ...b.countries.map((c) => c.visitors));
  const aiEvents = b.bots_by_name.filter((x) => x.bot_category === 'ai').reduce((n, x) => n + x.events, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Visitors — last 30 days</CardTitle>
        <CardDescription>Humans vs. bots (including AI crawlers) and where your human visitors are. <Link href="/visitors" className="underline">See every visitor →</Link></CardDescription>
      </CardHeader>
      <CardContent>
        {totalV === 0 ? (
          <p className="text-sm text-muted-foreground">No pixel traffic yet in the last 30 days.</p>
        ) : (
          <div className="grid gap-6 md:grid-cols-3">
            <div className="space-y-3">
              <Link href="/visitors?kind=human" className="flex items-baseline justify-between text-sm"><span>Humans</span><span className="text-xl font-bold tabular-nums">{b.humans.visitors}</span></Link>
              <Link href="/visitors?kind=bot" className="flex items-baseline justify-between text-sm"><span>Bots</span><span className="text-xl font-bold tabular-nums">{b.bots.visitors}</span></Link>
              <Link href="/visitors?kind=suspected" className="flex items-baseline justify-between text-sm"><span>Suspected bots <span className="text-xs text-muted-foreground">(bursts, data centres)</span></span><span className="font-semibold tabular-nums">{b.suspected.visitors}</span></Link>
              <Link href="/visitors?kind=internal" className="flex items-baseline justify-between text-sm"><span>Internal <span className="text-xs text-muted-foreground">(our IPs)</span></span><span className="font-semibold tabular-nums">{b.internal.visitors}</span></Link>
              <div className="h-2 w-full overflow-hidden rounded bg-emerald-500/30">
                <div className="h-full bg-amber-500" style={{ width: `${botPct}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">{botPct}% of outside visitors are bots or suspected bots · {b.humans.events} human / {b.bots.events} bot events{aiEvents ? ` · ${aiEvents} from AI bots` : ''}</p>
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Top countries (humans)</h4>
              {b.countries.length === 0 ? <p className="text-sm text-muted-foreground">—</p> : (
                <ul className="space-y-1.5 text-sm">
                  {b.countries.map((c) => (
                    <li key={c.country}>
                      <Link href={`/visitors?country=${c.country}&kind=human`} className="flex items-center gap-2">
                        <span className="w-32 shrink-0 truncate">{flag(c.country)} {c.country_name}</span>
                        <span className="h-1.5 rounded bg-primary/60" style={{ width: `${(c.visitors / maxC) * 100}%` }} />
                        <span className="ml-auto tabular-nums text-muted-foreground">{c.visitors}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Bots by name</h4>
              {b.bots_by_name.length === 0 ? <p className="text-sm text-muted-foreground">No bots seen.</p> : (
                <ul className="space-y-1.5 text-sm">
                  {b.bots_by_name.map((x) => (
                    <li key={`${x.bot_name}|${x.bot_verified ?? ''}`} className="flex items-center justify-between gap-2">
                      <span className="truncate">{botLabel(x.bot_name, x.bot_verified)} <span className={'text-[11px] ' + (x.bot_category === 'ai' ? 'text-violet-400' : 'text-muted-foreground')}>{x.bot_category}</span></span>
                      <span className="tabular-nums text-muted-foreground">{x.events}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
