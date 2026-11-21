/**
 * Human vs bot verdict from User-Agent AND client IP.
 *
 *   - UA names a bot whose operator publishes IP ranges (Google, Bing, OpenAI,
 *     Anthropic, Perplexity, Apple, DuckDuckGo, Common Crawl):
 *       IP inside that operator's ranges → bot, `verified`
 *       IP elsewhere                     → bot, `unverified` (claims to be it; spoofed or new range)
 *   - UA names a bot with no published list (Yandex, Baidu, Ahrefs, curl, …) → bot, `unverifiable`
 *   - UA looks like a normal browser but the IP is in a crawler range (Google's
 *     renderer fetches with a plain Chrome UA from 66.249.x) → bot, `verified`,
 *     named after the range.
 *   - Otherwise → human.
 *
 * Bump CLASSIFIER_VERSION whenever these rules or the UA table change: stored
 * events with an older `bot_rules_version` are reclassified at boot.
 */
import type { CrawlerMatcher } from './crawler-ranges';
import { botOperator, parseUserAgent, type ParsedUA } from './ua';

export const CLASSIFIER_VERSION = 2;

export type BotVerification = 'verified' | 'unverified' | 'unverifiable';

export interface Classification extends ParsedUA {
  botVerified: BotVerification | null;
}

const GENERIC_NAMES = new Set(['Unknown bot', 'Unknown client', 'Empty user agent', 'Browser automation', 'HeadlessChrome']);

export function classifyVisitor(userAgent: string | null | undefined, ip: string | null | undefined, matcher: CrawlerMatcher | null): Classification {
  const p = parseUserAgent(userAgent);
  const hit = matcher?.lookup(ip ?? null) ?? null;

  if (p.isBot) {
    const op = botOperator(p.botName);
    if (op && matcher?.hasOperator(op)) {
      return { ...p, botVerified: hit?.operator === op ? 'verified' : 'unverified' };
    }
    if (hit && (p.botCategory === 'headless' || p.botCategory === 'tool' || GENERIC_NAMES.has(p.botName ?? ''))) {
      // e.g. HeadlessChrome from Google's ranges = Google's renderer.
      return { ...p, botName: hit.label, botCategory: hit.category, botVerified: 'verified' };
    }
    return { ...p, botVerified: hit ? 'verified' : 'unverifiable' };
  }
  if (hit) {
    return { ...p, isBot: true, botName: hit.label, botCategory: hit.category, deviceType: 'bot', botVerified: 'verified' };
  }
  return { ...p, botVerified: null };
}

/** "verified Googlebot" / "claims Googlebot, unverified" / "Googlebot". */
export function botLabel(name: string | null, verified: string | null | undefined): string {
  const n = name ?? 'Unknown bot';
  if (verified === 'verified') return `verified ${n}`;
  if (verified === 'unverified') return `claims ${n}, unverified`;
  return n;
}
