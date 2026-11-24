import { NextResponse } from 'next/server';
import { resolveBearerKey } from '@/lib/api-auth';
import { SOURCES } from '@/lib/sources';
import { ingestRecords, rebuildDerived } from '@/lib/warehouse';

export const runtime = 'nodejs';

/**
 * ETL ingestion endpoint.
 *
 *   POST /api/v1/ingest/:source
 *   Authorization: Bearer sk_user_...        (an app API key — create one under Settings › API Keys)
 *   Content-Type: application/json           body = { "rows": [ {...}, ... ] }
 *                 application/x-ndjson        body = one JSON object per line
 *
 * `:source` is one of: facebook, tiktok, google, clickstream, identity,
 * conversions, orders, creative. Rows are mapped to the warehouse schema and
 * inserted; derived tables (attribution + scorecard) are rebuilt.
 */
export async function POST(req: Request, ctx: { params: Promise<{ source: string }> }) {
  const key = await resolveBearerKey(req);
  if (!key) {
    return NextResponse.json({ error: { code: 'unauthorized', message: 'Provide a valid app API key: Authorization: Bearer sk_user_...' } }, { status: 401 });
  }

  const { source } = await ctx.params;
  const def = SOURCES[source];
  if (!def) {
    return NextResponse.json({ error: { code: 'unknown_source', message: `Unknown source '${source}'. Valid: ${Object.keys(SOURCES).join(', ')}` } }, { status: 400 });
  }

  // Parse JSON { rows: [...] } or NDJSON (one object per line).
  let records: Array<Record<string, unknown>> = [];
  const ct = req.headers.get('content-type') ?? '';
  const text = await req.text();
  if (text.length > 10 * 1024 * 1024) {
    return NextResponse.json({ error: { code: 'too_large', message: 'Body over 10 MB; split the load into batches.' } }, { status: 413 });
  }
  try {
    if (ct.includes('ndjson') || ct.includes('text/plain')) {
      records = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
    } else {
      const body = JSON.parse(text || '{}');
      records = Array.isArray(body) ? body : Array.isArray(body.rows) ? body.rows : [];
    }
  } catch {
    return NextResponse.json({ error: { code: 'bad_body', message: 'Body must be JSON {rows:[...]} or NDJSON.' } }, { status: 400 });
  }
  if (!records.length) {
    return NextResponse.json({ error: { code: 'empty', message: 'No rows to ingest.' } }, { status: 400 });
  }

  // Missing primary keys are numbered from the current max, so ETL callers can omit them.
  const ingested = await ingestRecords(def, records);
  // Keep attribution + the scorecard current after every load.
  try { await rebuildDerived(); } catch { /* base tables may be incomplete; ignore */ }

  return NextResponse.json({ data: { source, table: def.table, ingested } });
}
