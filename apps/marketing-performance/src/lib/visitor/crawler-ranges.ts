/**
 * Published crawler IP ranges → fast IP lookup. Pure (no fs / network), so it
 * is unit tested directly; the loader that fetches, caches and refreshes the
 * lists lives in crawler-ranges-store.ts.
 *
 * A "range set" is { fetchedAt, sources: { <sourceId>: ["66.249.64.0/27", ...] } }.
 * Lookups mask the address once per prefix length present and probe a Set, so
 * a few thousand prefixes cost a couple of dozen hash lookups per IP.
 */
import { isIP } from 'node:net';
import { ipToBytes, normalizeIp } from './ip';
import type { BotCategory } from './ua';
import sourcesFile from './crawler-sources.json';

export type CrawlerOperator =
  | 'google' | 'bing' | 'openai' | 'anthropic' | 'perplexity' | 'apple' | 'duckduckgo' | 'commoncrawl';

export interface RangeSource {
  id: string;
  operator: CrawlerOperator;
  /** Bot name used when the IP matches but the UA does not name a bot. */
  label: string;
  category: BotCategory;
  url: string;
}

export const RANGE_SOURCES: RangeSource[] = (sourcesFile as { sources: RangeSource[] }).sources;

export interface RangeSet {
  fetchedAt: string; // ISO
  sources: Record<string, string[]>;
}

export interface RangeHit {
  sourceId: string;
  operator: CrawlerOperator;
  label: string;
  category: BotCategory;
  cidr: string;
}

/** Pull CIDRs out of a Google-style {prefixes:[{ipv4Prefix|ipv6Prefix}]} document. Invalid entries are skipped. */
export function parsePrefixes(doc: unknown): string[] {
  const list = (doc as { prefixes?: unknown })?.prefixes;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const p of list) {
    const c = (p as Record<string, unknown>)?.ipv4Prefix ?? (p as Record<string, unknown>)?.ipv6Prefix;
    if (typeof c === 'string' && parseCidr(c)) out.push(c.trim());
  }
  return out;
}

interface ParsedCidr { v: 4 | 6; bits: number; key: bigint }

function bytesToBig(b: number[]): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

function mask(n: bigint, width: number, bits: number): bigint {
  if (bits <= 0) return 0n;
  const shift = BigInt(width - bits);
  return (n >> shift) << shift;
}

export function parseCidr(cidr: string): ParsedCidr | null {
  const [addr, len] = cidr.trim().split('/');
  if (!addr) return null;
  const v = isIP(addr);
  if (v !== 4 && v !== 6) return null;
  const width = v === 4 ? 32 : 128;
  const bits = len === undefined ? width : Number(len);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;
  const bytes = ipToBytes(addr);
  if (!bytes) return null;
  return { v, bits, key: mask(bytesToBig(bytes), width, bits) };
}

const SOURCE_BY_ID = new Map(RANGE_SOURCES.map((s) => [s.id, s]));

export class CrawlerMatcher {
  private readonly v4 = new Map<number, Map<bigint, RangeHit>>();
  private readonly v6 = new Map<number, Map<bigint, RangeHit>>();
  private readonly ops = new Set<CrawlerOperator>();
  readonly fetchedAt: string;
  readonly size: number;

  constructor(set: RangeSet, sources: RangeSource[] = RANGE_SOURCES) {
    const byId = sources === RANGE_SOURCES ? SOURCE_BY_ID : new Map(sources.map((s) => [s.id, s]));
    let size = 0;
    for (const [id, cidrs] of Object.entries(set.sources ?? {})) {
      const src = byId.get(id);
      if (!src || !Array.isArray(cidrs)) continue;
      for (const c of cidrs) {
        const p = parseCidr(c);
        if (!p) continue;
        const table = p.v === 4 ? this.v4 : this.v6;
        let m = table.get(p.bits);
        if (!m) table.set(p.bits, (m = new Map()));
        if (!m.has(p.key)) {
          m.set(p.key, { sourceId: src.id, operator: src.operator, label: src.label, category: src.category, cidr: c });
          size++;
        }
        this.ops.add(src.operator);
      }
    }
    this.size = size;
    this.fetchedAt = set.fetchedAt;
    this.lens4 = [...this.v4.keys()].sort((x, y) => y - x);
    this.lens6 = [...this.v6.keys()].sort((x, y) => y - x);
  }

  private readonly lens4: number[];
  private readonly lens6: number[];

  /** True when we hold a published list for this operator (so a claim can be checked). */
  hasOperator(op: CrawlerOperator): boolean {
    return this.ops.has(op);
  }

  lookup(rawIp: string | null | undefined): RangeHit | null {
    const ip = normalizeIp(rawIp ?? null);
    if (!ip) return null;
    const bytes = ipToBytes(ip);
    if (!bytes) return null;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) → check as IPv4.
    let b = bytes;
    if (b.length === 16 && b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) b = b.slice(12);
    const width = b.length === 4 ? 32 : 128;
    const table = width === 32 ? this.v4 : this.v6;
    const n = bytesToBig(b);
    // Most specific first, so a /32 entry wins over a covering /24.
    const lens = width === 32 ? this.lens4 : this.lens6;
    for (const bits of lens) {
      const hit = table.get(bits)!.get(mask(n, width, bits));
      if (hit) return hit;
    }
    return null;
  }
}
