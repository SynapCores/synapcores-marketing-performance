/**
 * Server-side enforcement of browser privacy signals (Do Not Track `DNT: 1`,
 * Global Privacy Control `Sec-GPC: 1`).
 *
 * The renascai.com snippet promises visitors that DNT/GPC are respected and
 * already declines to load the pixel when either is set. This is the
 * belt-and-braces half: for the hosts listed in COLLECT_PRIVACY_SIGNAL_HOSTS
 * (default renascai.com + www) the collector drops any batch that arrives
 * with either header, so a cached/old snippet can't break the promise.
 * Set COLLECT_PRIVACY_SIGNAL_HOSTS='*' to honour the signals on every site.
 */
const DEFAULT_HOSTS = 'renascai.com,www.renascai.com';

export function privacySignalSet(headers: { get(name: string): string | null }): boolean {
  return headers.get('dnt')?.trim() === '1' || headers.get('sec-gpc')?.trim() === '1';
}

export function honorsPrivacySignals(host: string | null, env: Record<string, string | undefined> = process.env): boolean {
  const list = (env.COLLECT_PRIVACY_SIGNAL_HOSTS ?? DEFAULT_HOSTS)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.includes('*')) return true;
  if (!host) return false;
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return list.includes(h);
}

/** Should this batch be discarded because the visitor opted out? */
export function mustDropForPrivacy(
  headers: { get(name: string): string | null },
  pageHost: string | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return privacySignalSet(headers) && honorsPrivacySignals(pageHost, env);
}
