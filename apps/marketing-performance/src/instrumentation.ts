/**
 * Server boot hook (Next.js instrumentation). Schedules the pm_events IP
 * retention sweep: shortly after start, then every IP_RETENTION_SWEEP_HOURS
 * (default 6h), full IPs older than IP_RETENTION_DAYS (default 90) are cut to
 * their /24 (IPv4) or /48 (IPv6) prefix. Idempotent — only rows not yet
 * truncated are touched. Set IP_RETENTION_SWEEP=off to disable (e.g. when a
 * separate worker runs it).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.IP_RETENTION_SWEEP === 'off') return;
  if (!process.env.SYNAPCORES_ADMIN_API_KEY) return; // build / tooling context

  const { truncateExpiredIps } = await import('./lib/event-store');
  const { sweepIntervalMs } = await import('./lib/visitor/retention');

  const run = async () => {
    try {
      const r = await truncateExpiredIps();
      console.log(`[retention] pm_events: truncated ${r.updated} IP(s) received before ${r.cutoff} UTC (${r.days}-day window)`);
    } catch (e) {
      console.error('[retention] pm_events sweep failed:', (e as Error).message);
    }
  };
  const first = setTimeout(run, 60_000);
  first.unref?.();
  const every = setInterval(run, sweepIntervalMs());
  every.unref?.();
}
