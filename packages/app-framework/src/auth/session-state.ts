/**
 * "Couldn't check the session right now" is not "logged out".
 *
 * The Auth.js `session` callback (./server.ts) resolves the framework session
 * from the database on every request. When that lookup fails (engine
 * restarting, timing out, ...) the callback must not throw: Auth.js would log
 * JWTSessionError, answer "no session" (so pages redirect to /login) and, on
 * route-handler calls, clear the session cookie. The callback flags the
 * session instead, and readers turn the flag into SessionUnavailableError,
 * which the app's error boundaries show as a "reconnecting" screen that
 * retries.
 *
 * The session is also what reaches the browser (GET /api/auth/session returns
 * the `session` callback's output; the cookie holds the `jwt` callback's
 * token), so both callbacks live here: the token keeps only the user id, and
 * the framework session leaves through an allow-list that has no room for the
 * tenant's API key (server code looks that up by tenant id, ../db/server.ts).
 * Plain module (no server-only imports), so it is unit-testable.
 */

import { ENGINE_UNAVAILABLE_DIGEST } from '../db/unavailable';
import type { Session, TenantInfo, UserInfo } from './types';

/** Value of `frameworkError` on an Auth.js session whose framework lookup failed. */
export const SESSION_LOOKUP_FAILED = 'session_lookup_failed';

export class SessionUnavailableError extends Error {
  /** Lets the error boundary say "reconnecting" (Next keeps a pre-set digest; it is never shown). */
  readonly digest = ENGINE_UNAVAILABLE_DIGEST;

  constructor() {
    super('The session could not be resolved: the database engine is unreachable right now.');
    this.name = 'SessionUnavailableError';
  }
}

/**
 * The `session` callback's framework part: resolve the framework session onto
 * the Auth.js session object `out`, or, when the lookup fails, flag it
 * (frameworkError) instead of throwing. Never throws.
 */
export async function attachFrameworkSession(
  out: { framework?: Session | null; frameworkError?: string },
  resolve: () => Promise<Session | null>,
  warn: (message: string) => void = (m) => console.warn(m),
): Promise<void> {
  try {
    out.framework = publicFrameworkSession(await resolve());
  } catch (err) {
    warn(`[auth] session lookup failed, keeping the session: ${describeError(err)}`);
    out.framework = null;
    out.frameworkError = SESSION_LOOKUP_FAILED;
  }
}

/** One-line description for logs: name, socket code if any, message (no stack). */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  return `${err.name}${typeof code === 'string' ? ` ${code}` : ''}: ${err.message}`;
}

/**
 * The framework session carried by an `auth()` result. null = no session
 * (signed out, or the user no longer exists). Throws SessionUnavailableError
 * when the lookup itself failed, so callers never mistake an engine outage for
 * a signed-out user.
 */
export function frameworkSessionOf(raw: unknown): Session | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { framework?: Session | null; frameworkError?: unknown };
  if (r.frameworkError) throw new SessionUnavailableError();
  return r.framework ?? null;
}

// ─── what may leave the server ──────────────────────────────────────────────

function publicUser(u: UserInfo): UserInfo {
  return { id: u.id, email: u.email, name: u.name, emailVerified: u.emailVerified, createdAt: u.createdAt };
}

/** The tenant fields a session may carry. An allow-list, so a key (or any field added later) can't ride along. */
export function publicTenant(t: TenantInfo): TenantInfo {
  return { id: t.id, name: t.name, slug: t.slug };
}

/**
 * The framework session as it may leave the server (into GET
 * /api/auth/session and every `auth()` reader): rebuilt from allow-listed
 * fields, so nothing beyond the Session type survives, in particular no
 * tenant API key.
 */
export function publicFrameworkSession(s: Session | null): Session | null {
  if (!s) return null;
  return {
    user: publicUser(s.user),
    tenant: s.tenant ? publicTenant(s.tenant) : null,
    role: s.role,
    permissions: [...(s.permissions ?? [])],
    memberships: (s.memberships ?? []).map((m) => ({ tenant: publicTenant(m.tenant), role: m.role })),
  };
}

/** JWT fields that must never ride in the Auth.js session cookie. */
const TOKEN_SECRET_FIELDS = ['framework', 'frameworkError', 'tenant', 'memberships', 'apiKey'] as const;

/**
 * A copy of an Auth.js JWT payload without fields that could carry tenant data
 * or keys. The framework's token needs only the user id (plus Auth.js's own
 * claims); this also cleans a token minted by older code when it is next read.
 */
export function stripTokenSecrets<T extends Record<string, unknown>>(token: T): T {
  const out: Record<string, unknown> = { ...token };
  for (const field of TOKEN_SECRET_FIELDS) delete out[field];
  return out as T;
}

/**
 * The framework's Auth.js `jwt` callback (wired in ./server.ts). Its result is
 * what the session cookie holds: the user id is stamped at sign-in, and every
 * read drops key-bearing fields (stripTokenSecrets).
 */
export function frameworkJwtCallback<T extends Record<string, unknown>>(
  token: T,
  user?: { id?: string | null } | null,
): T {
  const clean: Record<string, unknown> = stripTokenSecrets(token);
  if (user) clean.userId = user.id;
  return clean as T;
}

/**
 * The framework's Auth.js `session` callback (wired in ./server.ts). Its result
 * is the body of GET /api/auth/session and what `auth()` returns. It reads only
 * the user id from the token, attaches the allow-listed framework session (or
 * the failed-lookup flag), and never throws.
 */
export async function frameworkSessionCallback<S extends object>(
  session: S,
  token: Record<string, unknown>,
  resolve: (userId: string) => Promise<Session | null>,
): Promise<S> {
  if (typeof token.userId === 'string') {
    const userId = token.userId;
    await attachFrameworkSession(
      session as { framework?: Session | null; frameworkError?: string },
      () => resolve(userId),
    );
  }
  return session;
}
