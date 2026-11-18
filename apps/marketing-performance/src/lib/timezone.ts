/** Pure timestamp helpers (UTC storage → display zone). No React, unit tested. */

/** Parse an engine timestamp ('YYYY-MM-DD HH:MM:SS', UTC) or ISO string. */
export function parseUtc(ts: string | number | Date): Date | null {
  if (ts instanceof Date) return Number.isNaN(ts.getTime()) ? null : ts;
  if (typeof ts === 'number') return new Date(ts);
  // Trim sub-millisecond digits (the engine emits nanoseconds) so Date can parse it.
  const s = String(ts).trim().replace(/(\.\d{3})\d+/, '$1');
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Looks like an engine/ISO timestamp (used by the generic table explorer). */
export function looksLikeTimestamp(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(v.trim());
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD HH:MM:SS' in `tz`, plus its short zone name (EST, GMT+1, UTC…). */
export function formatInZone(d: Date, tz: string, opts: { seconds?: boolean; zoneName?: boolean } = {}): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'short',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const time = `${get('hour')}:${get('minute')}${opts.seconds === false ? '' : `:${get('second')}`}`;
  const base = `${get('year')}-${get('month')}-${get('day')} ${time}`;
  return opts.zoneName === false ? base : `${base} ${get('timeZoneName')}`;
}


/** Offset of `tz` from UTC at instant `ms`, in minutes (New York in winter → -300). */
export function zoneOffsetMinutes(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Local midnight of `day` (YYYY-MM-DD) in `tz`, as an engine UTC timestamp
 * ('YYYY-MM-DD HH:MM:SS'). `addDays` shifts the day first (1 → next midnight,
 * used as an exclusive upper bound for an inclusive "to" date).
 */
export function zonedDayStartUtc(day: string, tz: string, addDays = 0): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + addDays);
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  // Two passes settle the offset across DST changes.
  let ms = wall - zoneOffsetMinutes(wall, zone) * 60000;
  ms = wall - zoneOffsetMinutes(ms, zone) * 60000;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}
