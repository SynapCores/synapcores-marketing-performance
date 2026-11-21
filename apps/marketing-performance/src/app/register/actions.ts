'use server';
import { createUser, type CreateUserInput } from '@synapcores/app-framework/auth/server-actions';
import { signupAllowed } from '@/lib/security';
export async function register(input: CreateUserInput): Promise<{ id: string }> {
  if (!signupAllowed(String(input.email ?? ''))) {
    throw new Error('Sign-up is by invitation only. Ask a workspace admin to invite you.');
  }
  const user = await createUser(input);
  return { id: user.id };
}
