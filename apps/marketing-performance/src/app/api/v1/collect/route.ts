import { NextResponse } from 'next/server';
import { resolveBearerKey } from '@/lib/api-auth';
import { isPixelId, resolvePixel, originAllowed } from '@/lib/pixels';
import { mapBatch, type BeaconBatch } from '@/lib/collector';
import { ingestSource, rebuildDerived } from '@/lib/warehouse';
import { clientIp, makeLimiter } from '@/lib/security';
import { insertEvents } from '@/lib/event-store';
import { buildEventRows } from '@/lib/visitor/events';
import { lookupGeo } from '@/lib/visitor/geo';
import { clientIpFromHeaders, normalizeIp } from '@/lib/visitor/ip';
import { mustDropForPrivacy } from '@/lib/visitor/privacy';
import { classifyVisitor } from '@/lib/visitor/classify';
import { getCrawlerMatcher } from '@/lib/visitor/crawler-ranges-store';

export const runtime = 'nodejs';

/**
 * First-party clickstream collector — the endpoint `public/track.js` posts to.
 *
 *   POST /api/v1/collect
 *   body = the beacon batch { siteId, userId, sessionId, events:[...], ... }
 *
 * Two authorization shapes, deliberately split along the Facebook-Pixel line:
 *
 *   - Browser beacon: `batch.siteId` is a PUBLIC pixel identifier (`pk_...`) —
 *     an asset id, not a secret. It is embedded in page source and is write-
 *     only: it resolves to a workspace and can do nothing else. Requests are
 *     additionally origin-gated when the pixel has an allowlist.
 *   - Server-to-server (Conversions-API style): an `Authorization: Bearer
 *     sk_user_...` SECRET key in the header. Never embedded in a browser.
 *
 * Either way the batch lands against a provisioned workspace — the service
 * primitive. A secret `sk_user_` in the *body* is intentionally NOT accepted:
 * the thing you put in a page is an identifier, never a credential.
 *
 * This is the clean-room replacement for Adaptus's `EcommTrackerModule.js`:
 * Next route handler instead of Express, the built-in rate limiter below
 * instead of `express-rate-limit`, `crypto`/`Date` instead of `uuid`, and
 * SynapCores writes instead of `mysql`. None of Adaptus's dependency tree is
 * imported.
 *
 * NOTE (Path A tenancy, step 4): the resolved `tenantId` is threaded through
 * here; the `recipe_pm_*` tables get a `tenant_id` column + `WHERE tenant_id`
 * scoping in step 4, at which point writes/reads filter by it. Until then a
 * valid key is still REQUIRED, so this is never an open relay.
 */

// ── limits ──────────────────────────────────────────────────────────────────
const MAX_BODY_BYTES = 64 * 1024; // a beacon batch is a few KB
const MAX_EVENTS = 50; // events per batch
const tenantLimited = makeLimiter(120, 60_000); // batches per workspace per minute
const ipLimited = makeLimiter(30, 60_000); // batches per client IP per minute

// Attribution + scorecard are full-table rebuilds: never run one per beacon.
// Coalesce into at most one rebuild per REBUILD_EVERY_MS after new data lands.
const REBUILD_EVERY_MS = Number(process.env.COLLECT_REBUILD_EVERY_MS ?? 5 * 60_000);
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRebuild() {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    rebuildDerived().catch(() => undefined);
  }, REBUILD_EVERY_MS);
  rebuildTimer.unref?.();
}

// ── CORS (the beacon runs on the customer's domain, not ours) ────────────────
// No credentials are ever sent, so a wildcard is safe; an allow-listed pixel
// gets its origin echoed only after the origin check passes.
function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

interface ResolvedWrite {
  tenantId: string;
  userId: string;
  keyId: string;
  kind: 'pixel' | 'key' | 'dev';
  /** Only meaningful for `kind === 'pixel'`; null = unrestricted. */
  allowedOrigins: string[] | null;
}

/**
 * Resolve who a batch belongs to. The browser path is a public `pk_` pixel id
 * in the body; the server-to-server path is a secret `sk_user_` in the header.
 */
async function resolveWriteKey(req: Request, batch: BeaconBatch): Promise<ResolvedWrite | null> {
  // 1. Browser beacon → public pixel identifier (pk_...). Write-only.
  if (isPixelId(batch.siteId)) {
    const pixel = await resolvePixel(batch.siteId);
    if (pixel) {
      return {
        tenantId: pixel.tenantId,
        userId: pixel.userId,
        keyId: pixel.pixelId,
        kind: 'pixel',
        allowedOrigins: pixel.allowedOrigins,
      };
    }
  }
  // 2. Server-to-server → secret API key in the Authorization header (CAPI style).
  const fromHeader = await resolveBearerKey(req);
  if (fromHeader) return { ...fromHeader, kind: 'key', allowedOrigins: null };
  // 3. Dev-only fallback so the demo page works locally without a provisioned pixel.
  const devTenant = process.env.COLLECTOR_DEV_TENANT_ID;
  if (devTenant && process.env.NODE_ENV !== 'production') {
    return { tenantId: devTenant, userId: 'dev', keyId: 'dev', kind: 'dev', allowedOrigins: null };
  }
  return null;
}

export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);

  if (ipLimited(clientIp(req))) {
    return NextResponse.json({ error: { code: 'rate_limited', message: 'Too many batches; slow down.' } }, { status: 429, headers: cors });
  }
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: { code: 'too_large', message: 'Batch too large.' } }, { status: 413, headers: cors });
  }

  let batch: BeaconBatch;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) throw new RangeError('too large');
    batch = JSON.parse(text) as BeaconBatch;
    if (!batch || typeof batch !== 'object') throw new TypeError('not an object');
    if (batch.events !== undefined && !Array.isArray(batch.events)) throw new TypeError('events');
    if (Array.isArray(batch.events) && batch.events.length > MAX_EVENTS) batch.events = batch.events.slice(0, MAX_EVENTS);
  } catch {
    return NextResponse.json({ error: { code: 'bad_body', message: 'Body must be a JSON beacon batch.' } }, { status: 400, headers: cors });
  }

  const key = await resolveWriteKey(req, batch);
  if (!key) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Provide a valid pixel id (beacon data-site-id, pk_...) or Authorization: Bearer sk_user_... for server-to-server.' } },
      { status: 401, headers: cors },
    );
  }

  // Domain-verification analogue: an allowlisted pixel only accepts events from
  // its own origins. Unrestricted pixels and the server-to-server path skip this.
  if (key.kind === 'pixel' && !originAllowed(key.allowedOrigins, origin)) {
    return NextResponse.json(
      { error: { code: 'forbidden_origin', message: 'This pixel does not accept events from this origin.' } },
      { status: 403, headers: cors },
    );
  }

  if (tenantLimited(key.tenantId)) {
    return NextResponse.json({ error: { code: 'rate_limited', message: 'Too many batches; slow down.' } }, { status: 429, headers: cors });
  }

  // Visitor opted out (DNT / GPC) on a site whose snippet promises to honour it.
  const pageHost = hostOf(origin) ?? hostOf(typeof batch.url === 'string' ? batch.url : null);
  if (mustDropForPrivacy(req.headers, pageHost)) {
    return NextResponse.json({ data: { accepted: 0, dropped: 'privacy_signal' } }, { headers: cors });
  }

  // ── raw visitor events: every event, enriched (IP, geo, UA, bot) ──────────
  let stored = 0;
  try {
    const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1) || 1;
    const ip = key.kind === 'key'
      ? normalizeIp(typeof batch.ip === 'string' ? batch.ip : null) ?? clientIpFromHeaders(req.headers, hops)
      : clientIpFromHeaders(req.headers, hops);
    const headerUa = req.headers.get('user-agent');
    const bodyUa = typeof batch.userAgent === 'string' ? batch.userAgent : null;
    // Browser beacons: the request header IS the browser. S2S: the body names the end user.
    const userAgent = key.kind === 'key' ? bodyUa ?? headerUa : headerUa ?? bodyUa;
    const rows = buildEventRows(batch, {
      tenantId: key.tenantId,
      pixelId: key.kind === 'pixel' ? key.keyId : null,
      sourceKind: key.kind,
      ip,
      geo: lookupGeo(ip),
      ua: classifyVisitor(userAgent, ip, getCrawlerMatcher()),
      userAgent,
      acceptLanguage: req.headers.get('accept-language'),
    });
    stored = await insertEvents(rows);
  } catch (e) {
    // Never let enrichment break attribution ingestion below.
    console.error('[collect] pm_events insert failed:', (e as Error).message);
  }

  const mapped = mapBatch(batch);
  const ingested = {
    clickstream: await ingestSource('clickstream', mapped.clickstream),
    identity: await ingestSource('identity', mapped.identity),
    conversions: await ingestSource('conversions', mapped.conversions),
  };

  // Keep attribution + scorecard current, but only when something landed.
  const total = ingested.clickstream + ingested.identity + ingested.conversions;
  if (total > 0) scheduleRebuild();

  return NextResponse.json({ data: { accepted: batch.events?.length ?? 0, stored, ingested } }, { headers: cors });
}

function hostOf(u: string | null): string | null {
  if (!u) return null;
  try {
    return new URL(u).host || null;
  } catch {
    return null;
  }
}
