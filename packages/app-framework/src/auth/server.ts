/**
 * Server-side auth — the framework's Auth.js v5 configuration.
 *
 * Apps wire this into their /app/api/auth/[...nextauth]/route.ts and
 * import { auth, signIn, signOut } from this module from server code.
 *
 * Strategy: JWT-mode sessions (no DB session store) — Auth.js holds
 * the encrypted JWT in a cookie. We keep a `sessions` table in
 * SynapCores ONLY for the "log out everywhere" + "list my devices"
 * + audit-log surfaces. The JWT itself carries the userId; we
 * resolve tenant + role per-request from the DB.
 *
 * Neither the JWT nor the session output carries the tenant's
 * SynapCores API key: server code looks it up by tenant id
 * (../db/server.ts getClientForSession).
 */

import 'server-only';

import NextAuth, { type NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { getAdminClient } from '../db/server';
import { DEFAULT_ROLE_GRANTS, type Role } from '../rbac/types';
import { redeemAuthToken } from './users';
import { frameworkJwtCallback, frameworkSessionCallback } from './session-state';
import { hasTenantApiKey } from './tenant-keys';
import type {
  Session as FrameworkSession,
  TenantInfo,
  UserInfo,
} from './types';

const credentialsSchema = z.object({
  // Use a permissive `local@host` regex instead of z.string().email()
  // — Zod's strict email validator requires a TLD, so the framework's
  // own default admin@localhost user fails to log in. This regex
  // accepts admin@localhost AND every standard internet email.
  email: z.string().regex(/^[^\s@]+@[^\s@]+$/, 'Invalid email'),
  password: z.string().min(8),
});

/**
 * The Auth.js NextAuthConfig the framework exports. Apps may extend
 * it (`createAuth(extraConfig)`) to add their own providers — e.g.
 * Google OAuth for the Enterprise tier — without forking the
 * framework.
 */
export function createAuth(
  extraConfig: Partial<NextAuthConfig> = {},
): ReturnType<typeof NextAuth> {
  const config: NextAuthConfig = {
    session: { strategy: 'jwt' },
    pages: {
      signIn: '/login',
      error: '/login',
      verifyRequest: '/login/verify',
    },
    providers: [
      Credentials({
        id: 'credentials',
        name: 'Email + password',
        credentials: {
          email: { label: 'Email', type: 'email' },
          password: { label: 'Password', type: 'password' },
        },
        async authorize(raw, request) {
          const parsed = credentialsSchema.safeParse(raw);
          if (!parsed.success) return null;
          // Brute-force guard: cap failed attempts per account and per client IP.
          const email = parsed.data.email.trim().toLowerCase();
          const ip = clientIpOf(request);
          if (loginBlocked(`e:${email}`) || loginBlocked(`i:${ip}`)) {
            console.warn(`[auth] login throttled email=${email} ip=${ip}`);
            return null;
          }
          let user;
          try {
            user = await verifyPassword(parsed.data.email, parsed.data.password);
          } catch {
            return null;
          }
          if (!user) {
            loginFailed(`e:${email}`);
            loginFailed(`i:${ip}`);
            console.warn(`[auth] login failed email=${email} ip=${ip}`);
            return null;
          }
          return { id: user.id, email: user.email, name: user.name };
        },
      }),
      // Magic-link provider — caller invokes `signIn('magic-link', { token })`
      // after the user clicks the email link. The /login/verify page is the
      // catch site for those clicks.
      Credentials({
        id: 'magic-link',
        name: 'Magic link',
        credentials: {
          token: { label: 'Token', type: 'text' },
        },
        async authorize(raw, request) {
          const ip = clientIpOf(request);
          if (loginBlocked(`i:${ip}`)) return null;
          const token = typeof raw?.token === 'string' ? raw.token : '';
          if (!token) return null;
          try {
            loginFailed(`i:${ip}`); // counts every redemption attempt; success is rare and cheap
            const userId = await redeemAuthToken(token, 'magic-link');
            const user = await loadUser(userId);
            return user ? { id: user.id, email: user.email, name: user.name } : null;
          } catch {
            return null;
          }
        },
      }),
      // Extra providers (Resend SMTP, GitHub, Google) get merged in
      // by callers below.
      ...(extraConfig.providers ?? []),
    ],
    callbacks: {
      async jwt({ token, user }) {
        // The cookie holds the user id only; key-bearing fields a token may
        // carry from older code are dropped on every read.
        return frameworkJwtCallback(token, user);
      },
      async session({ session, token }) {
        // Stuff our framework session shape onto the Auth.js session
        // object. App code reads `session.framework` through
        // frameworkSessionOf() (./session-state.ts). The framework session
        // is allow-listed on the way out: no tenant API key.
        // A failed lookup (engine restarting / unreachable) is not "signed
        // out". Throwing here would make Auth.js return no session (→ /login)
        // and clear the cookie, so it is flagged instead; readers throw
        // SessionUnavailableError and the page shows "Reconnecting…".
        return frameworkSessionCallback(session, token, resolveFrameworkSession);
      },
      ...extraConfig.callbacks,
    },
    trustHost: true,
    secret: process.env.AUTH_SECRET,
    ...extraConfig,
  };

  return NextAuth(config);
}

/**
 * Look up a user by id. Returns null if not found.
 */
async function loadUser(userId: string): Promise<UserInfo | null> {
  const db = getAdminClient();
  const result = await db.sql<{
    id: string;
    email: string;
    name: string | null;
    email_verified: boolean;
    created_at: string;
  }>(
    `SELECT id, email, name, email_verified, created_at
       FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    emailVerified: row.email_verified,
    createdAt: row.created_at,
  };
}

/**
 * Look up the user, check the password.
 */
async function verifyPassword(
  email: string,
  password: string,
): Promise<UserInfo | null> {
  const db = getAdminClient();
  const result = await db.sql<{
    id: string;
    email: string;
    name: string | null;
    password_hash: string | null;
    email_verified: boolean;
    created_at: string;
  }>(
    `SELECT id, email, name, password_hash, email_verified, created_at
       FROM users
      WHERE email = $1
      LIMIT 1`,
    [email],
  );
  const row = result.rows[0];
  if (!row || !row.password_hash) return null;
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return null;

  // Stamp last_login
  await db.sql(
    `UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [row.id],
  );

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    emailVerified: row.email_verified,
    createdAt: row.created_at,
  };
}

/**
 * Resolve the framework-level session for a given user id.
 *
 * Picks the user's default tenant (most recently active membership)
 * if they have one; returns null tenant + role if they have none yet
 * (first-time-login flow — they get bounced to /onboard).
 */
async function resolveFrameworkSession(
  userId: string,
): Promise<FrameworkSession | null> {
  const db = getAdminClient();

  // user
  const userResult = await db.sql<{
    id: string;
    email: string;
    name: string | null;
    email_verified: boolean;
    created_at: string;
  }>(
    `SELECT id, email, name, email_verified, created_at
       FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const userRow = userResult.rows[0];
  if (!userRow) return null;

  // memberships (most recent first)
  // CE engine notes:
  //  - JOINs across multiple tables are unreliable. We do the two-step
  //    lookup explicitly (N+1 — acceptable since N is small).
  //  - ORDER BY requires the column to also appear in the SELECT.
  const memResult = await db.sql<{
    tenant_id: string;
    role: string;
    created_at: string;
  }>(
    `SELECT tenant_id, role, created_at
       FROM memberships
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId],
  );

  const memberships: Array<{ tenant: TenantInfo; role: Role }> = [];
  for (const m of memResult.rows) {
    const tenantResult = await db.sql<{
      id: string;
      name: string;
      slug: string;
    }>(
      `SELECT id, name, slug
         FROM tenants WHERE id = $1 LIMIT 1`,
      [m.tenant_id],
    );
    const t = tenantResult.rows[0];
    if (!t) continue;
    memberships.push({
      tenant: { id: t.id, name: t.name, slug: t.slug },
      role: m.role as Role,
    });
  }

  const active = memberships[0] ?? null;

  // The active tenant needs a provisioned SynapCores API key (same rule as
  // before), but the key itself stays server-side: it is not put on the
  // session. Code that queries with it reads it by tenant id
  // (../db/server.ts getClientForSession, store in ./tenant-keys.ts).
  let activeTenant: TenantInfo | null = null;
  if (active && (await hasTenantApiKey(active.tenant.id))) {
    activeTenant = active.tenant;
  }

  const role = active?.role ?? null;
  const permissions: ReadonlyArray<string> = role
    ? DEFAULT_ROLE_GRANTS[role] ?? []
    : [];

  return {
    user: {
      id: userRow.id,
      email: userRow.email,
      name: userRow.name,
      emailVerified: userRow.email_verified,
      createdAt: userRow.created_at,
    },
    tenant: activeTenant,
    role,
    permissions,
    memberships,
  };
}

// ─── login throttling (per process) ──────────────────────────────────────
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;
const loginFails = new Map<string, { n: number; until: number }>();

function loginBlocked(key: string): boolean {
  const e = loginFails.get(key);
  if (!e) return false;
  if (Date.now() > e.until) {
    loginFails.delete(key);
    return false;
  }
  return e.n >= LOGIN_MAX_FAILS;
}

function loginFailed(key: string): void {
  const now = Date.now();
  if (loginFails.size > 50_000) loginFails.clear();
  const e = loginFails.get(key);
  if (!e || now > e.until) loginFails.set(key, { n: 1, until: now + LOGIN_WINDOW_MS });
  else e.n += 1;
}

/** Real client IP: our single reverse proxy appends it as the LAST X-Forwarded-For entry. */
function clientIpOf(request: unknown): string {
  const h = (request as { headers?: Headers } | undefined)?.headers;
  const xff = h?.get?.('x-forwarded-for');
  if (xff) return xff.split(',').pop()!.trim();
  return h?.get?.('x-real-ip') ?? 'unknown';
}
