'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { browserTimeZone, readTzPref, subscribeTz, useDisplayTimeZone, writeTzPref } from './LocalTime';

const COMMON = [
  'UTC',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
  'America/Toronto', 'America/Mexico_City', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Madrid', 'Europe/Paris', 'Europe/Berlin',
  'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
];

function allZones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const list = fn ? fn('timeZone') : [];
    return list.length ? list : COMMON;
  } catch {
    return COMMON;
  }
}

/** "Times shown in: [Browser (America/New_York) ▾]" — stored per browser. */
export function TimeZonePicker() {
  const pref = useSyncExternalStore(subscribeTz, readTzPref, () => 'auto');
  const detected = useSyncExternalStore(subscribeTz, browserTimeZone, () => '');
  // Full zone list only after hydration (the server can't match the browser's list).
  const hydrated = useSyncExternalStore(subscribeTz, () => true, () => false);
  const rest = useMemo(() => (hydrated ? allZones().filter((z) => !COMMON.includes(z)) : []), [hydrated]);
  const common = pref !== 'auto' && !COMMON.includes(pref) && !rest.includes(pref) ? [pref, ...COMMON] : COMMON;

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="whitespace-nowrap">Times shown in</span>
      <select
        aria-label="Time zone for dates and times"
        value={pref}
        onChange={(e) => writeTzPref(e.target.value)}
        className="h-8 max-w-[260px] rounded-md border border-border bg-background px-2 text-xs text-foreground"
      >
        <option value="auto">{detected ? `My time zone (${detected})` : 'My time zone'}</option>
        <optgroup label="Common">
          {common.map((z) => <option key={z} value={z}>{z}</option>)}
        </optgroup>
        {rest.length > 0 && (
          <optgroup label="All time zones">
            {rest.map((z) => <option key={z} value={z}>{z}</option>)}
          </optgroup>
        )}
      </select>
    </label>
  );
}

/** Hidden form field carrying the viewer's display zone, so date filters use local days. */
export function TzField() {
  const tz = useDisplayTimeZone();
  return <input type="hidden" name="tz" value={tz ?? 'UTC'} />;
}
