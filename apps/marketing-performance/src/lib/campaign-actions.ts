'use server';
import { revalidatePath } from 'next/cache';
import { requireSession } from './session';
import { canWrite } from './security';
import { deleteCampaign, insertCampaign } from './event-store';
import { buildCampaignUrl, CHANNELS, cleanParam, type SavedCampaign } from './visitor/campaigns';

export interface CreateCampaignInput {
  siteUrl: string;
  source: string;
  medium: string;
  campaign: string;
  content?: string;
  term?: string;
  name?: string;
  channel?: string;
  notes?: string;
}

export async function createCampaignAction(input: CreateCampaignInput): Promise<{ ok: true; campaign: SavedCampaign } | { ok: false; error: string }> {
  const session = await requireSession();
  if (!session.tenant) return { ok: false, error: 'No workspace selected.' };
  if (!canWrite(session)) return { ok: false, error: 'Only workspace owners and admins can create campaigns.' };
  const built = buildCampaignUrl(input);
  if (!built.ok) return built;
  const channel = (CHANNELS as readonly string[]).includes(String(input.channel)) ? String(input.channel) : 'other';
  const campaign = await insertCampaign({
    tenantId: session.tenant.id,
    createdBy: session.user.email ?? session.user.id ?? null,
    name: String(input.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 120) || cleanParam(input.campaign),
    channel,
    site: built.site,
    site_url: input.siteUrl.trim().slice(0, 2048),
    utm_source: cleanParam(input.source),
    utm_medium: cleanParam(input.medium),
    utm_campaign: cleanParam(input.campaign),
    utm_content: cleanParam(input.content) || null,
    utm_term: cleanParam(input.term) || null,
    tagged_url: built.url,
    notes: String(input.notes ?? '').trim().slice(0, 2000) || null,
  });
  revalidatePath('/utm-campaigns');
  revalidatePath('/utm-campaigns/builder');
  return { ok: true, campaign };
}

export async function deleteCampaignAction(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  if (!session.tenant) return { ok: false, error: 'No workspace selected.' };
  if (!canWrite(session)) return { ok: false, error: 'Only workspace owners and admins can delete campaigns.' };
  await deleteCampaign(session.tenant.id, String(id));
  revalidatePath('/utm-campaigns');
  revalidatePath('/utm-campaigns/builder');
  return { ok: true };
}
