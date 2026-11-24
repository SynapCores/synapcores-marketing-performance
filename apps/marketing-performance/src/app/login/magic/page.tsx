import { redirect } from 'next/navigation';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@synapcores/app-framework';
import { Mail } from 'lucide-react';
import { redeemMagicLink } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Landing page for the e-mailed sign-in link. It only renders a confirm
 * button: the token is redeemed by the `redeemMagicLink` Server Action on
 * submit (cookies can't be set while rendering a page), and a plain GET never
 * consumes the single-use token, so mail scanners that prefetch links can't
 * burn it.
 */
export default async function MagicLinkClickPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (!token) redirect('/login?error=' + encodeURIComponent('Missing token.'));
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-3">
            <div className="rounded-full bg-primary/10 p-3">
              <Mail className="h-7 w-7 text-primary" />
            </div>
          </div>
          <CardTitle className="text-2xl">Sign in</CardTitle>
          <CardDescription>Continue to Performance Marketing. This link works once and expires 10 minutes after it was sent.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={redeemMagicLink}>
            <input type="hidden" name="token" value={token} />
            <Button type="submit" className="w-full">Continue</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
