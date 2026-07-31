'use client';
import { useState, useTransition } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, Button } from '@synapcores/app-framework';
import { loadSampleAction, clearAction, ingestCsvAction } from '@/lib/actions';

interface SourceInfo { id: string; label: string; table: string; columns: string[]; sample?: string }

export function IngestPanel({ sources, origin }: { sources: SourceInfo[]; origin: string }) {
  const [busy, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const platform = sources.filter((s) => s.table === 'recipe_pm_ad_spend');
  const firstParty = sources.filter((s) => s.table !== 'recipe_pm_ad_spend');

  function run(fn: () => Promise<{ ok?: boolean; error?: string; ingested?: number; table?: string }>, label: string) {
    setMsg(null);
    startTransition(async () => {
      try {
        const r = await fn();
        if (r.error) setMsg({ kind: 'err', text: r.error });
        else setMsg({ kind: 'ok', text: r.ingested != null ? `Ingested ${r.ingested} rows into ${r.table}.` : `${label} complete.` });
      } catch (e) { setMsg({ kind: 'err', text: String((e as Error).message) }); }
    });
  }

  async function onFile(sourceId: string, file: File) {
    const text = await file.text();
    run(() => ingestCsvAction(sourceId, text), 'Upload');
  }

  return (
    <div className="space-y-6">
      {msg && (
        <div className={'rounded-md border px-4 py-2 text-sm ' + (msg.kind === 'ok' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500' : 'border-rose-500/40 bg-rose-500/10 text-rose-500')}>{msg.text}</div>
      )}

      <Card>
        <CardHeader><CardTitle>Quick start</CardTitle>
          <CardDescription>Load a realistic 3-platform dataset (recipe 121) to explore the whole pipeline, or start ingesting your own below.</CardDescription></CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button disabled={busy} onClick={() => run(loadSampleAction, 'Sample load')}>{busy ? 'Working…' : 'Load sample dataset'}</Button>
          <Button variant="outline" disabled={busy} onClick={() => run(clearAction, 'Clear')}>Clear all data</Button>
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Platform ad spend</h3>
        <div className="grid gap-4 md:grid-cols-3">
          {platform.map((s) => <ConnectorCard key={s.id} s={s} busy={busy} onFile={onFile} />)}
        </div>
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">First-party data</h3>
        <div className="grid gap-4 md:grid-cols-3">
          {firstParty.map((s) => <ConnectorCard key={s.id} s={s} busy={busy} onFile={onFile} />)}
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Streaming / ETL API</CardTitle>
          <CardDescription>Push data continuously from Airbyte, Fivetran, dbt, or a cron job. Create an API key under <a className="underline" href="/settings/api-keys">Settings › API Keys</a>, then POST rows:</CardDescription></CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs leading-relaxed"><code>{`curl -X POST ${origin}/api/v1/ingest/facebook \\
  -H "Authorization: Bearer sk_user_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"rows":[
    {"campaign_id":"fb-1001","campaign_name":"FB_Prospecting","objective":"prospecting",
     "day":"2026-05-04","spend":420,"impressions":58200,"clicks_reported":6}
  ]}'`}</code></pre>
          <p className="mt-3 text-xs text-muted-foreground">Sources: <code>facebook</code>, <code>tiktok</code>, <code>google</code>, <code>clickstream</code>, <code>identity</code>, <code>conversions</code>, <code>orders</code>, <code>creative</code>. NDJSON is also accepted (<code>Content-Type: application/x-ndjson</code>). The primary key is auto-assigned when omitted; attribution and the scorecard rebuild after each load.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function ConnectorCard({ s, busy, onFile }: { s: SourceInfo; busy: boolean; onFile: (id: string, f: File) => void }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{s.label}</CardTitle>
        <CardDescription className="text-xs">→ {s.table}</CardDescription></CardHeader>
      <CardContent className="space-y-2">
        <label className={'inline-flex cursor-pointer items-center rounded-md border border-border px-3 py-1.5 text-sm hover:border-primary ' + (busy ? 'opacity-50' : '')}>
          Upload CSV
          <input type="file" accept=".csv,text/csv" className="hidden" disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(s.id, f); e.currentTarget.value = ''; }} />
        </label>
        <p className="truncate text-[11px] text-muted-foreground">cols: {s.columns.join(', ')}</p>
      </CardContent>
    </Card>
  );
}
