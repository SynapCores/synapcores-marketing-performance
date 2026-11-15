import { redirect } from 'next/navigation';
import { signIn } from '@/lib/auth';
import { authErrorMessage } from '@/lib/auth-errors';

export default async function MagicLinkClickPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (!token) redirect('/login?error=' + encodeURIComponent('Missing token.'));
  try {
    await signIn('magic-link', { token, redirectTo: '/' });
  } catch (err) {
    const msg = authErrorMessage(err);
    if (!msg) throw err;
    redirect(`/login?error=${encodeURIComponent(msg)}`);
  }
  return null;
}
