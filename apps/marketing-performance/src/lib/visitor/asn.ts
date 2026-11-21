/**
 * IP → autonomous system (DB-IP "IP to ASN Lite", CC BY 4.0) and a
 * "is this a data centre / cloud host?" verdict. People browse from ISPs;
 * traffic from AWS, GCP, Azure, DigitalOcean, Hetzner, Tencent, … is almost
 * always automation (headless browsers, link scanners, uptime checks). It is
 * reported as "suspected bot (review)", never silently dropped.
 *
 * Privacy relays are deliberately NOT treated as hosting: iCloud Private Relay
 * and Cloudflare WARP egress through Cloudflare / Akamai CDN / Fastly, and
 * those are real people.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MmdbReader } from './mmdb';
import { geoDbPath } from './geo';
import { isPrivateIp, normalizeIp } from './ip';

export interface AsnInfo { asn: number | null; org: string | null }
interface AsnRecord { autonomous_system_number?: number; autonomous_system_organization?: string }

/** Hosting / cloud ASNs (number → short label). */
export const HOSTING_ASNS: Record<number, string> = {
  16509: 'AWS', 14618: 'AWS', 8987: 'AWS', 39111: 'AWS',
  15169: 'Google', 396982: 'Google Cloud', 19527: 'Google Cloud', 36040: 'Google (YouTube)', 43515: 'Google (YouTube)',
  36384: 'Google', 36385: 'Google', 41264: 'Google',
  8075: 'Microsoft/Azure', 8068: 'Microsoft/Azure',
  14061: 'DigitalOcean', 63949: 'Linode/Akamai Cloud', 16276: 'OVH', 24940: 'Hetzner', 213230: 'Hetzner',
  132203: 'Tencent Cloud', 45090: 'Tencent Cloud', 45102: 'Alibaba Cloud', 37963: 'Alibaba Cloud', 136907: 'Huawei Cloud',
  31898: 'Oracle Cloud', 20473: 'Vultr', 51167: 'Contabo', 12876: 'Scaleway', 60781: 'Leaseweb', 16265: 'Leaseweb', 28753: 'Leaseweb',
  9009: 'M247', 60068: 'Datacamp/CDN77', 8560: 'IONOS', 47583: 'Hostinger', 29802: 'Hivelocity', 8100: 'QuadraNet',
  40676: 'Psychz', 36352: 'ColoCrossing', 36007: 'Kamatera', 199524: 'G-Core', 202425: 'IP Volume', 211252: 'Delis',
  62567: 'DigitalOcean', 393406: 'DigitalOcean', 46606: 'Unified Layer', 26496: 'GoDaddy hosting', 398101: 'GoDaddy hosting',
};

const HOSTING_NAME = /\b(amazon|aws|google cloud|digitalocean|linode|ovh|hetzner|tencent|alibaba|aliyun|oracle cloud|vultr|choopa|contabo|scaleway|leaseweb|m247|datacamp|hostinger|hosting|datacenter|data center|colocation|vps|dedicated server|servers? ltd|cloud computing)\b/i;
const NOT_HOSTING = /cloudflare|fastly|akamai technologies|apple/i;

/** Hosting label for an ASN record, or null for ISPs / unknown. */
export function hostingLabel(info: AsnInfo | null): string | null {
  if (!info) return null;
  if (info.asn != null && HOSTING_ASNS[info.asn]) return HOSTING_ASNS[info.asn]!;
  const org = info.org ?? '';
  if (!org || NOT_HOSTING.test(org)) return null;
  return HOSTING_NAME.test(org) ? org : null;
}

export function asnDbPath(): string {
  return process.env.GEOIP_ASN_DB_PATH || join(dirname(geoDbPath()), 'dbip-asn-lite.mmdb');
}

let reader: MmdbReader | null = null;
let readerKey = '';
let lastCheck = 0;

function getReader(): MmdbReader | null {
  const path = asnDbPath();
  const now = Date.now();
  if (reader && readerKey.startsWith(path + '|') && now - lastCheck < 60_000) return reader;
  lastCheck = now;
  try {
    if (!existsSync(path)) {
      reader?.close();
      reader = null;
      readerKey = '';
      return null;
    }
    const key = `${path}|${statSync(path).mtimeMs}`;
    if (!reader || key !== readerKey) {
      const next = MmdbReader.open(path, 64);
      reader?.close();
      reader = next;
      readerKey = key;
    }
    return reader;
  } catch {
    return reader;
  }
}

const memo = new Map<string, AsnInfo | null>();

/** ASN for an IP (memoised; a truncated x.y.z.0 prefix works too). Null when unknown / no DB. */
export function lookupAsn(ip: string | null | undefined): AsnInfo | null {
  const n = normalizeIp(ip ?? null);
  if (!n || isPrivateIp(n)) return null;
  if (memo.has(n)) return memo.get(n)!;
  const r = getReader();
  if (!r) return null;
  let out: AsnInfo | null = null;
  try {
    const rec = r.get<AsnRecord>(n);
    if (rec) out = { asn: typeof rec.autonomous_system_number === 'number' ? rec.autonomous_system_number : null, org: rec.autonomous_system_organization ?? null };
  } catch {
    out = null;
  }
  if (memo.size > 50_000) memo.clear();
  memo.set(n, out);
  return out;
}

export function asnStatus(): { loaded: boolean; path: string; built?: string } {
  const r = getReader();
  if (!r) return { loaded: false, path: asnDbPath() };
  return { loaded: true, path: asnDbPath(), built: new Date(r.metadata.build_epoch * 1000).toISOString().slice(0, 10) };
}
