/** Shared display helpers for the Visitors pages and the dashboard card. */

export function flag(cc: string | null | undefined): string {
  if (!cc || !/^[A-Za-z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...cc.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function place(v: { city?: string | null; region?: string | null; country?: string | null; country_name?: string | null }): string {
  const parts = [v.city, v.region, v.country_name ?? v.country].filter((x): x is string => !!x);
  return parts.length ? parts.join(', ') : '—';
}

export function when(ts: unknown): string {
  if (ts == null || ts === '') return '—';
  const s = String(ts).replace('T', ' ').slice(0, 19);
  return `${s} UTC`;
}

export function BotBadge({ isBot, name, category }: { isBot: boolean; name?: string | null; category?: string | null }) {
  if (!isBot) return <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-500">human</span>;
  const ai = category === 'ai';
  return (
    <span
      title={category ? `${category} bot` : 'bot'}
      className={'rounded px-1.5 py-0.5 text-[11px] font-medium ' + (ai ? 'bg-violet-500/15 text-violet-400' : 'bg-amber-500/15 text-amber-500')}
    >
      {ai ? 'AI bot' : 'bot'}{name ? ` · ${name}` : ''}
    </span>
  );
}

export const GEO_ATTRIBUTION = (
  <>IP geolocation by <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer" className="underline">DB-IP</a> (IP to City Lite, CC BY 4.0).</>
);
