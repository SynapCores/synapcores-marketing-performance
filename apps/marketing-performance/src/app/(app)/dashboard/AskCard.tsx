'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@synapcores/app-framework';
import { recommendAction } from '@/lib/actions';

/**
 * "Ask the Database" — the agentic capstone, ported from the demo. Everything
 * above is a report; this turns it into a decision. AGENT_RUN reads the live
 * scorecard with its own SQL tool and recommends the budget move. On this
 * CPU-only host the 7B ReAct loop can exceed its budget, so the server action
 * falls back to a deterministic recommendation derived from the same scorecard
 * — clearly badged either way. No export, no notebook.
 */

type Rec = { source: 'agent_run' | 'fallback'; text: string; tookMs: number; reason?: string };

function renderMd(s: string) {
  // minimal: **bold** → <b>, newlines → <br>
  const parts = s.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**')
      ? <b key={i} className="text-foreground">{p.slice(2, -2)}</b>
      : <span key={i}>{p}</span>,
  );
}

export default function AskCard() {
  const [rec, setRec] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(false);

  async function ask() {
    setLoading(true);
    setRec(null);
    try {
      const r = await recommendAction();
      setRec(r as Rec);
    } catch {
      setRec({ source: 'fallback', text: 'The recommendation service is unavailable right now.', tookMs: 0 });
    } finally {
      setLoading(false);
    }
  }

  const slow = rec ? /exceeded|budget|ReAct|timeout/i.test(rec.reason ?? '') : false;

  return (
    <Card className="tile-gradient">
      <CardHeader>
        <CardTitle>Ask the Database</CardTitle>
        <CardDescription>
          Everything above is a report. This turns it into a decision — <code className="rounded bg-muted px-1 py-0.5 text-xs text-primary">AGENT_RUN</code> reads
          the scorecard with its own SQL tool and recommends the budget move. No export, no notebook.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <button
          onClick={ask}
          disabled={loading}
          className="brand-gradient inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-transform hover:scale-[1.02] disabled:opacity-60"
        >
          {loading
            ? <><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground" /> AGENT_RUN is reading the scorecard…</>
            : <>Ask SynapCores what to do →</>}
        </button>

        {loading && (
          <p className="mt-3 text-xs text-muted-foreground">
            A 7B model runs locally with a SQL tool — seconds on a GPU, up to ~75s on this CPU host.
          </p>
        )}

        {rec && (
          <div className="mt-4 rounded-lg border border-border bg-card/60 p-4">
            <div className="mb-2 flex items-center gap-2 text-xs">
              {rec.source === 'agent_run' ? (
                <><span className="h-2 w-2 rounded-full bg-primary glow-teal" />
                  <span className="text-muted-foreground">AGENT_RUN · qwen2.5-coder · {(rec.tookMs / 1000).toFixed(1)}s</span></>
              ) : (
                <><span className="h-2 w-2 rounded-full bg-amber-400" />
                  <span className="text-muted-foreground">
                    {slow
                      ? 'deterministic · derived from the live scorecard (agent exceeded its budget on this CPU host)'
                      : 'deterministic · derived from the live scorecard'}
                  </span></>
              )}
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">{renderMd(rec.text)}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
