/**
 * First-touch traffic source label for a visitor, from their earliest event:
 * explicit UTM → paid click id → external referrer → direct.
 */
export function visitorSource(first: Record<string, unknown>): string {
  const s = (k: string) => {
    const v = first[k];
    return v == null || v === '' ? null : String(v);
  };
  const utm = s('utm_source');
  if (utm) return s('utm_medium') ? `${utm} / ${s('utm_medium')}` : utm;
  if (s('gclid')) return 'google / cpc';
  if (s('fbclid')) return 'facebook / paid';
  if (s('ttclid')) return 'tiktok / paid';
  if (s('msclkid')) return 'bing / cpc';
  const ref = s('referrer_domain');
  const site = (s('site') ?? '').replace(/^www\./, '').replace(/:\d+$/, '').toLowerCase();
  if (ref && ref !== site) return `${ref} / referral`;
  return 'direct';
}
