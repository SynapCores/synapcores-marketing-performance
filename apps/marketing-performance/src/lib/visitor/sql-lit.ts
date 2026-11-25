/**
 * SQL literal for a JS value (moved out of event-store.ts unchanged, so the
 * pure pm_events_v2 helpers and their tests can use the same escaping).
 */
export function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  // Standard SQL literal: the engine treats backslash literally, so doubling
  // single quotes is a complete escape. NULs are stripped.
  return `'${String(v).replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}
