/**
 * Installs report: aggregates over the parsed feed rows for the Installs page.
 * Pure (no I/O) — unit-tested in tests/installs-report.test.ts.
 *
 * Definitions match the SynapCores installs log (tel8w.py):
 *  - new install  = a `class=external` installation whose first_seen (first
 *    install signal: created / started / version changed / heartbeat) is in
 *    the window / bucket
 *  - new person   = a person row whose first_seen is in the window / bucket
 *  - active       = an event in the bucket. The feed keeps activity per UTC day
 *    (`active_days`), so a day counts toward every bucket it overlaps, narrowed
 *    on the first / last day by first_seen / last_seen. That makes the last
 *    weekly bucket equal the exact "last 7 days" figure (last_seen ≥ now − 7 d).
 *  - CI / internal (internal + likely-internal + test) / partner ids = ids of
 *    that class first seen in the bucket (tel8w's weekly CI / internal columns);
 *    partner activity is reported separately, like tel8w does.
 * Day buckets are UTC dates (the first and the current one may be partial).
 * Week buckets are rolling 7-day windows ending at `now`
 * ([now − 7(i+1) d, now − 7i d)), oldest first, labelled MM-DD→MM-DD; the
 * first one is clipped to the window start and marked partial.
 *
 * GitHub release downloads are cumulative counters: a snapshot's downloads are
 * the growth of `archives` since the previous snapshot, counted at the middle
 * of that interval (snapshots are fetched once a day around 01:50 UTC, so that
 * is the UTC day the downloads mostly happened; a gap of several days lands
 * mid-gap and is flagged). The first snapshot has no previous one — it is the
 * baseline, not downloads.
 */
import type { InstallClass, InstallationRow, PersonRow, SnapshotRow } from './feed';

export const RANGES = ['7', '30', '90', 'all'] as const;
export type RangeKey = (typeof RANGES)[number];
export const GRANULARITIES = ['day', 'week'] as const;
export type Granularity = (typeof GRANULARITIES)[number];
export const SHOW_MODES = ['external', 'all'] as const;
export type ShowMode = (typeof SHOW_MODES)[number];

export const parseRange = (v: string | null | undefined): RangeKey => ((RANGES as readonly string[]).includes(v ?? '') ? (v as RangeKey) : '30');
export const parseGranularity = (v: string | null | undefined): Granularity => (v === 'day' ? 'day' : 'week');
export const parseShow = (v: string | null | undefined): ShowMode => (v === 'all' ? 'all' : 'external');

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
const MAX_BUCKETS = 2_000;
/** "All time" goes back at most this far (5 years), so day buckets always cover the whole window. */
export const ALL_MAX_DAYS = 1_830;
export const RECENT_LIMIT = 100;
export const INTERNAL_CLASSES: ReadonlySet<InstallClass> = new Set<InstallClass>(['internal', 'likely-internal', 'test']);

export interface InstallsData {
  installations: readonly InstallationRow[];
  people: readonly PersonRow[];
  snapshots: readonly SnapshotRow[];
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const utcDayStart = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const mmdd = (t: number) => new Date(t).toISOString().slice(5, 10);

// ── window + buckets ─────────────────────────────────────────────────────────
export interface ReportWindow {
  range: RangeKey;
  start: number;
  end: number;
  /** Whole days covered (for the /download funnel window). */
  days: number;
}

/** Earliest timestamp of any row (installation, person, snapshot), or null. */
export function firstRowAt(data: InstallsData): number | null {
  let min = Infinity;
  const see = (t: number) => {
    if (t < min) min = t;
  };
  for (const r of data.installations) {
    see(ms(r.first_seen));
    see(ms(r.last_seen));
    if (r.active_days[0]) see(dayMs(r.active_days[0]));
  }
  for (const p of data.people) {
    see(ms(p.first_seen));
    if (p.active_days[0]) see(dayMs(p.active_days[0]));
  }
  for (const s of data.snapshots) {
    see(ms(s.fetched_at));
    see(dayMs(s.date));
  }
  return Number.isFinite(min) ? min : null;
}

/** [now − days, now); "all" = since the UTC day of the first row (at most ALL_MAX_DAYS back). */
export function reportWindow(data: InstallsData, range: RangeKey, now: number): ReportWindow {
  if (range === 'all') {
    const first = firstRowAt(data);
    const start = first === null ? now - 30 * DAY_MS : Math.max(now - ALL_MAX_DAYS * DAY_MS, Math.min(utcDayStart(first), now - DAY_MS));
    return { range, start, end: now, days: Math.max(1, Math.ceil((now - start) / DAY_MS)) };
  }
  const days = Number(range);
  return { range, start: now - days * DAY_MS, end: now, days };
}

export interface BucketSpan {
  start: number;
  end: number;
  /** "YYYY-MM-DD" (day) or "MM-DD→MM-DD" (week). */
  label: string;
  /** Short axis label: "MM-DD". */
  short: string;
  partial: boolean;
}

export function bucketSpans(win: { start: number; end: number }, g: Granularity): BucketSpan[] {
  const out: BucketSpan[] = [];
  if (!(win.end > win.start)) return out;
  if (g === 'day') {
    // Newest first (then reversed), so a cap would drop the oldest days, never the latest.
    const firstDay = utcDayStart(win.start);
    for (let d = utcDayStart(win.end - 1); d >= firstDay && out.length < MAX_BUCKETS; d -= DAY_MS) {
      const s = Math.max(d, win.start);
      const z = Math.min(d + DAY_MS, win.end);
      if (z > s) out.push({ start: s, end: z, label: ymd(d), short: mmdd(d), partial: z - s < DAY_MS });
    }
    return out.reverse();
  }
  for (let i = 0; i < MAX_BUCKETS; i++) {
    const z = win.end - i * WEEK_MS;
    if (z <= win.start) break;
    const s0 = win.end - (i + 1) * WEEK_MS;
    const s = Math.max(s0, win.start);
    out.push({ start: s, end: z, label: `${mmdd(s)}→${mmdd(z)}`, short: mmdd(s), partial: s > s0 });
  }
  return out.reverse();
}

/** Index of the bucket holding t, or -1. */
function bucketOf(spans: readonly BucketSpan[], t: number): number {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = spans[mid]!;
    if (t < b.start) hi = mid - 1;
    else if (t >= b.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** First bucket whose end is after t (spans are sorted and contiguous). */
function firstEndingAfter(spans: readonly BucketSpan[], t: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.end > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ── activity ─────────────────────────────────────────────────────────────────
interface ActivityRow {
  first_seen: string | null;
  last_seen: string | null;
  active_days: readonly string[];
}

/**
 * Activity per active UTC day as [lo, hi), narrowed to [first_seen, …) on the
 * first day and to (…, last_seen] on the last day.
 */
function dayIntervals(r: ActivityRow): Array<{ day: string; lo: number; hi: number }> {
  const first = ms(r.first_seen);
  const last = ms(r.last_seen);
  const firstDay = Number.isFinite(first) ? utcDayStart(first) : NaN;
  const lastDay = Number.isFinite(last) ? utcDayStart(last) : NaN;
  const out: Array<{ day: string; lo: number; hi: number }> = [];
  for (const day of r.active_days) {
    const ds = dayMs(day);
    if (!Number.isFinite(ds)) continue;
    let lo = ds;
    let hi = ds + DAY_MS;
    if (ds === firstDay && first > lo) lo = first;
    if (ds === lastDay && last + 1 < hi) hi = last + 1;
    // Inconsistent times (the parser rejects them) must not lose an active day.
    if (hi <= lo) {
      lo = ds;
      hi = ds + DAY_MS;
    }
    out.push({ day, lo, hi });
  }
  return out;
}

export function activeIntervals(r: ActivityRow): Array<[number, number]> {
  return dayIntervals(r).map(({ lo, hi }) => [lo, hi]);
}

/** The active UTC days of a row that overlap [s, z). */
export function activeDaysIn(r: ActivityRow, s: number, z: number): string[] {
  return dayIntervals(r)
    .filter(({ lo, hi }) => lo < z && hi > s)
    .map(({ day }) => day);
}

/** Any activity in [s, z)? */
export function activeIn(r: ActivityRow, s: number, z: number): boolean {
  return dayIntervals(r).some(({ lo, hi }) => lo < z && hi > s);
}

/** Distinct rows active per bucket. */
class ActiveCounter {
  readonly counts: number[];
  private readonly stamp: number[];
  private row = 0;
  constructor(private readonly spans: readonly BucketSpan[]) {
    this.counts = spans.map(() => 0);
    this.stamp = spans.map(() => -1);
  }
  add(r: ActivityRow): void {
    const id = this.row++;
    for (const [lo, hi] of activeIntervals(r)) {
      for (let i = firstEndingAfter(this.spans, lo); i < this.spans.length && this.spans[i]!.start < hi; i++) {
        if (this.stamp[i] !== id) {
          this.stamp[i] = id;
          this.counts[i]!++;
        }
      }
    }
  }
}

// ── mixes ────────────────────────────────────────────────────────────────────
export interface MixRow {
  key: string;
  /** New installs in the window. */
  new: number;
  /** Installs active in the last 7 days. */
  active: number;
}

export interface Mixes {
  new_total: number;
  active_total: number;
  /** New: version first installed; active: version last reported. */
  version: MixRow[];
  osarch: MixRow[];
  deployment: MixRow[];
  country: MixRow[];
}

export const UNKNOWN_KEY = '(unknown)';
export const OTHER_KEY = '(other)';
const MIX_LIMIT = 10;

function mixDim(newKeys: Array<string | null>, activeKeys: Array<string | null>, limit = MIX_LIMIT): MixRow[] {
  const m = new Map<string, MixRow>();
  const row = (k: string | null) => {
    const key = k ? k : UNKNOWN_KEY;
    let r = m.get(key);
    if (!r) m.set(key, (r = { key, new: 0, active: 0 }));
    return r;
  };
  for (const k of newKeys) row(k).new++;
  for (const k of activeKeys) row(k).active++;
  const rows = [...m.values()].sort((a, b) => b.new + b.active - (a.new + a.active) || b.new - a.new || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (rows.length <= limit) return rows;
  const head = rows.slice(0, limit - 1);
  const rest = rows.slice(limit - 1);
  return [...head, { key: OTHER_KEY, new: rest.reduce((a, r) => a + r.new, 0), active: rest.reduce((a, r) => a + r.active, 0) }];
}

const osArch = (r: { os: string | null; arch: string | null }) => (r.os || r.arch ? `${r.os || '?'}/${r.arch || '?'}` : null);

export function buildMixes(newRows: readonly InstallationRow[], activeRows: readonly InstallationRow[]): Mixes {
  return {
    new_total: newRows.length,
    active_total: activeRows.length,
    version: mixDim(newRows.map((r) => r.first_version ?? r.version), activeRows.map((r) => r.version ?? r.first_version)),
    osarch: mixDim(newRows.map(osArch), activeRows.map(osArch)),
    deployment: mixDim(newRows.map((r) => r.deployment), activeRows.map((r) => r.deployment)),
    country: mixDim(newRows.map((r) => r.country), activeRows.map((r) => r.country)),
  };
}

// ── GitHub downloads ─────────────────────────────────────────────────────────
export interface DownloadPoint {
  date: string;
  fetched_at: string;
  archives: number;
  /** Growth since the previous snapshot; null for the baseline (first snapshot). */
  delta: number | null;
  baseline: boolean;
  /** The counter went down (e.g. a release asset was removed); counted as 0. */
  adjusted: boolean;
  /** Days since the previous snapshot (≈ 1); null for the baseline. */
  span_days: number | null;
  /** More than 36 h since the previous snapshot (missed refreshes): the delta covers several days. */
  gap: boolean;
}

const GAP_MS = 36 * 3600_000;

export interface DownloadsReport {
  snapshots: number;
  /** The first snapshot overall: cumulative counters when tracking started. */
  baseline: { date: string; archives: number; in_window: boolean } | null;
  /** Archive downloads in the window: sum of the deltas whose interval middle is in it. */
  window_total: number;
  /** Snapshots in the window that carry a delta. */
  window_deltas: number;
  latest: SnapshotRow | null;
  /** Window deltas per platform, with the latest cumulative count. */
  by_platform: Array<{ platform: string; downloads: number; total: number }>;
  /** Snapshots counted in the window (by the middle of their interval), oldest first. */
  points: DownloadPoint[];
  adjusted: number;
  /** Window deltas that cover more than 36 h (missed refreshes). */
  gaps: number;
}

const byDate = (a: SnapshotRow, b: SnapshotRow) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

/**
 * Every snapshot with its delta. `t` is when its downloads count: the middle of
 * the interval since the previous snapshot (the fetch time for the baseline).
 */
function allPoints(snapshots: readonly SnapshotRow[]): Array<DownloadPoint & { t: number; snap: SnapshotRow; prev: SnapshotRow | null }> {
  const snaps = [...snapshots].sort(byDate);
  return snaps.map((s, k) => {
    const prev = k > 0 ? snaps[k - 1]! : null;
    const raw = prev ? s.archives - prev.archives : null;
    const at = ms(s.fetched_at);
    const span = prev ? at - ms(prev.fetched_at) : null;
    return {
      date: s.date,
      fetched_at: s.fetched_at,
      archives: s.archives,
      delta: raw === null ? null : Math.max(0, raw),
      baseline: !prev,
      adjusted: raw !== null && raw < 0,
      span_days: span === null ? null : Math.round((span / DAY_MS) * 10) / 10,
      gap: span !== null && span > GAP_MS,
      t: span === null ? at : at - span / 2,
      snap: s,
      prev,
    };
  });
}

export function buildDownloadsReport(snapshots: readonly SnapshotRow[], win: { start: number; end: number }): DownloadsReport {
  const pts = allPoints(snapshots);
  const inWin = pts.filter((p) => p.t >= win.start && p.t < win.end);
  const plat = new Map<string, number>();
  let total = 0;
  let deltas = 0;
  let adjusted = 0;
  let gaps = 0;
  for (const p of inWin) {
    if (p.delta === null || !p.prev) continue;
    total += p.delta;
    deltas++;
    if (p.adjusted) adjusted++;
    if (p.gap) gaps++;
    const keys = new Set([...Object.keys(p.snap.by_platform), ...Object.keys(p.prev.by_platform)]);
    for (const k of keys) {
      const d = Math.max(0, (p.snap.by_platform[k] ?? 0) - (p.prev.by_platform[k] ?? 0));
      plat.set(k, (plat.get(k) ?? 0) + d);
    }
  }
  const latest = pts.length ? pts[pts.length - 1]!.snap : null;
  const first = pts[0];
  const platforms = new Set([...plat.keys(), ...Object.keys(latest?.by_platform ?? {})]);
  return {
    snapshots: pts.length,
    baseline: first ? { date: first.date, archives: first.archives, in_window: first.t >= win.start && first.t < win.end } : null,
    window_total: total,
    window_deltas: deltas,
    latest,
    by_platform: [...platforms]
      .map((platform) => ({ platform, downloads: plat.get(platform) ?? 0, total: latest?.by_platform[platform] ?? 0 }))
      .sort((a, b) => b.downloads - a.downloads || b.total - a.total || (a.platform < b.platform ? -1 : 1)),
    points: inWin.map(({ date, fetched_at, archives, delta, baseline, adjusted: adj, span_days, gap }) => ({ date, fetched_at, archives, delta, baseline, adjusted: adj, span_days, gap })),
    adjusted,
    gaps,
  };
}

// ── the report ───────────────────────────────────────────────────────────────
export interface BucketRow extends BucketSpan {
  new_installs: number;
  new_people: number;
  active_installs: number;
  active_people: number;
  /** Ids of these classes first seen in the bucket (not in the external counts). */
  ci_ids: number;
  internal_ids: number;
  partner_ids: number;
  /** Partner installs with activity in the bucket. */
  partner_active: number;
  /** ci + internal + partner ids first seen in the bucket (the extra series when show=all). */
  other_new: number;
  /** GitHub archive downloads (snapshot deltas whose interval middle is in the bucket); null = none. */
  downloads: number | null;
  /** The baseline snapshot falls in this bucket. */
  downloads_baseline: boolean;
}

export interface RecentInstall {
  id: string;
  first_seen: string;
  last_seen: string;
  class: InstallClass;
  reason: string | null;
  country: string | null;
  net: string | null;
  deployment: string | null;
  os: string | null;
  arch: string | null;
  version: string | null;
  events_total: number;
  active_days: number;
  /** First 8 hex chars of the person id. */
  person: string | null;
}

export interface InstallsReport {
  window: ReportWindow & { granularity: Granularity; show: ShowMode };
  /** Headline numbers — always the external definitions. */
  totals: {
    new_installs: number;
    new_people: number;
    active_installs_7d: number;
    active_people_7d: number;
    active_installs_window: number;
    active_people_window: number;
    ci_ids: number;
    internal_ids: number;
    partner_ids: number;
    partner_active_ids: number;
    partner_active_days: number;
    partner_last_seen: string | null;
  };
  all_time: { installations: number; external: number; people: number };
  buckets: BucketRow[];
  /** Over the classes selected by `show`. */
  mixes: Mixes;
  recent: RecentInstall[];
  /** New installs in the window before the RECENT_LIMIT cap. */
  recent_total: number;
  downloads: DownloadsReport;
  has_rows: boolean;
}

export interface ReportOptions {
  now: number | Date;
  range: RangeKey;
  granularity: Granularity;
  show?: ShowMode;
}

/** "a.b.c" → "a.b.c.0/24"; IPv6 /40 as is; null → null. */
export function displayNet(net: string | null): string | null {
  if (!net) return null;
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(net) ? `${net}.0/24` : net;
}

const shortPerson = (p: string | null) => (p ? p.slice(2, 10) : null);
const eventsTotal = (r: InstallationRow) => Object.values(r.events).reduce((a, n) => a + n, 0);

export function buildInstallsReport(data: InstallsData, opts: ReportOptions): InstallsReport {
  const now = typeof opts.now === 'number' ? opts.now : opts.now.getTime();
  const show: ShowMode = opts.show ?? 'external';
  const win = reportWindow(data, opts.range, now);
  const spans = bucketSpans(win, opts.granularity);
  const inWin = (t: number) => t >= win.start && t < win.end;
  const since7 = now - WEEK_MS;
  const shown = (c: InstallClass) => show === 'all' || c === 'external';

  const n = spans.length;
  const zeros = () => new Array<number>(n).fill(0);
  const newInstalls = zeros();
  const newPeople = zeros();
  const ci = zeros();
  const internal = zeros();
  const partner = zeros();
  const activeInstalls = new ActiveCounter(spans);
  const activePeople = new ActiveCounter(spans);
  const activePartner = new ActiveCounter(spans);

  const totals: InstallsReport['totals'] = {
    new_installs: 0, new_people: 0, active_installs_7d: 0, active_people_7d: 0, active_installs_window: 0, active_people_window: 0,
    ci_ids: 0, internal_ids: 0, partner_ids: 0, partner_active_ids: 0, partner_active_days: 0, partner_last_seen: null,
  };
  const newShown: InstallationRow[] = [];
  const activeShown: InstallationRow[] = [];
  const partnerDays = new Set<string>();

  for (const r of data.installations) {
    const first = ms(r.first_seen);
    const isNew = Number.isFinite(first) && inWin(first);
    const b = isNew ? bucketOf(spans, first) : -1;
    const active7 = ms(r.last_seen) >= since7;
    if (shown(r.class)) {
      if (isNew) newShown.push(r);
      if (active7) activeShown.push(r);
    }
    if (r.class === 'external') {
      if (isNew) {
        totals.new_installs++;
        if (b >= 0) newInstalls[b]!++;
      }
      if (active7) totals.active_installs_7d++;
      if (activeIn(r, win.start, win.end)) totals.active_installs_window++;
      activeInstalls.add(r);
    } else if (r.class === 'ci' || INTERNAL_CLASSES.has(r.class) || r.class === 'partner') {
      const arr = r.class === 'ci' ? ci : r.class === 'partner' ? partner : internal;
      if (isNew) {
        if (r.class === 'ci') totals.ci_ids++;
        else if (r.class === 'partner') totals.partner_ids++;
        else totals.internal_ids++;
        if (b >= 0) arr[b]!++;
      }
      if (r.class === 'partner') {
        activePartner.add(r);
        const days = activeDaysIn(r, win.start, win.end);
        if (days.length) totals.partner_active_ids++;
        for (const d of days) partnerDays.add(d);
        if (!totals.partner_last_seen || r.last_seen > totals.partner_last_seen) totals.partner_last_seen = r.last_seen;
      }
    }
  }
  totals.partner_active_days = partnerDays.size;

  for (const p of data.people) {
    const first = ms(p.first_seen);
    if (Number.isFinite(first) && inWin(first)) {
      totals.new_people++;
      const b = bucketOf(spans, first);
      if (b >= 0) newPeople[b]!++;
    }
    if (ms(p.last_seen) >= since7) totals.active_people_7d++;
    if (activeIn(p, win.start, win.end)) totals.active_people_window++;
    activePeople.add(p);
  }

  // GitHub downloads per bucket.
  const dl: Array<number | null> = spans.map(() => null);
  const dlBase = spans.map(() => false);
  for (const p of allPoints(data.snapshots)) {
    const b = bucketOf(spans, p.t);
    if (b < 0) continue;
    if (p.baseline) dlBase[b] = true;
    else dl[b] = (dl[b] ?? 0) + (p.delta ?? 0);
  }

  const buckets: BucketRow[] = spans.map((s, i) => ({
    ...s,
    new_installs: newInstalls[i]!,
    new_people: newPeople[i]!,
    active_installs: activeInstalls.counts[i]!,
    active_people: activePeople.counts[i]!,
    ci_ids: ci[i]!,
    internal_ids: internal[i]!,
    partner_ids: partner[i]!,
    partner_active: activePartner.counts[i]!,
    other_new: ci[i]! + internal[i]! + partner[i]!,
    downloads: dl[i]!,
    downloads_baseline: dlBase[i]!,
  }));

  const recentAll = newShown
    .slice()
    .sort((a, b) => (a.first_seen! < b.first_seen! ? 1 : a.first_seen! > b.first_seen! ? -1 : a.id < b.id ? -1 : 1));
  const recent: RecentInstall[] = recentAll.slice(0, RECENT_LIMIT).map((r) => ({
    id: r.id,
    first_seen: r.first_seen!,
    last_seen: r.last_seen,
    class: r.class,
    reason: r.reason,
    country: r.country,
    net: r.net,
    deployment: r.deployment,
    os: r.os,
    arch: r.arch,
    version: r.version,
    events_total: eventsTotal(r),
    active_days: r.active_days.length,
    person: shortPerson(r.person),
  }));

  return {
    window: { ...win, granularity: opts.granularity, show },
    totals,
    all_time: {
      installations: data.installations.length,
      external: data.installations.filter((r) => r.class === 'external').length,
      people: data.people.length,
    },
    buckets,
    mixes: buildMixes(newShown, activeShown),
    recent,
    recent_total: recentAll.length,
    downloads: buildDownloadsReport(data.snapshots, win),
    has_rows: data.installations.length + data.people.length > 0,
  };
}
