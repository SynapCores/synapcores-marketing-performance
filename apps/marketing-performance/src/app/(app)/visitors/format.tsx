/** Shared display helpers for the Visitors pages and the dashboard card. */
import { botLabel } from '@/lib/visitor/classify';
import { LocalTime } from '@/components/LocalTime';

export function flag(cc: string | null | undefined): string {
  if (!cc || !/^[A-Za-z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...cc.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function place(v: { city?: string | null; region?: string | null; country?: string | null; country_name?: string | null }): string {
  const parts = [v.city, v.region, v.country_name ?? v.country].filter((x): x is string => !!x);
  return parts.length ? parts.join(', ') : '—';
}

/** A stored (UTC) timestamp, shown in the viewer's chosen time zone. */
export function when(ts: unknown) {
  if (ts == null || ts === '') return '—';
  return <LocalTime value={ts instanceof Date || typeof ts === 'number' ? ts : String(ts)} />;
}

export function BotBadge({ isBot, name, category, verified }: { isBot: boolean; name?: string | null; category?: string | null; verified?: string | null }) {
  if (!isBot) return <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-500">human</span>;
  const ai = category === 'ai';
  return (
    <span
      title={(category ? `${category} bot` : 'bot') + (verified === 'verified' ? ' — IP is in the operator\'s published crawler ranges' : verified === 'unverified' ? ' — IP is NOT in the operator\'s published ranges (likely spoofed)' : '')}
      className={'rounded px-1.5 py-0.5 text-[11px] font-medium ' + (ai ? 'bg-violet-500/15 text-violet-400' : 'bg-amber-500/15 text-amber-500')}
    >
      {ai ? 'AI bot' : 'bot'}{name || verified ? ` · ${botLabel(name ?? null, verified)}` : ''}
    </span>
  );
}

export const GEO_ATTRIBUTION = (
  <>IP geolocation by <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer" className="underline">DB-IP</a> (IP to City Lite, CC BY 4.0).</>
);

const KIND_STYLE: Record<string, string> = {
  internal: 'bg-sky-500/15 text-sky-500',
  suspected: 'bg-orange-500/15 text-orange-500',
};

/** Human / internal / suspected / bot badge with the reason on hover. */
export function KindBadge({ kind, reason, isBot, name, category, verified }: {
  kind: 'human' | 'internal' | 'suspected' | 'bot'; reason?: string | null;
  isBot: boolean; name?: string | null; category?: string | null; verified?: string | null;
}) {
  if (kind === 'internal' || kind === 'suspected') {
    return (
      <span title={reason ?? ''} className={'inline-block max-w-[220px] truncate rounded px-1.5 py-0.5 align-bottom text-[11px] font-medium ' + KIND_STYLE[kind]}>
        {kind === 'internal' ? 'internal' : 'suspected bot'}{reason ? ` · ${reason.replace(/^internal IP /, '')}` : ''}
      </span>
    );
  }
  return <BotBadge isBot={kind === 'bot' || isBot} name={name} category={category} verified={verified} />;
}
