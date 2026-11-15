/**
 * Auth.js `signIn` throws on bad credentials (CredentialsSignin) and on
 * expired/invalid magic links. Uncaught inside a server action or page that
 * surfaces as the generic "Application error" screen, so callers convert
 * those into a redirect with a user-facing message. Next.js control-flow
 * errors (redirect/notFound) are re-thrown untouched.
 */
export function authErrorMessage(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const type = (err as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  if (type === 'CredentialsSignin') return 'Invalid email or password.';
  if (type === 'Verification') return 'That sign-in link is invalid or has expired.';
  return 'Sign-in failed. Please try again.';
}
