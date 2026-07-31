/**
 * The Creative Angle scatter — ported from the standalone demo. Each campaign
 * is a point: x = how discount/urgency-led its ad copy is (cosine similarity of
 * the creative embedding to a "flash sale, hurry, cheapest" probe), y = the
 * 90-day LTV per customer it actually bought. A least-squares trend line makes
 * the inverse relationship explicit — the more discount-led the creative, the
 * lower the lifetime value it acquires.
 *
 * Pure data → SVG, so this stays a server component (no DOM measurement).
 */

export interface AngleRow {
  campaign_id: string;
  campaign_name: string;
  discount_affinity: number;
  ltv_90d: number;
}

const usd = (n: number) => '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
const platformOf = (id: string): string =>
  id.startsWith('fb') ? 'facebook' : id.startsWith('tt') ? 'tiktok' : id.startsWith('gg') ? 'google' : 'other';
const PDOT: Record<string, string> = { facebook: '#4267B2', tiktok: '#ff0050', google: '#ea4335', other: '#8a95ad' };

export default function AngleScatter({ rows }: { rows: AngleRow[] }) {
  if (!rows.length) return null;
  const W = 560, H = 320, pad = { l: 52, r: 18, t: 16, b: 44 };
  const xs = rows.map((r) => Number(r.discount_affinity));
  const ys = rows.map((r) => Number(r.ltv_90d));
  const xmin = Math.min(...xs, -0.05), xmax = Math.max(...xs, 0.6);
  const ymax = Math.max(...ys) * 1.14;
  const X = (v: number) => pad.l + (v - xmin) / (xmax - xmin) * (W - pad.l - pad.r);
  const Y = (v: number) => H - pad.b - (v / ymax) * (H - pad.t - pad.b);

  // least-squares trend line
  const n = rows.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxy = rows.reduce((a, r) => a + Number(r.discount_affinity) * Number(r.ltv_90d), 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  const trend = `M ${X(xmin)} ${Y(intercept + slope * xmin)} L ${X(xmax)} ${Y(intercept + slope * xmax)}`;

  // y gridlines
  const ticks = 4;
  const grid = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = (ymax / ticks) * i;
    return { y: Y(v), label: usd(v) };
  });

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[420px]" role="img"
        aria-label="Creative discount affinity versus 90-day LTV per customer">
        {grid.map((g, i) => (
          <g key={i}>
            <line x1={pad.l} y1={g.y} x2={W - pad.r} y2={g.y} stroke="hsl(var(--border))" strokeWidth={i === 0 ? 1 : 0.6} opacity={i === 0 ? 1 : 0.5} />
            <text x={pad.l - 8} y={g.y + 3} textAnchor="end" fontSize="10" fill="hsl(var(--muted-foreground))">{g.label}</text>
          </g>
        ))}
        {/* trend */}
        <path d={trend} stroke="hsl(var(--violet))" strokeWidth={1.6} strokeDasharray="5 4" fill="none" opacity={0.75} />
        {/* points */}
        {rows.map((r) => {
          const cx = X(Number(r.discount_affinity)), cy = Y(Number(r.ltv_90d));
          const color = PDOT[platformOf(r.campaign_id)];
          return (
            <g key={r.campaign_id}>
              <circle cx={cx} cy={cy} r={7} fill={color} stroke="hsl(var(--background))" strokeWidth={2} style={{ filter: `drop-shadow(0 0 5px ${color}aa)` }} />
              <text x={cx} y={cy - 12} textAnchor="middle" fontSize="11" fontWeight={600} fill="hsl(var(--foreground))">{usd(r.ltv_90d)}</text>
            </g>
          );
        })}
        <text x={W / 2} y={H - 10} textAnchor="middle" fontSize="11" fill="hsl(var(--muted-foreground))">discount / urgency affinity of the ad copy →</text>
        <text transform={`translate(14,${(H - pad.b) / 2 + 30}) rotate(-90)`} textAnchor="middle" fontSize="11" fill="hsl(var(--muted-foreground))">90-day LTV per customer</text>
      </svg>
    </div>
  );
}
