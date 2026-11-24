/**
 * Server-side helpers for getting a SynapCoresClient inside a Next.js
 * route handler / server action / RSC.
 *
 * - `getAdminClient()` returns the framework-level admin client (uses
 *   the SYNAPCORES_ADMIN_API_KEY from env). Used for tenant bootstrap,
 *   schema migrations, and cross-tenant operations.
 *
 * - `getClientForSession()` returns a client scoped to the current
 *   authenticated session's tenant. Most app code wants this — every
 *   query the user makes runs through their tenant's auth. The
 *   tenant's key is looked up server-side by the session's tenant id
 *   (../auth/tenant-keys.ts); the session never carries it.
 *
 * - `getClientForApiKey(key)` is for inbound webhook handlers where
 *   we already validated the incoming API key.
 */

import 'server-only';

import { SynapCoresClient } from './client';
import { requireTenantApiKey } from '../auth/tenant-keys';
import type { Session } from '../auth/types';

let cachedAdminClient: SynapCoresClient | null = null;

/**
 * Framework-level admin client. Reads SYNAPCORES_URL and
 * SYNAPCORES_ADMIN_API_KEY from process.env.
 *
 * Long-lived: cached for the process. Uses the admin key, so DO NOT
 * hand this client to user-facing route handlers — use
 * `getClientForSession()` instead.
 */
export function getAdminClient(): SynapCoresClient {
  if (cachedAdminClient) return cachedAdminClient;
  const apiKey = process.env.SYNAPCORES_ADMIN_API_KEY;
  if (!apiKey) {
    throw new Error(
      '[app-framework] SYNAPCORES_ADMIN_API_KEY is not set. The framework needs an admin key to bootstrap tenants and run schema migrations.',
    );
  }
  cachedAdminClient = new SynapCoresClient({
    baseUrl: process.env.SYNAPCORES_URL ?? 'http://127.0.0.1:28080',
    apiKey,
  });
  return cachedAdminClient;
}

/**
 * Client scoped to a tenant's own SynapCores API key, read server-side by
 * tenant id. Fails closed: throws TenantKeyMissingError for an unknown
 * tenant, a malformed id, or a tenant without a provisioned key.
 * Module-private on purpose: callers go through getClientForSession(), whose
 * tenant is the server-resolved active tenant of the signed-in user, so no
 * caller can turn a request-supplied id into another tenant's client.
 */
async function clientForTenant(tenantId: string): Promise<SynapCoresClient> {
  const apiKey = await requireTenantApiKey(tenantId);
  return new SynapCoresClient({
    baseUrl: process.env.SYNAPCORES_URL ?? 'http://127.0.0.1:28080',
    apiKey,
  });
}

/**
 * Tenant-scoped client for the current request's session (its active
 * tenant). The key is looked up by tenant id, never taken from the session.
 * Throws if the session has no tenant (callers should check auth first) or
 * the tenant has no provisioned key.
 */
export async function getClientForSession(session: Session): Promise<SynapCoresClient> {
  const tenantId = session.tenant?.id;
  if (!tenantId) {
    throw new Error(
      '[app-framework] session has no tenant. The user must be a member of a provisioned tenant before they can query data.',
    );
  }
  return clientForTenant(tenantId);
}

/** Pre-authenticated webhook clients (the framework validated the key already). */
export function getClientForApiKey(apiKey: string): SynapCoresClient {
  return new SynapCoresClient({
    baseUrl: process.env.SYNAPCORES_URL ?? 'http://127.0.0.1:28080',
    apiKey,
  });
}
