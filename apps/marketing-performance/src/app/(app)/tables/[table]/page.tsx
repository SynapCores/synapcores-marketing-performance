import { notFound } from 'next/navigation';
import { AppPageHeader, Card, CardContent, DataTable, type DataTableColumn } from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import { tableRows, TABLE_META, type Row } from '@/lib/warehouse';
import { TABLES } from '@/lib/recipe-sql';

export const dynamic = 'force-dynamic';

export default async function TableBrowsePage({ params }: { params: Promise<{ table: string }> }) {
  await requireSession();
  const { table } = await params;
  if (!TABLES.includes(table)) notFound();

  const meta = TABLE_META[table];
  const { columns, rows } = await tableRows(table, 500);

  // The `angle` embedding column is 384 floats — summarize instead of dumping it.
  const displayCols = columns.filter((c) => c !== 'angle');
  const cols: DataTableColumn<Row>[] = displayCols.map((c) => ({
    key: c, header: c,
    cell: (row: Row) => formatCell(row[c]),
  }));
  if (columns.includes('angle')) {
    cols.push({ key: 'angle', header: 'angle', cell: (row: Row) => (row.angle ? <span className="text-muted-foreground">vector(384)</span> : '—') });
  }

  return (
    <div className="space-y-6">
      <AppPageHeader
        title={meta?.label ?? table}
        back={{ href: '/tables', label: 'Data Tables' }}
        description={<>{meta?.desc} · <span className="text-muted-foreground">{rows.length.toLocaleString()} rows shown</span></>}
      />
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <DataTable<Row> columns={cols} rows={rows} emptyState={`No rows in ${table} yet — ingest data or load the sample dataset.`} />
        </CardContent>
      </Card>
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}
