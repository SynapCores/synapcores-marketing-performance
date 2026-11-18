/** UTM link builder — client-safe (no server imports); used by the builder form and the server action. */
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];

export const CHANNELS = ['youtube', 'reddit', 'email', 'social', 'paid search', 'paid social', 'referral / partner', 'community', 'other'] as const;

export interface CampaignInput {
  siteUrl: string;
  source: string;
  medium: string;
  campaign: string;
  content?: string | null;
  term?: string | null;
}

/** Trim; collapse inner whitespace to '-'; cap length. Keeps the user's case. */
export function cleanParam(v: string | null | undefined, max = 100): string {
  return String(v ?? '').trim().replace(/\s+/g, '-').slice(0, max);
}

/** Validate + build the tagged URL. Existing query params are kept; utm_* are replaced. */
export function buildCampaignUrl(input: CampaignInput): { ok: true; url: string; site: string } | { ok: false; error: string } {
  let raw = String(input.siteUrl ?? '').trim();
  if (!raw) return { ok: false, error: 'Enter the page URL the link should open.' };
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'That URL is not valid.' };
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return { ok: false, error: 'Use a full http(s) URL, e.g. https://werkor.us/' };
  const source = cleanParam(input.source);
  const medium = cleanParam(input.medium);
  const campaign = cleanParam(input.campaign);
  if (!source || !medium || !campaign) return { ok: false, error: 'Source, medium and campaign are required.' };
  const vals: Record<UtmKey, string> = {
    utm_source: source, utm_medium: medium, utm_campaign: campaign,
    utm_content: cleanParam(input.content), utm_term: cleanParam(input.term),
  };
  for (const k of UTM_KEYS) {
    u.searchParams.delete(k);
    if (vals[k]) u.searchParams.set(k, vals[k]);
  }
  return { ok: true, url: u.toString(), site: u.host.toLowerCase().replace(/^www\./, '') };
}

