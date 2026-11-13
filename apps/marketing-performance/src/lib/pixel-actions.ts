'use server';
import { revalidatePath } from 'next/cache';
import { requireSession } from './session';
import { createPixel, disablePixel, deletePixel, type TrackingPixel } from './pixels';

const PIXELS_PATH = '/settings/pixels';

export async function createPixelAction(input: {
  label: string;
  allowedOrigins?: string;
}): Promise<{ ok: true; pixel: TrackingPixel } | { ok: false; error: string }> {
  const session = await requireSession();
  if (!session.tenant) return { ok: false, error: 'No workspace selected.' };

  const label = (input.label ?? '').trim();
  if (!label) return { ok: false, error: 'Give the pixel a label (e.g. the site it goes on).' };

  // Accept origins separated by newlines or commas; empty = unrestricted.
  const allowedOrigins = (input.allowedOrigins ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const pixel = await createPixel({
    tenantId: session.tenant.id,
    userId: session.user.id,
    label,
    allowedOrigins,
  });
  revalidatePath(PIXELS_PATH);
  return { ok: true, pixel };
}

export async function disablePixelAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  if (!session.tenant) return { ok: false, error: 'No workspace selected.' };
  await disablePixel(session.tenant.id, id);
  revalidatePath(PIXELS_PATH);
  return { ok: true };
}

export async function deletePixelAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  if (!session.tenant) return { ok: false, error: 'No workspace selected.' };
  await deletePixel(session.tenant.id, id);
  revalidatePath(PIXELS_PATH);
  return { ok: true };
}
