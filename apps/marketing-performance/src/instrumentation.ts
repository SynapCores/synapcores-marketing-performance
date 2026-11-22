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
 *
 * 3. Report query cache (lib/report-db.ts): logs its settings at boot and its
 *    hit/miss counters every 15 min when there was report traffic.
 *
 * 4. Installs feed (lib/installs-store.ts): when INSTALLS_FEED_DIR is set, the
 *    sanitized drop files written by the telemetry export job
 *    (installs-v1.jsonl, github-downloads-v1.jsonl) are imported into
 *    pm_install_feed ~45 s after boot, then every INSTALLS_FEED_IMPORT_MINUTES.
 *    A file whose size + mtime didn't change is skipped; a file that fails
 *    validation is logged ("rejected") and the stored rows stay. One log line
 *    per import that changed rows or was refused. Env:
 *      INSTALLS_FEED_DIR                  drop directory (prod /var/lib/synapcores-installs-feed);
 *                                         unset = feature off (no import, no Installs page)
 *      INSTALLS_FEED_TENANT_ID            workspace id that owns the rows and sees the Installs
 *                                         page; required when INSTALLS_FEED_DIR is set
 *      INSTALLS_FEED_IMPORT_MINUTES       import interval in minutes, default 5
 *      INSTALLS_FEED_MAX_DELETE_FRACTION  refuse an import that would delete more than
 *                                         max(10, fraction × stored rows); default 0.5. A salt
 *                                         rotation (header salt_id changed) is always allowed.
 *      INSTALLS_DOWNLOAD_SITES            sites whose /download page feeds the funnel tile,
 *                                         default "synapcores.com,www.synapcores.com"
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!process.env.SYNAPCORES_ADMIN_API_KEY) return; // build / tooling context

  {
    const { reportCache } = await import('./lib/report-db');
    const c = reportCache();
    console.log(
      c.enabled
        ? `[report-cache] on: ttl ${c.ttlMs} ms, max ${c.maxEntries} entries / ${(c.maxBytes / 1048576).toFixed(1)} MiB (entry cap ${(c.maxEntryBytes / 1048576).toFixed(1)} MiB)`
        : '[report-cache] off (QUERY_CACHE_TTL_MS=0)',
    );
    let seen = '';
    const logStats = () => {
      const s = c.stats();
      const sig = `${s.hits}/${s.misses}`;
      if (sig === seen) return;
      seen = sig;
      console.log(
        `[report-cache] hits ${s.hits}, misses ${s.misses}, bypassed ${s.bypassed}, entries ${s.entries} (~${(s.bytes / 1048576).toFixed(1)} MiB), evictions ${s.evictions}, too large ${s.tooLarge}, invalidations ${s.invalidations}`,
      );
    };
    const statsTimer = setInterval(logStats, 15 * 60_000);
    statsTimer.unref?.();
  }

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

  if (process.env.INSTALLS_FEED_DIR) {
    const { importInstallsFeed, importIntervalMs } = await import('./lib/installs-store');
    const { describeImport } = await import('./lib/installs/feed');
    const run = async () => {
      try {
        for (const r of await importInstallsFeed()) {
          const line = describeImport(r);
          if (line) console.log(line);
        }
      } catch (e) {
        console.error('[installs-feed] import failed:', (e as Error).message);
      }
    };
    const first = setTimeout(run, 45_000);
    first.unref?.();
    const every = setInterval(run, importIntervalMs());
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
