/**
 * Client-IP helpers for the collector: proxy-aware extraction, public/private
 * classification, byte parsing (for the GeoIP tree walk) and the retention
 * truncation (/24 for IPv4, /48 for IPv6).
 *
 * Pure functions, no I/O — unit tested in tests/visitor.test.ts.
 */
import { isIP } from 'node:net';

/** Strip brackets, ports and zone ids; unwrap IPv4-mapped IPv6 (::ffff:1.2.3.4). */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s || s.toLowerCase() === 'unknown') return null;
  // [v6]:port
  const br = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (br) s = br[1]!;
  // v4:port
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) s = mapped[1]!;
  const v = isIP(s);
  if (v === 0) return null;
  return v === 6 ? s.toLowerCase() : s;
}

/**
 * Client IP as seen through `trustedHops` reverse proxies. Each trusted proxy
 * APPENDS its peer to X-Forwarded-For, so we take the entry `trustedHops` from
 * the right; everything left of that is client-supplied and forgeable. With our
 * single Apache hop that is the last entry. Falls back to X-Real-IP.
 */
export function clientIpFromHeaders(
  headers: { get(name: string): string | null },
  trustedHops = 1,
): string | null {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    const hops = Math.max(1, trustedHops);
    const pick = parts[parts.length - hops] ?? parts[0];
    const ip = normalizeIp(pick);
    if (ip) return ip;
  }
  return normalizeIp(headers.get('x-real-ip'));
}

/** Parse a (normalized) IP into bytes: 4 for IPv4, 16 for IPv6. */
export function ipToBytes(ip: string): number[] | null {
  const v = isIP(ip);
  if (v === 4) return ip.split('.').map((o) => Number(o));
  if (v !== 6) return null;
  let s = ip;
  // Embedded IPv4 tail (e.g. 64:ff9b::1.2.3.4) → two hextets.
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const b = v4[1]!.split('.').map(Number);
    s = s.slice(0, -v4[1]!.length) + ((b[0]! << 8) | b[1]!).toString(16) + ':' + ((b[2]! << 8) | b[3]!).toString(16);
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const words = [...h, ...Array<string>(fill).fill('0'), ...t].map((w) => parseInt(w || '0', 16));
  if (words.length !== 8 || words.some((w) => !Number.isFinite(w))) return null;
  const out: number[] = [];
  for (const w of words) out.push((w >> 8) & 0xff, w & 0xff);
  return out;
}

/** True for loopback / RFC1918 / link-local / CGNAT / ULA / unspecified — no geo for these. */
export function isPrivateIp(ip: string): boolean {
  const b = ipToBytes(ip);
  if (!b) return true;
  if (b.length === 4) {
    const [a, c] = [b[0]!, b[1]!];
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 172 && c >= 16 && c <= 31) ||
      (a === 192 && c === 168) ||
      (a === 169 && c === 254) ||
      (a === 100 && c >= 64 && c <= 127)
    );
  }
  const allZero = b.slice(0, 15).every((x) => x === 0);
  if (allZero && (b[15] === 0 || b[15] === 1)) return true; // :: and ::1
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 ULA
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10
  return false;
}

/**
 * Retention form of an IP: IPv4 → /24 (last octet zeroed, e.g. 203.0.113.0),
 * IPv6 → /48 (first three hextets kept, e.g. 2001:db8:1::). Coarse enough to
 * stop identifying a household, fine enough to keep country/region analytics.
 */
export function truncateIp(ip: string | null | undefined): string | null {
  const n = normalizeIp(ip ?? null);
  if (!n) return null;
  if (isIP(n) === 4) {
    const p = n.split('.');
    return `${p[0]}.${p[1]}.${p[2]}.0`;
  }
  const b = ipToBytes(n);
  if (!b) return null;
  const hextets: string[] = [];
  for (let i = 0; i < 6; i += 2) hextets.push(((b[i]! << 8) | b[i + 1]!).toString(16));
  return `${hextets.join(':')}::`;
}
