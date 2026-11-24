'use server';

import { redirect } from 'next/navigation';
import { signIn } from '@/lib/auth';
import { authErrorMessage } from '@/lib/auth-errors';

const BAD_LINK = 'That sign-in link is invalid, expired or already used. Request a new one.';

/**
 * Redeems a magic-link token. This runs as a Server Action (a POST from the
 * /login/magic page), the only place besides a Route Handler where Next.js lets
 * Auth.js set the session cookie. The token itself is single-use and expires
 * after 10 minutes (enforced in redeemAuthToken).
 */
export async function redeemMagicLink(formData: FormData): Promise<void> {
  const token = formData.get('token');
  if (typeof token !== 'string' || !token || token.length > 512) redirect('/login?error=' + encodeURIComponent(BAD_LINK));
  try {
    await signIn('magic-link', { token, redirectTo: '/' });
  } catch (err) {
    const msg = authErrorMessage(err);
    if (!msg) throw err; // NEXT_REDIRECT on success
    redirect('/login?error=' + encodeURIComponent(BAD_LINK));
  }
}
