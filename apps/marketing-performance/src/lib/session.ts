import 'server-only';
import { redirect } from 'next/navigation';
import { frameworkSessionOf } from '@synapcores/app-framework/auth/session-state';
import { auth } from './auth';
import type { Session } from '@synapcores/app-framework';

/**
 * The signed-in framework session, or null when signed out. Throws
 * SessionUnavailableError when the session could not be looked up (the
 * analytics engine is restarting): the error boundary then shows
 * "Reconnecting…" and retries, instead of sending a signed-in user to /login.
 */
export async function getSession(): Promise<Session | null> {
  return frameworkSessionOf(await auth());
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect('/login');
  return s;
}
