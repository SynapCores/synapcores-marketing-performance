'use client';

import { useSyncExternalStore } from 'react';

const noopSubscribe = () => () => {};

/** Parse an engine timestamp ('YYYY-MM-DD HH:MM:SS', UTC) or ISO string. */
export function parseUtc(ts: string | number | Date): Date | null {
  if (ts instanceof Date) return Number.isNaN(ts.getTime()) ? null : ts;
  if (typeof ts === 'number') return new Date(ts);
  const s = String(ts).trim();
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A timestamp in the viewer's locale and time zone, without a hydration
 * mismatch: the server (UTC, en-US) and the browser format dates differently,
 * so the server render and the hydration pass both print the same
 * locale-independent UTC string, and the browser switches to its local
 * format right after hydration.
 */
export function LocalTime({ value }: { value: string | number | Date }) {
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const d = parseUtc(value);
  if (!d) return <>{String(value)}</>;
  const text = hydrated ? d.toLocaleString() : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return <time dateTime={d.toISOString()}>{text}</time>;
}
