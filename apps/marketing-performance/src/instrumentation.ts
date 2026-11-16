/**
 * Server boot hook (Next.js instrumentation).
 *
 * 1. pm_events IP retention sweep: shortly after start, then every
 *    IP_RETENTION_SWEEP_HOURS (default 6h), full IPs older than
 *    IP_RETENTION_DAYS (default 90) are cut to their /24 (IPv4) or /48 (IPv6)
 *    prefix. Idempotent — only rows not yet truncated are touched. Set
 *    IP_RETENTION_SWEEP=off to disable (e.g. when a separate worker runs it).
 *
 * 2. Crawler IP ranges: refreshed from the operators' published lists at boot
 *    when the cached copy is older than a day, then every
 *    CRAWLER_RANGES_REFRESH_HOURS (default 24). After the boot refresh, stored
 *    events classified by an older rule version are reclassified (backfill).
 *    CRAWLER_RANGES_REFRESH=off keeps the cached/bundled lists.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!process.env.SYNAPCORES_ADMIN_API_KEY) return; // build / tooling context

  if (process.env.IP_RETENTION_SWEEP !== 'off') {
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

  const { getCrawlerMatcher, rangesAgeMs, refreshCrawlerRanges, refreshIntervalMs } = await import('./lib/visitor/crawler-ranges-store');
  const { reclassifyEvents } = await import('./lib/event-store');
  const refresh = async () => {
    if (process.env.CRAWLER_RANGES_REFRESH === 'off') return;
    try {
      const r = await refreshCrawlerRanges();
      console.log(`[crawlers] ranges refreshed: ${r.ok.length} list(s) ok, ${r.failed.length} failed${r.failed.length ? ' (' + r.failed.map((f) => f.id).join(', ') + ')' : ''}; ${r.prefixes} prefixes`);
    } catch (e) {
      console.error('[crawlers] range refresh failed:', (e as Error).message);
    }
  };
  const boot = setTimeout(async () => {
    if (rangesAgeMs() > refreshIntervalMs()) await refresh();
    try {
      const r = await reclassifyEvents(getCrawlerMatcher());
      if (r.scanned) {
        console.log(`[crawlers] reclassified pm_events: scanned ${r.scanned}, changed ${r.changed}; events human/bot before ${r.before.human}/${r.before.bot}, after ${r.after.human}/${r.after.bot}`);
      }
    } catch (e) {
      console.error('[crawlers] reclassify failed:', (e as Error).message);
    }
  }, 15_000);
  boot.unref?.();
  const daily = setInterval(refresh, refreshIntervalMs());
  daily.unref?.();
}
