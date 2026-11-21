'use server';
import { createTenant } from '@synapcores/app-framework/auth/server-actions';
import { requireSession } from '@/lib/session';
import { signupAllowed } from '@/lib/security';
export async function provisionWorkspace(input: { name: string; slug?: string }): Promise<{ tenantId: string }> {
  const session = await requireSession();
  // New workspaces only for allow-listed accounts; everyone else joins by invitation.
  if (!signupAllowed(session.user.email)) {
    throw new Error('Creating a workspace is restricted. Ask an admin to invite you to the existing one.');
  }
  const tenant = await createTenant({
    name: input.name,
    slug: input.slug,
    ownerUserId: session.user.id,
  });
  return { tenantId: tenant.id };
}
