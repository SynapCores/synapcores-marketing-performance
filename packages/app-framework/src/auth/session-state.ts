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
 * retries. Plain module (no server-only imports), so it is unit-testable.
 */

import { ENGINE_UNAVAILABLE_DIGEST } from '../db/unavailable';
import type { Session } from './types';

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
    out.framework = await resolve();
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
