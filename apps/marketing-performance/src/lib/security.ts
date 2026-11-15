import 'server-only';
import type { Session } from '@synapcores/app-framework';

/**
 * Production guard rails.
 *
 * - Sign-up is closed by default. `SIGNUP_ALLOWED_EMAILS` (comma-separated)
 *   lets specific addresses register; everyone else joins by invitation.
 *   `SIGNUP_OPEN=true` restores the open demo behaviour.
 * - Warehouse mutations (load sample / clear / rebuild / CSV ingest) and pixel
 *   management need an owner or admin role, not just any session.
 */

export function signupOpen(): boolean {
  return process.env.SIGNUP_OPEN === 'true';
}

export function signupAllowed(email: string): boolean {
  if (signupOpen()) return true;
  const allow = (process.env.SIGNUP_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(email.trim().toLowerCase());
}

export class ForbiddenError extends Error {
  constructor(message = 'You do not have permission to do that.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

const WRITE_ROLES = new Set(['owner', 'admin']);

export function canWrite(session: Session): boolean {
  return !!session.tenant && !!session.role && WRITE_ROLES.has(session.role);
}

export function assertCanWrite(session: Session): void {
  if (!canWrite(session)) throw new ForbiddenError('Only workspace owners and admins can change data.');
}

/** Small fixed-window limiter (per process). Returns true when over the limit. */
export function makeLimiter(max: number, windowMs: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let sweepAt = Date.now() + windowMs;
  return function limited(key: string): boolean {
    const now = Date.now();
    if (now > sweepAt) {
      for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k);
      sweepAt = now + windowMs;
    }
    const b = buckets.get(key);
    if (!b || now > b.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return false;
    }
    b.count += 1;
    return b.count > max;
  };
}

/**
 * Client IP as seen by our single reverse proxy. Apache APPENDS the real peer
 * to X-Forwarded-For, so the last entry is the trustworthy one; earlier
 * entries are client-supplied and can be forged.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',').pop()!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}
