import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatInZone, looksLikeTimestamp, parseUtc } from '../src/lib/timezone';

test('engine timestamps are read as UTC', () => {
  assert.equal(parseUtc('2026-11-18 19:01:40')!.toISOString(), '2026-11-18T19:01:40.000Z');
  assert.equal(parseUtc('2026-11-16T12:33:51.933897192+00:00')!.toISOString(), '2026-11-16T12:33:51.933Z');
  assert.equal(parseUtc('not a date'), null);
});

test('formats in the chosen zone, DST-aware', () => {
  const d = parseUtc('2026-11-18 19:01:40')!;
  assert.equal(formatInZone(d, 'UTC'), '2026-11-18 19:01:40 UTC');
  assert.equal(formatInZone(d, 'America/New_York'), '2026-11-18 14:01:40 EST');
  assert.equal(formatInZone(parseUtc('2026-07-01 12:00:00')!, 'America/New_York', { zoneName: false }), '2026-07-01 08:00:00');
  // crosses midnight → the local date changes too
  assert.equal(formatInZone(parseUtc('2026-11-19 02:30:00')!, 'America/Los_Angeles', { seconds: false }), '2026-11-18 18:30 PST');
});

test('timestamp detection for the table explorer', () => {
  assert.ok(looksLikeTimestamp('2026-11-18 19:01:40'));
  assert.ok(looksLikeTimestamp('2026-11-16T12:33:51.933897192+00:00'));
  assert.ok(!looksLikeTimestamp('2026-11-18'));
  assert.ok(!looksLikeTimestamp('fb_spring_sale'));
  assert.ok(!looksLikeTimestamp(42));
});

test('local day → UTC bounds for date filters (DST-aware)', () => {
  const { zonedDayStartUtc } = require('../src/lib/timezone') as typeof import('../src/lib/timezone');
  assert.equal(zonedDayStartUtc('2026-11-18', 'America/New_York'), '2026-11-18 05:00:00');
  assert.equal(zonedDayStartUtc('2026-11-18', 'America/New_York', 1), '2026-11-19 05:00:00');
  assert.equal(zonedDayStartUtc('2026-07-01', 'America/New_York'), '2026-07-01 04:00:00');
  assert.equal(zonedDayStartUtc('2026-11-01', 'America/New_York'), '2026-11-01 04:00:00'); // DST ends that day
  assert.equal(zonedDayStartUtc('2026-11-18', 'Asia/Kolkata'), '2026-11-17 18:30:00');
  assert.equal(zonedDayStartUtc('2026-11-18', 'UTC'), '2026-11-18 00:00:00');
  assert.equal(zonedDayStartUtc('2026-11-18', 'Not/AZone'), '2026-11-18 00:00:00');
  assert.equal(zonedDayStartUtc('nope', 'UTC'), null);
});
