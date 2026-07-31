import { headers } from 'next/headers';
import { AppPageHeader } from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import { SOURCE_LIST } from '@/lib/sources';
import { IngestPanel } from './IngestPanel';

export const dynamic = 'force-dynamic';

export default async function IngestPage() {
  await requireSession();
  const h = await headers();
  const host = h.get('host') ?? 'localhost:3005';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const origin = `${proto}://${host}`;
  const sources = SOURCE_LIST.map((s) => ({ id: s.id, label: s.label, table: s.table, columns: s.columns, sample: s.sample }));

  return (
    <div className="space-y-6">
      <AppPageHeader title="Ingest Data" description="Connect Facebook, TikTok and Google ad spend, your clickstream, identity, conversions and orders — by CSV upload or the streaming ETL API." />
      <IngestPanel sources={sources} origin={origin} />
    </div>
  );
}
