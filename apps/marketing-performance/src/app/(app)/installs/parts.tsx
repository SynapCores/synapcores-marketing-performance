/**
 * Server-rendered building blocks for the Installs page (plain divs, no chart
 * library, no client JS).
 */
import { Card, CardContent } from '@synapcores/app-framework';
import type { InstallClass } from '@/lib/installs/feed';
import type { BucketRow, MixRow } from '@/lib/installs/report';

export const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US'));
/** "YYYY-MM-DD HH:MM" from an ISO UTC timestamp. */
export const utc = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');

export function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

const CLASS_STYLE: Record<InstallClass, string> = {
  external: 'bg-emerald-500/15 text-emerald-500',
  ci: 'bg-sky-500/15 text-sky-500',
  internal: 'bg-violet-500/15 text-violet-500',
  'likely-internal': 'bg-violet-500/10 text-violet-400',
  partner: 'bg-amber-500/15 text-amber-500',
  test: 'bg-muted text-muted-foreground',
};

export function ClassBadge({ cls, reason }: { cls: InstallClass; reason?: string | null }) {
  return (
    <span className={'whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ' + CLASS_STYLE[cls]} title={reason ? `reason: ${reason}` : undefined}>
      {cls}
    </span>
  );
}

/** Headline number, styled like the dashboard tiles. */
export function Tile({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Card className="tile-gradient">
      <CardContent className="pt-5">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="glow-text mt-1 text-2xl font-bold tabular-nums">{fmt(value)}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
      </CardContent>
    </Card>
  );
}

export interface FunnelStep {
  label: string;
  /** null = not available (shown as `note`). */
  value: number | null;
  note?: string;
}

/** Horizontal bars; ≈ % of the first step (indicative — steps aren't linked per person). */
export function FunnelSteps({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(1, ...steps.map((s) => s.value ?? 0));
  const base = steps[0]?.value ?? null;
  return (
    <ul className="space-y-2 text-sm">
      {steps.map((s, i) => (
        <li key={s.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:flex sm:gap-3">
          <span className="col-span-2 leading-snug sm:col-span-1 sm:w-64 sm:shrink-0">{s.label}</span>
          <span className="h-2 min-w-0 flex-1">
            <span className="block h-2 rounded bg-primary/60" style={{ width: s.value ? `${(s.value / max) * 100}%` : '0' }} />
          </span>
          <span className="whitespace-nowrap text-right tabular-nums sm:w-48 sm:shrink-0">
            {s.value == null ? <span className="text-muted-foreground">{s.note ?? '—'}</span> : (
              <>
                <b>{fmt(s.value)}</b>
                {s.note ? <span className="text-muted-foreground"> {s.note}</span> : null}
                {i > 0 && base ? <span className="text-muted-foreground"> · ≈{Math.round((s.value / base) * 1000) / 10}%</span> : null}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Bar({ v, max, className, label }: { v: number; max: number; className: string; label: boolean }) {
  return (
    <div className="flex h-full w-full max-w-[18px] flex-col items-center justify-end">
      {label && v > 0 ? <span className="text-[9px] leading-tight tabular-nums text-muted-foreground">{v}</span> : null}
      <div className={'w-full rounded-t ' + className} style={{ height: v ? `${Math.max(2, (v / max) * 85)}%` : '0' }} />
    </div>
  );
}

/** New installs + new people per bucket (+ the other classes when show=all). */
export function BucketChart({ buckets, showOther }: { buckets: BucketRow[]; showOther: boolean }) {
  if (!buckets.length) return null;
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.new_installs, b.new_people, showOther ? b.other_new : 0)));
  const every = Math.max(1, Math.ceil(buckets.length / 12));
  const labels = buckets.length <= 16;
  return (
    <div>
      <div className="flex h-44 items-end gap-1 border-b border-border">
        {buckets.map((b) => (
          <div
            key={b.start}
            className={'flex h-full min-w-0 flex-1 items-end justify-center gap-px' + (b.partial ? ' opacity-60' : '')}
            title={`${b.label}${b.partial ? ' (partial)' : ''}: ${b.new_installs} new installs, ${b.new_people} new people${showOther ? `, ${b.other_new} CI / internal / partner / test ids` : ''}`}
          >
            <Bar v={b.new_installs} max={max} className="bg-primary/80" label={labels} />
            <Bar v={b.new_people} max={max} className="bg-emerald-500/70" label={labels} />
            {showOther ? <Bar v={b.other_new} max={max} className="bg-muted-foreground/40" label={labels} /> : null}
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1 text-[10px] text-muted-foreground">
        {buckets.map((b, i) => (
          <div key={b.start} className="min-w-0 flex-1 truncate text-center">{i % every === 0 ? b.short : ''}</div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-primary/80" /> new external installs</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500/70" /> new people</span>
        {showOther ? <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-muted-foreground/40" /> CI / internal / partner / test ids</span> : null}
        {buckets.some((b) => b.partial) ? <span>faded = partial bucket</span> : null}
      </div>
    </div>
  );
}

export function BucketTable({ buckets, showDownloads }: { buckets: BucketRow[]; showDownloads: boolean }) {
  const muted = 'pr-3 text-right tabular-nums text-muted-foreground';
  return (
    <div className="mt-6 max-h-[440px] overflow-auto">
      <table className="w-full min-w-[820px] text-sm">
        <thead className="sticky top-0 bg-card">
          <tr className="text-left text-xs uppercase text-muted-foreground">
            <th className="py-2 pr-3">Period (UTC)</th>
            <th className="pr-3 text-right">New installs</th>
            <th className="pr-3 text-right">New people</th>
            <th className="pr-3 text-right">Active installs</th>
            <th className="pr-3 text-right">Active people</th>
            <th className="pr-3 text-right" title="CI installation ids first seen in the period (not counted as installs)">CI ids</th>
            <th className="pr-3 text-right" title="internal, likely-internal and test ids first seen in the period (not counted as installs)">Internal ids</th>
            <th className="pr-3 text-right" title="design-partner ids first seen / active in the period (reported separately)">Partner new / active</th>
            {showDownloads ? <th className="text-right" title="GitHub release archive downloads: growth of the cumulative counter between daily snapshots">GitHub downloads</th> : null}
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.start} className="border-t border-border">
              <td className="whitespace-nowrap py-1.5 pr-3">
                {b.label}
                {b.partial ? <span className="ml-1 text-xs text-muted-foreground">(partial)</span> : null}
              </td>
              <td className="pr-3 text-right font-medium tabular-nums">{b.new_installs}</td>
              <td className="pr-3 text-right font-medium tabular-nums">{b.new_people}</td>
              <td className="pr-3 text-right tabular-nums">{b.active_installs}</td>
              <td className="pr-3 text-right tabular-nums">{b.active_people}</td>
              <td className={muted}>{b.ci_ids}</td>
              <td className={muted}>{b.internal_ids}</td>
              <td className={muted}>{b.partner_ids} / {b.partner_active}</td>
              {showDownloads ? (
                <td className="text-right tabular-nums">
                  {b.downloads != null ? fmt(b.downloads) : null}
                  {b.downloads_baseline ? <span className="ml-1 text-xs text-muted-foreground">{b.downloads != null ? '+ ' : ''}baseline</span> : null}
                  {b.downloads == null && !b.downloads_baseline ? <span className="text-muted-foreground">—</span> : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MixTable({ title, rows, newLabel, activeLabel }: { title: string; rows: MixRow[]; newLabel: string; activeLabel: string }) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No installs in this view.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase text-muted-foreground">
              <th className="py-1 pr-2 font-medium"> </th>
              <th className="pr-2 text-right font-medium">{newLabel}</th>
              <th className="text-right font-medium">{activeLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-border">
                <td className={'max-w-[160px] truncate py-1 pr-2' + (r.key.startsWith('(') ? ' text-muted-foreground' : '')} title={r.key}>{r.key}</td>
                <td className="pr-2 text-right tabular-nums">{r.new}</td>
                <td className="text-right tabular-nums">{r.active}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
