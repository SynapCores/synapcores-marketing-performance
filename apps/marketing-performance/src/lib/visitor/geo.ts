/**
 * Local GeoIP enrichment — IP → approximate country / region / city.
 *
 * Reads a GeoIP2-City-shaped .mmdb from disk (we ship DB-IP "IP to City Lite",
 * CC BY 4.0, https://db-ip.com — attribution is shown in the app footer and the
 * Visitors page). There is no per-request external API: lookups are local
 * positional reads (see mmdb.ts). If the database is missing, enrichment is
 * simply skipped — the event is still stored.
 *
 * Path: GEOIP_DB_PATH (default /var/lib/mktperf/geoip/dbip-city-lite.mmdb).
 */
import { existsSync, statSync } from 'node:fs';
import { MmdbReader } from './mmdb';
import { isPrivateIp, normalizeIp } from './ip';

export interface GeoInfo {
  country: string | null; // ISO-3166 alpha-2
  countryName: string | null;
  region: string | null; // first subdivision (state / province)
  city: string | null;
  latitude: number | null; // rounded to 0.1° (~11 km): approximate by design
  longitude: number | null;
  timezone: string | null;
}

export const EMPTY_GEO: GeoInfo = { country: null, countryName: null, region: null, city: null, latitude: null, longitude: null, timezone: null };

type Names = { names?: Record<string, string> };
interface CityRecord {
  city?: Names;
  country?: Names & { iso_code?: string };
  subdivisions?: Array<Names & { iso_code?: string }>;
  location?: { latitude?: number; longitude?: number; time_zone?: string };
}

const en = (n: Names | undefined): string | null => n?.names?.en ?? (n?.names ? Object.values(n.names)[0] ?? null : null);
const round1 = (n: number | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

/** Shape a raw GeoIP2-City record into GeoInfo. Exported for tests. */
export function shapeCityRecord(rec: CityRecord | null): GeoInfo {
  if (!rec) return { ...EMPTY_GEO };
  return {
    country: rec.country?.iso_code ?? null,
    countryName: en(rec.country),
    region: en(rec.subdivisions?.[0]),
    city: en(rec.city),
    latitude: round1(rec.location?.latitude),
    longitude: round1(rec.location?.longitude),
    timezone: rec.location?.time_zone ?? null,
  };
}

let reader: MmdbReader | null = null;
let readerPath: string | null = null;
let readerMtime = 0;
let lastCheck = 0;

export function geoDbPath(): string {
  return process.env.GEOIP_DB_PATH || '/var/lib/mktperf/geoip/dbip-city-lite.mmdb';
}

/** Open (or re-open after a monthly DB refresh) the reader. Null if unavailable. */
function getReader(): MmdbReader | null {
  const path = geoDbPath();
  const now = Date.now();
  if (reader && readerPath === path && now - lastCheck < 60_000) return reader;
  lastCheck = now;
  try {
    if (!existsSync(path)) {
      reader?.close();
      reader = null;
      return null;
    }
    const mtime = statSync(path).mtimeMs;
    if (!reader || readerPath !== path || mtime !== readerMtime) {
      const next = MmdbReader.open(path);
      reader?.close();
      reader = next;
      readerPath = path;
      readerMtime = mtime;
    }
    return reader;
  } catch {
    return reader;
  }
}

/** Approximate location for an IP; all-null for private/invalid IPs or a missing DB. */
export function lookupGeo(ip: string | null | undefined): GeoInfo {
  const n = normalizeIp(ip ?? null);
  if (!n || isPrivateIp(n)) return { ...EMPTY_GEO };
  const r = getReader();
  if (!r) return { ...EMPTY_GEO };
  try {
    return shapeCityRecord(r.get<CityRecord>(n));
  } catch {
    return { ...EMPTY_GEO };
  }
}

/** For health/diagnostics: is a GeoIP DB loaded, and which build. */
export function geoStatus(): { loaded: boolean; path: string; type?: string; built?: string } {
  const r = getReader();
  if (!r) return { loaded: false, path: geoDbPath() };
  return { loaded: true, path: geoDbPath(), type: r.metadata.database_type, built: new Date(r.metadata.build_epoch * 1000).toISOString().slice(0, 10) };
}
