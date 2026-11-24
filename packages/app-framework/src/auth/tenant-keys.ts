/**
 * Per-tenant SynapCores API keys, looked up server-side by tenant id.
 *
 * The key never travels in the session: not in the Auth.js cookie, not in
 * GET /api/auth/session, not in RSC payloads. Server code that needs a
 * tenant-scoped engine client gets one from ../db/server.ts
 * (getClientForSession), which reads the key here.
 * Lookups fail closed: an unknown tenant, a malformed tenant id, or a missing
 * or empty key file yields no key.
 *
 * Phase 1 store: $FRAMEWORK_TENANT_KEYS_DIR/<tenant_id>.key (default
 * ./var/tenant-keys), written by ./tenants.ts. A production secret manager
 * can replace the file reads behind the same functions.
 *
 * Server code only (node:fs). It has no `server-only` import so the unit
 * tests can load it; it is imported only by server-only modules and is not
 * re-exported from any package barrel.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Tenant ids are UUIDs. A dot or a slash could point outside the key directory. */
const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Where tenant key files live. */
export function tenantKeysDir(): string {
  return process.env.FRAMEWORK_TENANT_KEYS_DIR ?? './var/tenant-keys';
}

/** True for ids that can name a key file (no path separators, no dots). */
export function isValidTenantId(tenantId: unknown): tenantId is string {
  return typeof tenantId === 'string' && TENANT_ID_RE.test(tenantId);
}

/**
 * The tenant's SynapCores API key, or null when it has none: unknown tenant,
 * malformed id, or a missing, unreadable or empty key file.
 */
export async function readTenantApiKey(
  tenantId: string,
  dir: string = tenantKeysDir(),
): Promise<string | null> {
  if (!isValidTenantId(tenantId)) return null;
  try {
    const key = (await readFile(join(dir, `${tenantId}.key`), 'utf-8')).trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/** Is a key provisioned for the tenant? The session uses this without carrying the key. */
export async function hasTenantApiKey(tenantId: string, dir?: string): Promise<boolean> {
  return (await readTenantApiKey(tenantId, dir)) !== null;
}

/** No SynapCores API key is provisioned for the tenant. The message names neither the tenant nor a key. */
export class TenantKeyMissingError extends Error {
  constructor() {
    super(
      '[app-framework] no SynapCores API key is provisioned for this tenant. The user must be a member of a provisioned tenant before they can query data.',
    );
    this.name = 'TenantKeyMissingError';
  }
}

/** Fail-closed lookup: the tenant's key, or TenantKeyMissingError. */
export async function requireTenantApiKey(tenantId: string, dir?: string): Promise<string> {
  const key = await readTenantApiKey(tenantId, dir);
  if (key === null) throw new TenantKeyMissingError();
  return key;
}
