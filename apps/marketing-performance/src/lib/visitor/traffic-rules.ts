/**
 * Workspace traffic rules: which IPs are our own ("internal") and how bursts
 * are detected. One place, configured by environment so ops can change it
 * without a release:
 *
 *   VISITOR_INTERNAL_IPS   comma/newline separated entries "cidr[ label]",
 *                          e.g. "136.57.16.0/24 office, 100.51.180.101 agentNet"
 *   VISITOR_DATACENTER_IPS extra CIDRs to treat as data-centre traffic (same format),
 *                          on top of the hosting-ASN list in asn.ts
 *   VISITOR_BURST_MIN      visitors needed to call a burst (default 5)
 *   VISITOR_BURST_WINDOW_S window in seconds (default 60)
 *
 * Pure (env passed in), so it is unit tested directly.
 */
import { isIP } from 'node:net';
import { ipToBytes, normalizeIp } from './ip';

export interface CidrEntry { cidr: string; label: string; v: 4 | 6; bits: number; key: bigint }

function toBig(b: number[]): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

function maskBits(n: bigint, width: number, bits: number): bigint {
  if (bits <= 0) return 0n;
  const shift = BigInt(width - bits);
  return (n >> shift) << shift;
}

/** IPv4-mapped IPv6 (::ffff:a.b.c.d) → IPv4 bytes. */
function canonicalBytes(ip: string): number[] | null {
  const b = ipToBytes(ip);
  if (!b) return null;
  if (b.length === 16 && b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return b.slice(12);
  return b;
}

export function parseCidrEntry(raw: string): CidrEntry | null {
  const t = raw.trim();
  if (!t) return null;
  const [cidr, ...rest] = t.split(/\s+/);
  const [addr, len] = cidr!.split('/');
  if (!addr) return null;
  const v = isIP(addr);
  if (v !== 4 && v !== 6) return null;
  const width = v === 4 ? 32 : 128;
  const bits = len === undefined ? width : Number(len);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;
  const bytes = ipToBytes(addr);
  if (!bytes) return null;
  return { cidr: cidr!, label: rest.join(' ') || cidr!, v, bits, key: maskBits(toBig(bytes), width, bits) };
}

/** Parse "cidr label, cidr label\ncidr" — invalid entries are dropped. */
export function parseCidrList(raw: string | null | undefined): CidrEntry[] {
  return (raw ?? '').split(/[,\n;]/).map(parseCidrEntry).filter((x): x is CidrEntry => !!x);
}

export class CidrList {
  constructor(readonly entries: CidrEntry[]) {}
  get size() { return this.entries.length; }
  /** First matching entry (most specific wins), or null. */
  match(rawIp: string | null | undefined): CidrEntry | null {
    const ip = normalizeIp(rawIp ?? null);
    if (!ip) return null;
    const b = canonicalBytes(ip);
    if (!b) return null;
    const v = b.length === 4 ? 4 : 6;
    const width = v === 4 ? 32 : 128;
    const n = toBig(b);
    let best: CidrEntry | null = null;
    for (const e of this.entries) {
      if (e.v !== v) continue;
      if (maskBits(n, width, e.bits) === e.key && (!best || e.bits > best.bits)) best = e;
    }
    return best;
  }
}

export interface TrafficRules {
  internal: CidrList;
  datacenter: CidrList;
  burstMin: number;
  burstWindowS: number;
}

const posInt = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
};

export function rulesFromEnv(env: Record<string, string | undefined> = process.env): TrafficRules {
  return {
    internal: new CidrList(parseCidrList(env.VISITOR_INTERNAL_IPS)),
    datacenter: new CidrList(parseCidrList(env.VISITOR_DATACENTER_IPS)),
    burstMin: posInt(env.VISITOR_BURST_MIN, 5, 2, 1000),
    burstWindowS: posInt(env.VISITOR_BURST_WINDOW_S, 60, 5, 3600),
  };
}

let cached: { raw: string; rules: TrafficRules } | null = null;
/** Rules from process.env, re-parsed only when the variables change. */
export function trafficRules(): TrafficRules {
  const raw = [process.env.VISITOR_INTERNAL_IPS, process.env.VISITOR_DATACENTER_IPS, process.env.VISITOR_BURST_MIN, process.env.VISITOR_BURST_WINDOW_S].join('|');
  if (!cached || cached.raw !== raw) cached = { raw, rules: rulesFromEnv() };
  return cached.rules;
}
