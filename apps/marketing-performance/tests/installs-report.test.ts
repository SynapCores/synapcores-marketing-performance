import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDownloadsFeed, parseInstallsFeed, type InstallationRow, type SnapshotRow } from '../src/lib/installs/feed';
import {
  activeIn,
  activeIntervals,
  bucketSpans,
  buildDownloadsReport,
  buildInstallsReport,
  displayNet,
  parseGranularity,
  parseRange,
  parseShow,
  reportWindow,
  ALL_MAX_DAYS,
  type InstallsData,
} from '../src/lib/installs/report';

const FIX = join(__dirname, '..', '..', 'tests', 'fixtures');
const inst = parseInstallsFeed(readFileSync(join(FIX, 'installs-v1.sample.jsonl'), 'utf8'));
const dl = parseDownloadsFeed(readFileSync(join(FIX, 'github-downloads-v1.sample.jsonl'), 'utf8'));
if (!inst.ok || !dl.ok) throw new Error('fixtures must parse');
const DATA: InstallsData = { installations: inst.feed.installations, people: inst.feed.people, snapshots: dl.feed.snapshots };
const NOW = Date.parse('2026-11-22T02:00:00Z');
const T = (s: string) => Date.parse(s);
const id = (h: string) => 'i_' + h.repeat(16);

test('filters parse with safe defaults', () => {
  assert.equal(parseRange('90'), '90');
  assert.equal(parseRange('365'), '30');
  assert.equal(parseRange(undefined), '30');
  assert.equal(parseGranularity('day'), 'day');
  assert.equal(parseGranularity('month'), 'week');
  assert.equal(parseShow('all'), 'all');
  assert.equal(parseShow('ci'), 'external');
});

test('week buckets are rolling 7-day windows ending at now, oldest first; the first is partial', () => {
  const r = buildInstallsReport(DATA, { now: NOW, range: '30', granularity: 'week' });
  assert.equal(r.window.start, NOW - 30 * 86400_000);
  assert.deepEqual(r.buckets.map((b) => b.label), ['10-23→10-25', '10-25→11-01', '11-01→11-08', '11-08→11-15', '11-15→11-22']);
  assert.deepEqual(r.buckets.map((b) => b.partial), [true, false, false, false, false]);
  assert.equal(r.buckets[4]!.end, NOW);
  assert.equal(r.buckets[4]!.start, T('2026-11-15T02:00:00Z'));
  assert.equal(r.buckets[0]!.start, r.window.start);
  for (const b of r.buckets.slice(1)) assert.equal(b.end - b.start, 7 * 86400_000);
  // 7 days = exactly one full bucket; 90 days = 13 buckets, first partial (6 days).
  const w7 = bucketSpans({ start: NOW - 7 * 86400_000, end: NOW }, 'week');
  assert.deepEqual(w7.map((b) => [b.label, b.partial]), [['11-15→11-22', false]]);
  const w90 = bucketSpans({ start: NOW - 90 * 86400_000, end: NOW }, 'week');
  assert.equal(w90.length, 13);
  assert.equal(w90[0]!.partial, true);
  assert.equal(w90[0]!.end - w90[0]!.start, 6 * 86400_000);
});

test('new installs / new people: external first_seen and person first_seen in the bucket', () => {
  const r = buildInstallsReport(DATA, { now: NOW, range: '30', granularity: 'week' });
  assert.deepEqual(r.buckets.map((b) => b.new_installs), [0, 0, 0, 1, 2]); // a2 | a4 (11-15 03:00, after the boundary), a1
  assert.deepEqual(r.buckets.map((b) => b.new_people), [0, 0, 0, 1, 1]);
  assert.equal(r.totals.new_installs, 3); // a3 was first seen before the window
  assert.equal(r.totals.new_people, 2);
  // CI / internal / partner ids are counted on their own, never as installs.
  assert.deepEqual(r.buckets.map((b) => b.ci_ids), [0, 0, 0, 0, 1]);
  assert.deepEqual(r.buckets.map((b) => b.internal_ids), [0, 0, 0, 1, 1]); // internal 11-10, test 11-16
  assert.deepEqual(r.buckets.map((b) => b.partner_ids), [0, 0, 0, 0, 0]);
  assert.deepEqual(r.buckets.map((b) => b.other_new), [0, 0, 0, 1, 2]);
  assert.deepEqual({ ci: r.totals.ci_ids, internal: r.totals.internal_ids, partner: r.totals.partner_ids }, { ci: 1, internal: 2, partner: 0 });
});

test('active: any active day in the bucket, narrowed by first/last seen; last week = last 7 days', () => {
  const r = buildInstallsReport(DATA, { now: NOW, range: '30', granularity: 'week' });
  assert.deepEqual(r.buckets.map((b) => b.active_installs), [0, 0, 1, 1, 3]);
  assert.deepEqual(r.buckets.map((b) => b.active_people), [0, 0, 1, 1, 3]);
  assert.equal(r.totals.active_installs_7d, 3); // a1, a3, a4 — a2's last event was 11-15 01:00
  assert.equal(r.totals.active_people_7d, 3);
  assert.equal(r.buckets[4]!.active_installs, r.totals.active_installs_7d);
  assert.equal(r.buckets[4]!.active_people, r.totals.active_people_7d);
  assert.equal(r.totals.active_installs_window, 4);
  assert.deepEqual(r.buckets.map((b) => b.partner_active), [0, 0, 0, 0, 1]);
  assert.equal(r.totals.partner_active_ids, 1);
  assert.equal(r.totals.partner_active_days, 2);
  assert.equal(r.totals.partner_last_seen, '2026-11-18T12:00:00Z');
  // a2 was active on 11-15 only until 01:00 → not in the week starting 11-15 02:00.
  const a2 = DATA.installations.find((x) => x.id === id('a2'))!;
  assert.equal(activeIn(a2, T('2026-11-15T02:00:00Z'), NOW), false);
  assert.equal(activeIn(a2, T('2026-11-08T02:00:00Z'), T('2026-11-15T02:00:00Z')), true);
  assert.deepEqual(activeIntervals(a2), [
    [T('2026-11-14T12:00:00Z'), T('2026-11-15T00:00:00Z')],
    [T('2026-11-15T00:00:00Z'), T('2026-11-15T01:00:00Z') + 1],
  ]);
});

test('day buckets are UTC dates; the first and the current day are partial', () => {
  const r = buildInstallsReport(DATA, { now: NOW, range: '7', granularity: 'day' });
  assert.deepEqual(r.buckets.map((b) => b.label), ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
  assert.deepEqual(r.buckets.map((b) => b.partial), [true, false, false, false, false, false, false, true]);
  assert.equal(r.buckets[0]!.start, T('2026-11-15T02:00:00Z'));
  assert.equal(r.buckets[7]!.end, NOW);
  const by = Object.fromEntries(r.buckets.map((b) => [b.label, b]));
  assert.equal(by['2026-11-15']!.new_installs, 1); // a4
  assert.equal(by['2026-11-20']!.new_installs, 1); // a1
  assert.equal(by['2026-11-15']!.active_installs, 1); // a4 only: a2 stopped at 01:00, before the window
  assert.equal(by['2026-11-21']!.active_installs, 1); // a1
  assert.equal(by['2026-11-21']!.ci_ids, 1);
  assert.equal(r.buckets.reduce((a, b) => a + b.new_installs, 0), r.totals.new_installs);
});

test('"all" starts at the UTC day of the first row', () => {
  const w = reportWindow(DATA, 'all', NOW);
  assert.equal(w.start, T('2026-09-01T00:00:00Z')); // partner install, first seen 09-01
  assert.equal(w.days, 83); // 82 days + 2 h, rounded up
  const r = buildInstallsReport(DATA, { now: NOW, range: 'all', granularity: 'week' });
  assert.equal(r.buckets.length, 12);
  assert.equal(r.buckets[0]!.partial, true);
  assert.equal(r.totals.new_installs, 4);
  assert.equal(r.totals.partner_ids, 1);
  const empty = reportWindow({ installations: [], people: [], snapshots: [] }, 'all', NOW);
  assert.equal(empty.end - empty.start, 30 * 86400_000);
});

test('"all" goes back at most ALL_MAX_DAYS, and the buckets always add up to the totals', () => {
  const old: InstallationRow = { ...DATA.installations[0]!, id: id('0f'), first_seen: '2019-06-01T00:00:00Z', last_seen: '2019-06-01T01:00:00Z', active_days: ['2019-06-01'] };
  const data = { ...DATA, installations: [...DATA.installations, old] };
  for (const granularity of ['day', 'week'] as const) {
    const r = buildInstallsReport(data, { now: NOW, range: 'all', granularity });
    assert.equal(r.window.start, NOW - ALL_MAX_DAYS * 86400_000);
    assert.equal(r.buckets.at(-1)!.end, NOW); // the newest days are always there
    assert.equal(r.buckets[0]!.start, r.window.start);
    assert.equal(r.buckets.reduce((a, b) => a + b.new_installs, 0), r.totals.new_installs);
    assert.equal(r.totals.new_installs, 4); // the 2019 install is outside the window
  }
});

test('an inconsistent row still counts as active on its day', () => {
  const odd: InstallationRow = { ...DATA.installations[0]!, first_seen: '2026-11-21T10:00:00Z', last_seen: '2026-11-21T09:00:00Z', active_days: ['2026-11-21'] };
  assert.equal(activeIn(odd, T('2026-11-21T00:00:00Z'), T('2026-11-22T00:00:00Z')), true);
});

test('show=all adds the other classes to the tables, never to the headline totals', () => {
  const ext = buildInstallsReport(DATA, { now: NOW, range: '30', granularity: 'week', show: 'external' });
  const all = buildInstallsReport(DATA, { now: NOW, range: '30', granularity: 'week', show: 'all' });
  assert.deepEqual(ext.recent.map((x) => x.id), [id('a1'), id('a4'), id('a2')]); // newest first
  assert.deepEqual(all.recent.map((x) => x.id), [id('c1'), id('a1'), id('e1'), id('a4'), id('a2'), id('b1')]);
  assert.deepEqual(all.recent.map((x) => x.class), ['ci', 'external', 'test', 'external', 'external', 'internal']);
  assert.deepEqual(all.totals, ext.totals);
  assert.deepEqual(all.buckets, ext.buckets);
  assert.equal(ext.mixes.new_total, 3);
  assert.equal(all.mixes.new_total, 6);
  assert.equal(ext.recent_total, 3);
});

test('recent installs carry display fields; networks show as /24', () => {
  const r = buildInstallsReport(DATA, { now: NOW, range: '30', granularity: 'week' });
  const a1 = r.recent[0]!;
  assert.deepEqual(
    { first: a1.first_seen, events: a1.events_total, days: a1.active_days, person: a1.person, net: displayNet(a1.net), v: a1.version },
    { first: '2026-11-20T10:00:00Z', events: 6, days: 2, person: '01010101', net: '203.0.113.0/24', v: '2.5.1-ce' },
  );
  assert.equal(displayNet('2001:db8:1200::/40'), '2001:db8:1200::/40');
  assert.equal(displayNet(null), null);
});

test('mixes: new external installs in the window vs external installs active in the last 7 days', () => {
  const r = buildInstallsReport(DATA, { now: NOW, range: '30', granularity: 'week' });
  assert.equal(r.mixes.new_total, 3); // a1, a2, a4
  assert.equal(r.mixes.active_total, 3); // a1, a3, a4
  assert.deepEqual(r.mixes.version, [
    { key: '2.5.1-ce', new: 2, active: 3 },
    { key: '2.5.0-ce', new: 1, active: 0 },
  ]);
  assert.deepEqual(r.mixes.osarch.find((x) => x.key === 'linux/x86_64'), { key: 'linux/x86_64', new: 2, active: 1 });
  assert.deepEqual(r.mixes.country.map((x) => x.key), ['PL', 'US', 'DE']);
  assert.deepEqual(r.mixes.deployment.find((x) => x.key === 'bare-metal'), { key: 'bare-metal', new: 2, active: 2 });
});

test('GitHub downloads: deltas between consecutive snapshots; the first one is the baseline', () => {
  const r = buildInstallsReport(DATA, { now: NOW, range: '30', granularity: 'week' });
  const d = r.downloads;
  assert.equal(d.window_total, 112); // 30 + 30 + 52
  assert.equal(d.window_deltas, 3);
  assert.deepEqual(d.baseline, { date: '2026-11-18', archives: 700, in_window: true });
  assert.equal(d.latest!.archives, 812);
  assert.deepEqual(d.points.map((p) => [p.date, p.delta, p.baseline]), [
    ['2026-11-18', null, true],
    ['2026-11-19', 30, false],
    ['2026-11-20', 30, false],
    ['2026-11-21', 52, false],
  ]);
  assert.deepEqual(d.by_platform, [
    { platform: 'linux-x86_64', downloads: 80, total: 600 },
    { platform: 'darwin-aarch64', downloads: 20, total: 120 },
    { platform: 'linux-aarch64', downloads: 12, total: 92 },
  ]);
  assert.deepEqual(r.buckets.map((b) => b.downloads), [null, null, null, null, 112]);
  assert.deepEqual(r.buckets.map((b) => b.downloads_baseline), [false, false, false, false, true]);
  assert.equal(d.gaps, 0);
  assert.deepEqual(d.points.map((p) => p.span_days), [null, 1, 1, 1]);
  // Daily fetches at 01:50 UTC: each delta counts in the middle of its interval, i.e. on the previous UTC day.
  const days = buildInstallsReport(DATA, { now: NOW, range: '7', granularity: 'day' });
  const by = Object.fromEntries(days.buckets.map((b) => [b.label, [b.downloads, b.downloads_baseline]]));
  assert.deepEqual(by['2026-11-17'], [null, false]);
  assert.deepEqual(by['2026-11-18'], [30, true]); // baseline fetched 01:50 + the 11-18 → 11-19 growth
  assert.deepEqual(by['2026-11-19'], [30, false]);
  assert.deepEqual(by['2026-11-20'], [52, false]);
  assert.deepEqual(by['2026-11-21'], [null, false]);
  assert.equal(days.buckets.reduce((a, b) => a + (b.downloads ?? 0), 0), days.downloads.window_total);
});

test('GitHub downloads: a delta counts where the middle of its interval falls; drops count as 0', () => {
  const d = buildDownloadsReport(DATA.snapshots, { start: T('2026-11-18T12:00:00Z'), end: NOW });
  assert.equal(d.window_total, 112); // the first delta's middle (11-18 13:50) is inside
  assert.equal(d.baseline!.in_window, false);
  assert.deepEqual(d.points.map((p) => p.delta), [30, 30, 52]);
  const later = buildDownloadsReport(DATA.snapshots, { start: T('2026-11-19T00:00:00Z'), end: NOW });
  assert.equal(later.window_total, 82);
  const s = (date: string, archives: number): SnapshotRow => ({
    type: 'snapshot', date, fetched_at: `${date}T01:00:00Z`, archives, all_assets: archives, by_platform: { 'linux-x86_64': archives }, latest_release: null, latest_archives: null,
  });
  const drop = buildDownloadsReport([s('2026-11-03', 95), s('2026-11-01', 100), s('2026-11-02', 90)], { start: 0, end: NOW });
  assert.deepEqual(drop.points.map((p) => [p.date, p.delta, p.adjusted]), [
    ['2026-11-01', null, false],
    ['2026-11-02', 0, true],
    ['2026-11-03', 5, false],
  ]);
  assert.equal(drop.window_total, 5);
  assert.equal(drop.adjusted, 1);
  const none = buildDownloadsReport([], { start: 0, end: NOW });
  assert.deepEqual([none.baseline, none.latest, none.window_total], [null, null, 0]);
});

test('GitHub downloads: a gap of several days is flagged and lands mid-gap', () => {
  const s = (date: string, archives: number): SnapshotRow => ({
    type: 'snapshot', date, fetched_at: `${date}T01:50:00Z`, archives, all_assets: archives, by_platform: {}, latest_release: null, latest_archives: null,
  });
  const snaps = [s('2026-10-01', 100), s('2026-11-21', 500)];
  const week = buildDownloadsReport(snaps, { start: NOW - 7 * 86400_000, end: NOW });
  assert.deepEqual([week.window_total, week.gaps], [0, 0]); // 51 days of growth don't land in the last week
  const month = buildDownloadsReport(snaps, { start: NOW - 30 * 86400_000, end: NOW });
  assert.deepEqual([month.window_total, month.gaps, month.points.at(-1)!.span_days], [400, 1, 51]);
  assert.equal(month.points.at(-1)!.gap, true);
});
