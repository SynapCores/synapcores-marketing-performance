/**
 * Auth + tenancy types shared across the framework and every app.
 *
 * Session is what `auth()` returns on the server. We hang the tenant
 * + role on it so every server action / route handler has a single
 * source of truth for "who is this and what can they do".
 */

import type { Role, Permission } from '../rbac/types';

/**
 * The tenant as the session carries it. Deliberately no API key: the
 * per-tenant SynapCores key never travels in the session (not in the Auth.js
 * cookie, not in GET /api/auth/session, not in RSC payloads). Server code that
 * needs it gets a tenant-scoped client from `getClientForSession()` in
 * ../db/server.ts, which reads the key by tenant id (store: ./tenant-keys.ts).
 */
export interface TenantInfo {
  /** Internal id (uuid). Stable across renames. */
  id: string;
  /** Human-readable name, e.g. "Acme Bank SOC". */
  name: string;
  /** URL-safe slug, e.g. "acme-bank". */
  slug: string;
}

export interface UserInfo {
  id: string;
  email: string;
  name: string | null;
  /** True if the user has finished email verification / magic-link confirm. */
  emailVerified: boolean;
  createdAt: string;
}

export interface Session {
  user: UserInfo;
  tenant: TenantInfo | null;
  /** Role within the active tenant. null if the user has no tenant yet. */
  role: Role | null;
  /** Effective permission set (role-expanded). Stored as an array
   *  because JS Sets don't survive JWT serialization — use the
   *  `hasPermission(session, perm)` helper instead of `.has()`. */
  permissions: ReadonlyArray<Permission>;
  /** Membership list — for the tenant-switcher in the header. */
  memberships: ReadonlyArray<{ tenant: TenantInfo; role: Role }>;
}

/**
 * Sign-in flow types.
 */
export type SignInResult =
  | { ok: true; redirect: string }
  | { ok: false; error: string };

export interface SignInWithPasswordInput {
  email: string;
  password: string;
}

export interface SignInWithMagicLinkInput {
  email: string;
  callbackUrl?: string;
}
