import Link from 'next/link';
import { AppPageHeader, Card, CardContent } from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import { listTables } from '@/lib/warehouse';

export const dynamic = 'force-dynamic';

const groups = ['Platform', 'First-party', 'Derived'];

export default async function TablesPage() {
  const session = await requireSession();
  const tables = await listTables(session.tenant?.id);

  return (
    <div className="space-y-6">
      <AppPageHeader title="Data Tables" description="Every table behind the reports — the marketing warehouse, live in SynapCores. Browse rows, verify ingestion, inspect the derived attribution and scorecard." />
      {groups.map((g) => (
        <div key={g}>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{g}</h3>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {tables.filter((t) => t.meta?.group === g).map((t) => (
              <Link key={t.table} href={`/tables/${t.table}`} prefetch={false}>
                <Card className="h-full transition hover:border-primary">
                  <CardContent className="pt-5">
                    <div className="flex items-baseline justify-between">
                      <span className="font-semibold">{t.meta?.label ?? t.table}</span>
                      <span className="text-sm tabular-nums text-muted-foreground">{t.count < 0 ? '—' : `${t.count.toLocaleString()} rows`}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{t.meta?.desc}</p>
                    <p className="mt-2 text-[11px] text-muted-foreground/70">source: {t.meta?.source}</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
