/**
 * IP retention policy for `pm_events`.
 *
 * The full client IP is kept for IP_RETENTION_DAYS (default 90). After that a
 * scheduled sweep overwrites it with the stored /24 (IPv4) or /48 (IPv6)
 * prefix and flags the row `ip_truncated`. Country/region/city were derived at
 * collection time and stay.
 *
 * Env:
 *   IP_RETENTION_DAYS         full-IP retention in days (default 90, 1..3650)
 *   IP_RETENTION_SWEEP_HOURS  how often the sweep runs (default 6, 1..168)
 *
 * Pure helpers here; the scheduler lives in src/instrumentation.ts and the SQL
 * runs through event-store.ts.
 */
import { sqlTs } from './events';

function bounded(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw == null || raw.trim() === '' || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function retentionDays(env: Record<string, string | undefined> = process.env): number {
  return bounded(env.IP_RETENTION_DAYS, 90, 1, 3650);
}

export function sweepIntervalMs(env: Record<string, string | undefined> = process.env): number {
  return bounded(env.IP_RETENTION_SWEEP_HOURS, 6, 1, 168) * 3600_000;
}

/** Events received before this instant must have their IP truncated. */
export function retentionCutoff(now: Date, days: number): string {
  return sqlTs(new Date(now.getTime() - days * 86400_000));
}

/** The truncation statement (cutoff is a server-generated timestamp, never user input). */
export function truncationSql(cutoff: string): string {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cutoff)) throw new Error('bad cutoff');
  return `UPDATE pm_events SET ip = ip_prefix, ip_truncated = TRUE WHERE received_at < '${cutoff}' AND ip_truncated = FALSE`;
}

/** In-memory equivalent of `truncationSql`, used by tests to pin the semantics. */
export function applyRetention<T extends { ip: unknown; ip_prefix: unknown; ip_truncated: unknown; received_at: unknown }>(
  rows: T[],
  cutoff: string,
): T[] {
  return rows.map((r) =>
    String(r.received_at) < cutoff && r.ip_truncated === false ? { ...r, ip: r.ip_prefix, ip_truncated: true } : r,
  );
}
