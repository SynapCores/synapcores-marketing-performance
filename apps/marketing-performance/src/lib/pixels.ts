/**
 * Tracking pixels — public, write-only ASSET IDENTIFIERS (the `pk_...` value).
 *
 * This is the Facebook-Pixel-ID model. The `pk_...` string is an *identifier*,
 * not a credential:
 *   - It is embedded in your pages' source and is meant to be seen.
 *   - It is stored in PLAINTEXT and looked up by value — we deliberately do NOT
 *     bcrypt-hash it, because it is not a secret and hashing would only prevent
 *     the direct lookup a public id needs.
 *   - It is WRITE-ONLY: `resolvePixel` is the only thing that consumes it, and
 *     all it yields is "which workspace do these events belong to." It grants no
 *     reads, no admin, no other API surface. Lifting it from page source lets an
 *     attacker do exactly what a stolen FB Pixel ID lets them do — send junk
 *     events (rate-limited, origin-gated, and disposable via rotate/disable) —
 *     and nothing more.
 *
 * Secret credentials live elsewhere: `sk_user_...` API keys (see api-auth.ts /
 * the framework's api-keys) stay server-side for the Conversions-API-style
 * ingest path and are NEVER embedded in a browser.
 */

import 'server-only';
import { randomBytes } from 'node:crypto';
import { getAdminClient } from '@synapcores/app-framework/db/server';
import { invalidateReports } from './report-db';

const PIXEL_PREFIX = 'pk_';

export interface TrackingPixel {
  id: string; // the pk_... identifier (public)
  label: string;
  allowed_origins: string | null;
  created_at: string;
  disabled_at: string | null;
  last_used_at: string | null;
}

export interface ResolvedPixel {
  tenantId: string;
  userId: string;
  pixelId: string;
  /** Parsed allowlist; null = unrestricted (an "unverified" pixel). */
  allowedOrigins: string[] | null;
}

/** Is this value shaped like a public pixel identifier (vs. a secret key)? */
export function isPixelId(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(PIXEL_PREFIX);
}

/**
 * Mint a new public, write-only pixel identifier. The returned `id` is the
 * `pk_...` value to embed — it is safe to show, copy, and print at any time
 * (there is no "shown once" secret here, unlike an API key).
 */
export async function createPixel(opts: {
  tenantId: string;
  userId: string;
  label: string;
  allowedOrigins?: string[] | null;
}): Promise<TrackingPixel> {
  const id = `${PIXEL_PREFIX}${randomBytes(18).toString('base64url')}`;
  const origins = normalizeOrigins(opts.allowedOrigins);
  const db = getAdminClient();
  await db
    .sql(
      `INSERT INTO tracking_pixels (id, tenant_id, user_id, label, allowed_origins, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [id, opts.tenantId, opts.userId, opts.label, origins],
    )
    .finally(() => invalidateReports(opts.tenantId));
  return {
    id,
    label: opts.label,
    allowed_origins: origins,
    created_at: new Date().toISOString(),
    disabled_at: null,
    last_used_at: null,
  };
}

export async function listPixels(tenantId: string): Promise<TrackingPixel[]> {
  const db = getAdminClient();
  const res = await db.sql<TrackingPixel>(
    `SELECT id, label, allowed_origins, created_at, disabled_at, last_used_at
       FROM tracking_pixels
      WHERE tenant_id = $1
      ORDER BY created_at DESC`,
    [tenantId],
  );
  return res.rows;
}

/**
 * Resolve a `pk_...` identifier to the workspace it belongs to. This is the
 * ONLY read of the pixel table on the hot path, and it yields nothing beyond
 * the owning tenant — the write-only contract. Returns null if the value isn't
 * a pixel id, isn't known, or has been disabled.
 */
export async function resolvePixel(pixelId: unknown): Promise<ResolvedPixel | null> {
  if (!isPixelId(pixelId)) return null;
  const db = getAdminClient();
  const res = await db.sql<{
    tenant_id: string;
    user_id: string;
    allowed_origins: string | null;
    disabled_at: string | null;
  }>(
    `SELECT tenant_id, user_id, allowed_origins, disabled_at
       FROM tracking_pixels
      WHERE id = $1
      LIMIT 1`,
    [pixelId],
  );
  const row = res.rows[0];
  if (!row || row.disabled_at) return null;
  void db
    .sql(`UPDATE tracking_pixels SET last_used_at = NOW() WHERE id = $1`, [pixelId])
    .catch(() => undefined);
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    pixelId,
    allowedOrigins: parseOrigins(row.allowed_origins),
  };
}

/** Turn a pixel off without deleting it (keeps its history). Tenant-scoped. */
export async function disablePixel(tenantId: string, id: string): Promise<void> {
  const db = getAdminClient();
  await db
    .sql(`UPDATE tracking_pixels SET disabled_at = NOW() WHERE id = $1 AND tenant_id = $2`, [id, tenantId])
    .finally(() => invalidateReports(tenantId));
}

/** Permanently remove a pixel. Tenant-scoped so one workspace can't touch another's. */
export async function deletePixel(tenantId: string, id: string): Promise<void> {
  const db = getAdminClient();
  await db
    .sql(`DELETE FROM tracking_pixels WHERE id = $1 AND tenant_id = $2`, [id, tenantId])
    .finally(() => invalidateReports(tenantId));
}

/**
 * Origin gate — the domain-verification analogue. A pixel with no allowlist
 * accepts events from anywhere (functional but unverified); a pixel with an
 * allowlist only accepts browser events whose `Origin` is on it.
 */
export function originAllowed(allowed: string[] | null, origin: string | null): boolean {
  if (!allowed || allowed.length === 0) return true; // unrestricted
  if (!origin) return false;
  const o = origin.replace(/\/+$/, '');
  return allowed.includes(o);
}

function parseOrigins(csv: string | null): string[] | null {
  if (!csv) return null;
  const list = csv.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

function normalizeOrigins(list: string[] | null | undefined): string | null {
  if (!list || list.length === 0) return null;
  const cleaned = list.map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  return cleaned.length ? Array.from(new Set(cleaned)).join(',') : null;
}
