import { headers } from 'next/headers';
import { AppPageHeader } from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import { listPixels } from '@/lib/pixels';
import { PixelsPanel } from './PixelsPanel';

export const dynamic = 'force-dynamic';

export default async function PixelsPage() {
  const session = await requireSession();
  const pixels = session.tenant ? await listPixels(session.tenant.id) : [];

  const h = await headers();
  const host = h.get('host') ?? 'localhost:3005';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const origin = `${proto}://${host}`;

  return (
    <div className="space-y-6">
      <AppPageHeader
        title="Tracking Pixels"
        description="A pixel id (pk_…) is a public asset identifier — like a Facebook Pixel ID. You embed it in your pages; it is write-only and can only drop events into this workspace. Mint one per site (or share one across your domains), then drop the snippet on each."
      />
      <PixelsPanel pixels={pixels} origin={origin} />
    </div>
  );
}
