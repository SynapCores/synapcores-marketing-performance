'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * The ROAS Flip with SVG connecting reorder-lines — ported from the standalone
 * command-center demo. Each campaign's day-0 ROAS rank (left) is joined to its
 * 90-day LTV:CAC rank (right) by a curved bezier: green if it climbed in the
 * truthful ranking, red if it fell, faint if it held. The crossing lines are
 * the whole point — they make "the ranking reverses" visible at a glance.
 *
 * Client component because the connectors are drawn from the *rendered* row
 * geometry (getBoundingClientRect), re-measured on mount and on resize.
 */

export interface FlipRow {
  campaign_id: string;
  campaign_name: string;
  platform: string;
  day0_roas: number;
  ltv_roas: number;
}

const PDOT: Record<string, string> = { facebook: '#4267B2', tiktok: '#ff0050', google: '#ea4335' };
const shortName = (n: string) => n.replace(/_/g, ' ');
const num = (n: number, d = 2) => Number(n).toFixed(d);

export default function FlipConnect({ rows }: { rows: FlipRow[] }) {
  const left = [...rows].sort((a, b) => b.day0_roas - a.day0_roas); // day-0 ROAS ranking
  const right = [...rows].sort((a, b) => b.ltv_roas - a.ltv_roas);  // 90-day LTV:CAC ranking
  const idx = (arr: FlipRow[], id: string) => arr.findIndex((r) => r.campaign_id === id);

  const hostRef = useRef<HTMLDivElement>(null);
  const leftRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const rightRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [paths, setPaths] = useState<Array<{ d: string; stroke: string; width: number; opacity: number }>>([]);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  const measure = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const hr = host.getBoundingClientRect();
    const W = hr.width, H = hr.height;
    const yOf = (map: Record<string, HTMLDivElement | null>, id: string) => {
      const el = map[id];
      if (!el) return 0;
      const pr = el.getBoundingClientRect();
      return pr.top - hr.top + pr.height / 2;
    };
    const next = left.map((r) => {
      const y1 = yOf(leftRefs.current, r.campaign_id);
      const y2 = yOf(rightRefs.current, r.campaign_id);
      const li = idx(left, r.campaign_id), ri = idx(right, r.campaign_id);
      const stroke = ri < li ? '#34d399' : ri > li ? '#f87171' : 'hsl(var(--border))';
      const moved = ri !== li;
      return {
        d: `M0 ${y1} C ${W * 0.5} ${y1}, ${W * 0.5} ${y2}, ${W} ${y2}`,
        stroke,
        width: moved ? 2 : 1.4,
        opacity: moved ? 0.85 : 0.35,
      };
    });
    setDims({ w: W, h: H });
    setPaths(next);
  }, [left, right]);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(() => measure());
    if (hostRef.current) ro.observe(hostRef.current);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const Col = ({ side, rowsIn, other, valueOf }: {
    side: 'left' | 'right'; rowsIn: FlipRow[]; other: FlipRow[]; valueOf: (r: FlipRow) => string;
  }) => (
    <div className="space-y-2">
      <h3 className={'mb-2 text-xs font-semibold uppercase tracking-wide ' + (side === 'left' ? 'text-rose-400' : 'text-emerald-400')}>
        {side === 'left' ? 'Day-0 ROAS — what the platforms show' : '90-day LTV : CAC — the truth'}
      </h3>
      {rowsIn.map((r, i) => {
        const move = idx(other, r.campaign_id) - i;
        const arrow = side === 'right' ? (move > 0 ? '▲' : move < 0 ? '▼' : '') : '';
        const border = side === 'right'
          ? (move > 0 ? 'border-l-emerald-400' : move < 0 ? 'border-l-rose-400' : 'border-l-transparent')
          : 'border-l-transparent';
        return (
          <div
            key={r.campaign_id}
            ref={(el) => { (side === 'left' ? leftRefs : rightRefs).current[r.campaign_id] = el; }}
            className={'flex items-center gap-3 rounded-md border border-border border-l-2 bg-card/70 px-3 py-2 text-sm ' + border}
          >
            <span className="w-4 text-muted-foreground tabular-nums">{i + 1}</span>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PDOT[r.platform] ?? '#888' }} />
            <span className="flex-1 truncate">{shortName(r.campaign_name)}</span>
            {arrow && <span className={move > 0 ? 'text-emerald-400' : 'text-rose-400'}>{arrow}</span>}
            <span className="font-semibold tabular-nums">{valueOf(r)}</span>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="grid items-stretch gap-0 md:grid-cols-[1fr_64px_1fr]">
      <Col side="left" rowsIn={left} other={right} valueOf={(r) => num(r.day0_roas, 3)} />
      <div ref={hostRef} className="relative hidden md:block" aria-hidden>
        <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${dims.w} ${dims.h}`} preserveAspectRatio="none">
          {paths.map((p, i) => (
            <path key={i} d={p.d} fill="none" stroke={p.stroke} strokeWidth={p.width} opacity={p.opacity} />
          ))}
        </svg>
      </div>
      <Col side="right" rowsIn={right} other={left} valueOf={(r) => num(r.ltv_roas, 2) + '×'} />
    </div>
  );
}
