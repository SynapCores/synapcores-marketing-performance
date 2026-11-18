import { notFound } from 'next/navigation';
import { AppPageHeader, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import { visitorContext, visitorEvents } from '@/lib/event-store';
import { visitorSource } from '@/lib/visitor/source';
import { GEO_ATTRIBUTION, KindBadge, flag, place, when } from '../format';

export const dynamic = 'force-dynamic';

type Row = Record<string, unknown>;
const s = (v: unknown) => (v == null || v === '' ? null : String(v));
const isTrue = (v: unknown) => v === true || v === 1 || v === 'true';

function propsPreview(raw: unknown): string | null {
  const t = s(raw);
  if (!t) return null;
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    // url/path/title/referrer are already shown as columns.
    for (const k of ['url', 'path', 'title', 'referrer']) delete o[k];
    const out = JSON.stringify(o);
    return out === '{}' ? null : out.length > 300 ? out.slice(0, 300) + '…' : out;
  } catch {
    return t.slice(0, 300);
  }
}

export default async function VisitorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const tenantId = session.tenant?.id;
  if (!tenantId) notFound();
  const { id } = await params;
  const anonymousId = decodeURIComponent(id);
  const [events, ctx] = await Promise.all([visitorEvents(tenantId, anonymousId), visitorContext(tenantId)]);
  if (!events.length) notFound();

  const first = events[0]!;
  const last = events[events.length - 1]!;
  const isBot = events.some((e) => isTrue(e.is_bot));
  const botRow = [...events].reverse().find((e) => isTrue(e.is_bot)) ?? last;
  const verdict = ctx.kinds.get(anonymousId) ?? { kind: isBot ? 'bot' as const : 'human' as const, reason: null };
  const touches = ctx.touches.get(anonymousId) ?? [];
  const ips = Array.from(new Set(events.map((e) => s(e.ip)).filter(Boolean))) as string[];

  // Group the timeline by session, in order of first appearance.
  const sessions = new Map<string, Row[]>();
  for (const e of events) {
    const k = s(e.session_id) ?? '(no session)';
    if (!sessions.has(k)) sessions.set(k, []);
    sessions.get(k)!.push(e);
  }

  const facts: Array<[string, React.ReactNode]> = [
    ['Visitor id', <span key="id" className="font-mono text-xs">{anonymousId}</span>],
    ['Type', <span key="b" className="space-x-2"><KindBadge kind={verdict.kind} reason={verdict.reason} isBot={isBot} name={s(botRow.bot_name)} category={s(botRow.bot_category)} verified={s(botRow.bot_verified)} />{verdict.reason && <span className="text-xs text-muted-foreground">{verdict.reason}</span>}</span>],
    ['Location', <span key="l">{flag(s(last.country))} {place({ city: s(last.city), region: s(last.region), country: s(last.country), country_name: s(last.country_name) })}</span>],
    ['IP address', <span key="ip" className="font-mono text-xs">{ips.join(', ') || '—'}{isTrue(last.ip_truncated) ? ' (truncated after retention window)' : ''}</span>],
    ['Time zone · language', `${s(last.timezone) ?? '—'} · ${s(last.language) ?? '—'}`],
    ['Device', `${s(last.device_type) ?? '—'}${last.screen_w ? ` · screen ${last.screen_w}×${last.screen_h}` : ''}${last.viewport_w ? ` · viewport ${last.viewport_w}×${last.viewport_h}` : ''}`],
    ['Browser · OS', `${[s(last.browser), s(last.browser_version)].filter(Boolean).join(' ') || '—'} · ${[s(last.os), s(last.os_version)].filter(Boolean).join(' ') || '—'}`],
    ['User agent', <span key="ua" className="break-all font-mono text-[11px]">{s(last.user_agent) ?? '—'}</span>],
    ['First touch', `${visitorSource(first)} → ${s(first.site) ?? ''}${s(first.page_path) ?? ''}`],
    ['Referrer (first)', s(first.referrer) ?? '—'],
    ['Campaign (first)', [s(first.utm_campaign), s(first.utm_term), s(first.utm_content)].filter(Boolean).join(' · ') || '—'],
    ['UTM touches', touches.length ? touches.map((t) => `${when(t.first_at)}: ${[t.utm_source, t.utm_medium, t.utm_campaign, t.utm_content].map((x) => x ?? '—').join(' / ')}`).join(' · ') : '—'],
    ['Click ids', [['gclid', first.gclid], ['fbclid', first.fbclid], ['ttclid', first.ttclid], ['msclkid', first.msclkid]].filter(([, v]) => s(v)).map(([k]) => k).join(', ') || '—'],
    ['First / last seen', `${when(first.occurred_at)} → ${when(last.occurred_at)}`],
    ['Activity', `${events.length} events · ${sessions.size} session${sessions.size === 1 ? '' : 's'}`],
  ];

  return (
    <div className="space-y-6">
      <AppPageHeader
        title={`Visitor ${anonymousId.slice(0, 8)}…`}
        back={{ href: '/visitors', label: 'Visitors' }}
        description={GEO_ATTRIBUTION}
      />

      <Card>
        <CardHeader><CardTitle>Profile</CardTitle><CardDescription>From the most recent event unless marked “first”.</CardDescription></CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-[180px_1fr]">
            {facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      {Array.from(sessions.entries()).map(([sid, evs]) => (
        <Card key={sid}>
          <CardHeader>
            <CardTitle className="text-base">Session <span className="font-mono text-sm">{sid.slice(0, 8)}</span></CardTitle>
            <CardDescription>{when(evs[0]!.occurred_at)} → {when(evs[evs.length - 1]!.occurred_at)} · {evs.length} events · {s(evs[0]!.site) ?? ''}</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3">Time (UTC)</th><th className="pr-3">Event</th><th className="pr-3">Page</th><th className="pr-3">Referrer</th><th>Details</th>
                </tr>
              </thead>
              <tbody>
                {evs.map((e) => (
                  <tr key={String(e.event_id)} className="border-t border-border align-top">
                    <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-xs">{String(e.occurred_at ?? '').replace('T', ' ').slice(0, 19)}</td>
                    <td className="pr-3"><span className="rounded bg-muted px-1.5 py-0.5 text-xs">{s(e.event_type)}</span></td>
                    <td className="pr-3">
                      <div className="max-w-[320px] truncate" title={s(e.page_url) ?? ''}>{s(e.page_path) ?? '—'}</div>
                      <div className="max-w-[320px] truncate text-xs text-muted-foreground">{s(e.page_title) ?? ''}</div>
                    </td>
                    <td className="max-w-[200px] truncate pr-3 text-xs" title={s(e.referrer) ?? ''}>{s(e.referrer_domain) ?? '—'}</td>
                    <td className="max-w-[360px] break-all font-mono text-[11px] text-muted-foreground">{propsPreview(e.properties) ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
