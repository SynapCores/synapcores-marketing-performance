'use client';
import { useState, useTransition } from 'react';
import { Card, CardContent, Button } from '@synapcores/app-framework';
import { recommendAction } from '@/lib/actions';

type Rec = { source: 'agent_run' | 'fallback'; text: string; tookMs: number; reason?: string };

export function RecommendPanel() {
  const [busy, start] = useTransition();
  const [rec, setRec] = useState<Rec | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function ask() {
    setErr(null); setRec(null);
    start(async () => {
      try { setRec(await recommendAction()); }
      catch (e) { setErr(String((e as Error).message)); }
    });
  }

  const html = rec ? rec.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') : '';
  const slow = rec?.reason && /exceeded|budget|ReAct/i.test(rec.reason);

  return (
    <div className="space-y-4">
      <Button onClick={ask} disabled={busy}>{busy ? 'AGENT_RUN is reading the scorecard…' : 'Ask SynapCores what to do →'}</Button>
      {busy && <p className="text-xs text-muted-foreground">A 7B model runs locally with its own execute_query tool — seconds on GPU, up to ~75s on CPU.</p>}
      {err && <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-500">{err}</div>}
      {rec && (
        <Card><CardContent className="pt-6">
          <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: rec.source === 'agent_run' ? '#5eead4' : '#fbbf24' }} />
            {rec.source === 'agent_run'
              ? `AGENT_RUN · qwen2.5-coder · ${(rec.tookMs / 1000).toFixed(1)}s`
              : slow ? 'deterministic · derived from the live scorecard (agent slow on this CPU host)'
                     : 'deterministic · derived from the live scorecard'}
          </div>
          <div className="text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
        </CardContent></Card>
      )}
    </div>
  );
}
