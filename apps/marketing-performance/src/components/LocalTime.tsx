'use client';

import { useSyncExternalStore } from 'react';
import { formatInZone, parseUtc } from '@/lib/timezone';

/**
 * Display time zone for every timestamp in the app.
 *
 * The engine stores timestamps in UTC. Each viewer picks how to see them:
 *   'auto' (default) → the browser's own time zone (Intl resolvedOptions)
 *   'UTC'            → raw UTC
 *   any IANA name    → that zone (e.g. 'America/Los_Angeles')
 *
 * The choice lives in localStorage (per browser) and every <LocalTime>
 * re-renders when it changes, in this tab and in other open tabs.
 */
export const TZ_STORAGE_KEY = 'mp_tz';
const TZ_EVENT = 'mp-tz-change';

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The stored preference: 'auto', 'UTC' or an IANA zone. */
export function readTzPref(): string {
  try {
    const v = window.localStorage.getItem(TZ_STORAGE_KEY);
    if (!v || v === 'auto') return 'auto';
    return isValidZone(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeTzPref(pref: string): void {
  try {
    if (pref === 'auto') window.localStorage.removeItem(TZ_STORAGE_KEY);
    else window.localStorage.setItem(TZ_STORAGE_KEY, pref);
  } catch {
    /* private mode: the choice just won't persist */
  }
  window.dispatchEvent(new Event(TZ_EVENT));
}

export function subscribeTz(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => { if (e.key === TZ_STORAGE_KEY || e.key === null) cb(); };
  window.addEventListener(TZ_EVENT, cb);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(TZ_EVENT, cb);
    window.removeEventListener('storage', onStorage);
  };
}

/** Resolved zone to format with; null during SSR / hydration. */
export function useDisplayTimeZone(): string | null {
  return useSyncExternalStore(
    subscribeTz,
    () => { const p = readTzPref(); return p === 'auto' ? browserTimeZone() : p; },
    () => null,
  );
}

export { parseUtc, looksLikeTimestamp, formatInZone } from '@/lib/timezone';

/**
 * A UTC timestamp rendered in the viewer's chosen time zone.
 * Server render + hydration print UTC (identical on both sides, so no
 * hydration mismatch); the browser switches to the chosen zone right after.
 */
export function LocalTime({
  value, seconds = true, zoneName = true, fallback = '—',
}: {
  value: string | number | Date | null | undefined;
  seconds?: boolean;
  zoneName?: boolean;
  fallback?: string;
}) {
  const tz = useDisplayTimeZone();
  if (value == null || value === '') return <>{fallback}</>;
  const d = parseUtc(value);
  if (!d) return <>{String(value)}</>;
  const text = formatInZone(d, tz ?? 'UTC', { seconds, zoneName });
  return <time dateTime={d.toISOString()} title={`${formatInZone(d, 'UTC')}`}>{text}</time>;
}
