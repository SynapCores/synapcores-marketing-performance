/**
 * Installs feed (v1): strict parser for the sanitized drop files written by the
 * telemetry export job, plus the pure import planner. Contract:
 * ops/installs-feed/FEED-FORMAT.md (installs-v1.jsonl, github-downloads-v1.jsonl).
 *
 * Pure — no fs, DB or Next — so it is unit-tested directly
 * (tests/installs-feed.test.ts). The fs + DB side is lib/installs-store.ts.
 *
 * The files are untrusted input, so parsing fails closed: the first problem
 * rejects the whole file and the importer keeps the rows it already has.
 *  - ≤ 8 MB, ≤ 20,000 lines, one JSON object per line, no blank lines, no key
 *    twice in one object, printable ASCII only
 *  - header on line 1 with the expected schema + version; `counts` must equal
 *    the number of lines of each type; installation lines before person lines
 *  - every known field is type-checked: ids `i_` / `p_` + 32 lowercase hex,
 *    enums, UTC timestamps (YYYY-MM-DDTHH:MM:SSZ) and dates between 2024-01-01
 *    and a day after the header's generated_at, networks only as an IPv4 /24
 *    (three octets) or an IPv6 /40 (`a:b:c::/40`; never 6to4 `2002::/16`, whose
 *    /48 is a whole IPv4 address), short strings ≤ 40 chars of
 *    [A-Za-z0-9._+ -], whole-number counts ≥ 0 (< 2^24 in the installs file,
 *    so one count can't hold an IPv4 address), ≤ 400 active days
 *  - rules that tie fields together: class external ⇔ no reason ⇔ a person id,
 *    and that person has a person line with at least that many installs;
 *    first_seen ≤ last_seen; active_days end on the last_seen date (and start
 *    on / before the first_seen date); a snapshot's date is its fetch date
 *  - defense in depth: any key or string anywhere — known fields, unknown
 *    fields, the raw line — that looks like a full IP address rejects the
 *    file: four dotted numbers, an IPv6 address more specific than a /48, or a
 *    6to4 prefix
 *  - free-text values (version, deployment, os, arch, country: telemetry the
 *    export job passes through) that look like an IPv4 address written some
 *    other way (`ip-10-1-2-3`, `10 1 2 3`, `0xcb00710d`, …) are blanked to null
 *    and counted, so one odd client can't stop the import
 *  - unknown fields are dropped: rows are re-serialized from the known fields
 *    in a fixed key order, so the stored payload (and its hash) is canonical
 * Error messages name the line and the field, never the offending value.
 */
import { createHash } from 'node:crypto';

export const INSTALLS_FILE = 'installs-v1.jsonl';
export const DOWNLOADS_FILE = 'github-downloads-v1.jsonl';
export const INSTALLS_SCHEMA = 'synapcores-installs-feed';
export const DOWNLOADS_SCHEMA = 'synapcores-github-downloads';
export const MAX_FEED_BYTES = 8 * 1024 * 1024;
export const MAX_FEED_LINES = 20_000;
export const MAX_ACTIVE_DAYS = 400;
export const MAX_SNAPSHOTS = 400;
/** Counts in the installs file stay below 2^24, so one number can't hold a whole IPv4 address. */
export const MAX_COUNT = 0xffffff;
/** Timestamps and dates fall between this date and a day after the header's generated_at. */
export const MIN_FEED_DATE = '2024-01-01';
const MIN_FEED_MS = Date.parse(`${MIN_FEED_DATE}T00:00:00Z`);
const MAX_GENERATED_MS = Date.parse('2100-01-01T00:00:00Z');
const DAY_MS = 86_400_000;
const MAX_PLATFORMS = 64;
const MAX_DEPTH = 6;
/** Stored payloads are re-validated on read; anything this large is not ours. */
const MAX_STORED_PAYLOAD = 64 * 1024;

export const INSTALL_CLASSES = ['external', 'ci', 'internal', 'likely-internal', 'partner', 'test'] as const;
export type InstallClass = (typeof INSTALL_CLASSES)[number];
export const INSTALL_REASONS = [
  'ops-smoke', 'internal-list', 'likely-internal-list', 'partner-24', 'internal-later-event', 'nightly-ci', 'gh-actions-cidr', 'no-ip-nightly-docker',
] as const;
export type InstallReason = (typeof INSTALL_REASONS)[number];
export const EVENT_KEYS = ['installation_created', 'instance_started', 'installation_version_changed', 'installation_heartbeat', 'other'] as const;
export type InstallEvents = Record<(typeof EVENT_KEYS)[number], number>;

export interface InstallsHeader {
  type: 'header';
  schema: typeof INSTALLS_SCHEMA;
  version: 1;
  generated_at: string;
  source: { rows: number | null; installations: number | null; max_received_at: string | null };
  classifier: { name: string | null; rules: string | null; gh_ranges_fetched_at: string | null; azure_ranges_fetched_at: string | null };
  counts: { installation: number; person: number };
  salt_id: string;
}

export interface InstallationRow {
  type: 'installation';
  id: string;
  person: string | null;
  class: InstallClass;
  reason: InstallReason | null;
  /** First install signal (created / started / version changed / heartbeat); null when there was none. */
  first_seen: string | null;
  last_seen: string;
  events: InstallEvents;
  version: string | null;
  first_version: string | null;
  deployment: string | null;
  os: string | null;
  arch: string | null;
  country: string | null;
  net: string | null;
  active_days: string[];
  new_7d: boolean;
  active_7d: boolean;
}

export interface PersonRow {
  type: 'person';
  id: string;
  first_seen: string;
  last_seen: string;
  installs: number;
  country: string | null;
  net: string | null;
  deployment: string | null;
  os: string | null;
  arch: string | null;
  first_version: string | null;
  version: string | null;
  active_days: string[];
  returned: boolean;
}

export interface DownloadsHeader {
  type: 'header';
  schema: typeof DOWNLOADS_SCHEMA;
  version: 1;
  generated_at: string;
  repo: string;
  counts: { snapshot: number };
}

export interface SnapshotRow {
  type: 'snapshot';
  date: string;
  fetched_at: string;
  archives: number;
  all_assets: number;
  by_platform: Record<string, number>;
  latest_release: string | null;
  latest_archives: number | null;
}

export interface InstallsFeed {
  header: InstallsHeader;
  installations: InstallationRow[];
  people: PersonRow[];
}

export interface DownloadsFeed {
  header: DownloadsHeader;
  snapshots: SnapshotRow[];
}

export type ParseResult<T> =
  | { ok: true; feed: T; droppedFields: number; blankedValues: number }
  | { ok: false; error: string };

// ── validation primitives ────────────────────────────────────────────────────
export class FeedError extends Error {
  override name = 'FeedError';
}

function fail(line: number, what: string): never {
  throw new FeedError(line > 0 ? `line ${line}: ${what}` : what);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INSTALL_ID = /^i_[0-9a-f]{32}$/;
const PERSON_ID = /^p_[0-9a-f]{32}$/;
const SALT_ID = /^[0-9a-f]{8}$/;
const SHORT = /^[A-Za-z0-9._+ -]{0,40}$/;
const NET4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const NET6 = /^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){0,2}::\/40$/;
const PLATFORM = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export function isIsoTs(s: unknown): s is string {
  if (typeof s !== 'string' || !ISO_TS.test(s)) return false;
  const t = Date.parse(s);
  return Number.isFinite(t) && new Date(t).toISOString() === `${s.slice(0, 19)}.000Z`;
}

export function isUtcDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** IPv4 /24 as "a.b.c" or IPv6 /40 as "a:b:c::/40" — but not 6to4 (2002::/16), which embeds an IPv4 address. */
export function isNet(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (NET4.test(s)) return s.split('.').every((o) => Number(o) <= 255);
  return NET6.test(s) && !s.startsWith('2002:');
}

/** Four dotted numbers that aren't part of a longer number (so a calendar version like 2026.11.20.1 passes). */
const IPV4_DOTTED = /(?<![0-9])[0-9]{1,3}(?:\.[0-9]{1,3}){3}(?![0-9])/;
const HEX_COLON_RUN = /[0-9A-Fa-f:]+/g;

/**
 * True when `s` contains something that looks like a full IP address: four
 * dotted numbers, an IPv6 address more specific than a /48 (four or more
 * hextets, or a `::` with a group after it, e.g. `2001:db8::1`), or a 6to4
 * prefix `2002:AABB:CCDD…` (= the IPv4 address AA.BB.CC.DD). HH:MM:SS times
 * (three groups) and `a:b:c::/40` networks pass.
 */
export function looksLikeFullIp(s: string): boolean {
  if (IPV4_DOTTED.test(s)) return true;
  if (!s.includes(':')) return false;
  for (const m of s.matchAll(HEX_COLON_RUN)) {
    const run = m[0];
    const parts = run.split(':');
    if (parts.length < 2) continue; // no colon
    const groups = parts.filter(Boolean);
    if (parts[0] === '2002' && (groups.length >= 3 || (groups.length >= 2 && run.includes('::')))) return true;
    if (parts.length < 3) continue; // fewer than two colons
    const dbl = run.indexOf('::');
    if (dbl >= 0) {
      const before = run.slice(0, dbl).split(':').filter(Boolean);
      const after = run.slice(dbl + 2).split(':').filter(Boolean);
      if (after.length > 0 || before.length > 3) return true;
    } else if (groups.length >= 4) {
      return true;
    }
  }
  return false;
}

const LOOSE_QUAD = /(?<![0-9])([0-9]{1,3})[^0-9A-Za-z]{1,3}([0-9]{1,3})[^0-9A-Za-z]{1,3}([0-9]{1,3})[^0-9A-Za-z]{1,3}([0-9]{1,3})(?![0-9])/y;

/**
 * Looser test for free text: also true for an IPv4 address written with other
 * separators — four numbers ≤ 255 split by 1-3 non-alphanumeric characters
 * (`ip-10-1-2-3`, `10 1 2 3`, `203_0_113_7`, `1.2.3. 4`) — or as one 32-bit
 * number (`3405803789`, `0xcb00710d`). Versions like `2.4.4-ce` pass.
 */
export function looksLikeIpLoose(s: string): boolean {
  if (looksLikeFullIp(s)) return true;
  if (/^0x[0-9a-f]{8}$/i.test(s) || /^[0-9]{9,10}$/.test(s)) return true;
  for (let i = 0; i < s.length; i++) {
    LOOSE_QUAD.lastIndex = i;
    const m = LOOSE_QUAD.exec(s);
    if (m && m.slice(1, 5).every((g) => Number(g) <= 255)) return true;
  }
  return false;
}

/** `what` is a fixed description or a known field name, never input. */
function scanString(v: string, line: number, what: string): void {
  if (!PRINTABLE_ASCII.test(v)) fail(line, `${what} contains non-ASCII or control characters`);
  if (looksLikeFullIp(v)) fail(line, `${what} looks like a full IP address (only /24 and IPv6 /40 networks are allowed)`);
}

function scanValue(v: unknown, depth: number, line: number, name: string): void {
  if (depth > MAX_DEPTH) fail(line, `${name} is nested too deeply`);
  if (typeof v === 'string') return scanString(v, line, name);
  if (Array.isArray(v)) {
    for (const x of v) scanValue(x, depth + 1, line, name);
    return;
  }
  if (isObj(v)) {
    for (const k of Object.keys(v)) {
      scanString(k, line, `a key in ${name}`);
      scanValue(v[k], depth + 1, line, name);
    }
  }
}

function scanLine(o: Obj, raw: string | null, line: number, known: ReadonlySet<string>): void {
  for (const k of Object.keys(o)) {
    const name = known.has(k) ? `field "${k}"` : 'an unknown field';
    scanString(k, line, known.has(k) ? name : 'an unknown field name');
    scanValue(o[k], 1, line, name);
  }
  // Belt and braces: \u escapes are decoded above and duplicate keys are rejected earlier.
  if (raw !== null && looksLikeFullIp(raw)) fail(line, 'the line contains text that looks like a full IP address');
}

/**
 * True when an object in the (already valid) JSON text has the same key twice.
 * JSON.parse silently keeps the last one; a strict reader refuses the ambiguity.
 */
export function hasDuplicateKeys(raw: string): boolean {
  const stack: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') j += raw[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && expectKey) {
        const key = JSON.parse(raw.slice(i, j + 1)) as string;
        if (top.has(key)) return true;
        top.add(key);
        expectKey = false;
      }
      i = j;
    } else if (ch === '{') {
      stack.push(new Set());
      expectKey = true;
    } else if (ch === '[') {
      stack.push(null);
      expectKey = false;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      expectKey = false;
    } else if (ch === ',') {
      expectKey = !!stack[stack.length - 1];
    }
  }
  return false;
}

/** Per-parse state: dropped unknown fields, blanked values, and the latest plausible time. */
interface Ctx {
  dropped: number;
  blanked: number;
  /** generated_at + 1 day once the header is read; no upper bound for stored rows. */
  maxMs: number;
}

const newCtx = (): Ctx => ({ dropped: 0, blanked: 0, maxMs: Number.POSITIVE_INFINITY });

function get(o: Obj, k: string, line: number, name = k): unknown {
  if (!own(o, k)) fail(line, `missing field "${name}"`);
  return o[k];
}
const getOpt = (o: Obj, k: string): unknown => (own(o, k) ? o[k] : null);

function text(v: unknown, re: RegExp, line: number, name: string): string {
  if (typeof v !== 'string' || !re.test(v)) fail(line, `field "${name}" is invalid`);
  return v;
}
const textOrNull = (v: unknown, re: RegExp, line: number, name: string): string | null => (v === null ? null : text(v, re, line, name));

/** Short free text: charset and length are checked; IP-like values are blanked (and counted). */
function short(v: unknown, line: number, name: string, c: Ctx): string | null {
  const s = textOrNull(v, SHORT, line, name);
  if (s !== null && looksLikeIpLoose(s)) {
    c.blanked++;
    return null;
  }
  return s;
}

function ts(v: unknown, line: number, name: string): string {
  if (!isIsoTs(v)) fail(line, `field "${name}" is not a UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)`);
  return v;
}
const tsOrNull = (v: unknown, line: number, name: string): string | null => (v === null ? null : ts(v, line, name));

function inWindow(t: number, line: number, name: string, c: Ctx): void {
  if (t < MIN_FEED_MS || t > c.maxMs) fail(line, `field "${name}" is not between ${MIN_FEED_DATE} and a day after generated_at`);
}

/** A timestamp in the plausible window. */
function tsIn(v: unknown, line: number, name: string, c: Ctx): string {
  const s = ts(v, line, name);
  inWindow(Date.parse(s), line, name, c);
  return s;
}
const tsInOrNull = (v: unknown, line: number, name: string, c: Ctx): string | null => (v === null ? null : tsIn(v, line, name, c));

function date(v: unknown, line: number, name: string): string {
  if (!isUtcDate(v)) fail(line, `field "${name}" is not a UTC date (YYYY-MM-DD)`);
  return v;
}
const dateOrNull = (v: unknown, line: number, name: string): string | null => (v === null ? null : date(v, line, name));

function dateIn(v: unknown, line: number, name: string, c: Ctx): string {
  const d = date(v, line, name);
  inWindow(Date.parse(`${d}T00:00:00Z`), line, name, c);
  return d;
}

function count(v: unknown, line: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) fail(line, `field "${name}" is not a whole number between 0 and ${max}`);
  return v;
}
const countOrNull = (v: unknown, line: number, name: string, max?: number): number | null => (v === null ? null : count(v, line, name, max));

function bool(v: unknown, line: number, name: string): boolean {
  if (typeof v !== 'boolean') fail(line, `field "${name}" is not true/false`);
  return v;
}

function obj(v: unknown, line: number, name: string): Obj {
  if (!isObj(v)) fail(line, `field "${name}" is not an object`);
  return v;
}

function net(v: unknown, line: number, name = 'net'): string | null {
  if (v === null) return null;
  if (!isNet(v)) fail(line, `field "${name}" is not an IPv4 /24 (a.b.c) or IPv6 /40 (a:b:c::/40) network`);
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], line: number, name: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) fail(line, `field "${name}" is not one of the known values`);
  return v as T;
}

function dayList(v: unknown, line: number, name: string): string[] {
  if (!Array.isArray(v)) fail(line, `field "${name}" is not a list`);
  if (v.length > MAX_ACTIVE_DAYS) fail(line, `field "${name}" has more than ${MAX_ACTIVE_DAYS} dates`);
  const out: string[] = [];
  let prev = '';
  for (const d of v) {
    if (!isUtcDate(d)) fail(line, `field "${name}" has an entry that is not a UTC date`);
    if (d <= prev) fail(line, `field "${name}" is not in ascending order`);
    prev = d;
    out.push(d);
  }
  return out;
}

/** Counts unknown keys (dropped) of one object. */
function unknownKeys(o: Obj, known: ReadonlySet<string>): number {
  let n = 0;
  for (const k of Object.keys(o)) if (!known.has(k)) n++;
  return n;
}

// ── record validators (fixed key order = canonical payload) ─────────────────
const KNOWN = {
  installsHeader: new Set(['type', 'schema', 'version', 'generated_at', 'source', 'classifier', 'counts', 'salt_id']),
  source: new Set(['rows', 'installations', 'max_received_at']),
  classifier: new Set(['name', 'rules', 'gh_ranges_fetched_at', 'azure_ranges_fetched_at']),
  installsCounts: new Set(['installation', 'person']),
  installation: new Set([
    'type', 'id', 'person', 'class', 'reason', 'first_seen', 'last_seen', 'events', 'version', 'first_version',
    'deployment', 'os', 'arch', 'country', 'net', 'active_days', 'new_7d', 'active_7d',
  ]),
  events: new Set<string>(EVENT_KEYS),
  person: new Set([
    'type', 'id', 'first_seen', 'last_seen', 'installs', 'country', 'net', 'deployment', 'os', 'arch',
    'first_version', 'version', 'active_days', 'returned',
  ]),
  downloadsHeader: new Set(['type', 'schema', 'version', 'generated_at', 'repo', 'counts']),
  downloadsCounts: new Set(['snapshot']),
  snapshot: new Set(['type', 'date', 'fetched_at', 'archives', 'all_assets', 'by_platform', 'latest_release', 'latest_archives']),
} as const;

/** generated_at, which also sets the latest plausible time for the rest of the file. */
function generatedAt(o: Obj, line: number, c: Ctx): string {
  const g = ts(get(o, 'generated_at', line), line, 'generated_at');
  const t = Date.parse(g);
  if (t < MIN_FEED_MS || t >= MAX_GENERATED_MS) fail(line, `field "generated_at" is not between ${MIN_FEED_DATE} and 2100`);
  c.maxMs = t + DAY_MS;
  return g;
}

function installsHeader(o: Obj, line: number, c: Ctx): InstallsHeader {
  if (o.type !== 'header') fail(line, 'the first line must be the header');
  if (o.schema !== INSTALLS_SCHEMA) fail(line, `header field "schema" is not ${INSTALLS_SCHEMA}`);
  if (o.version !== 1) fail(line, 'header field "version" is not 1');
  const src = obj(get(o, 'source', line), line, 'source');
  const cl = obj(get(o, 'classifier', line), line, 'classifier');
  const n = obj(get(o, 'counts', line), line, 'counts');
  c.dropped += unknownKeys(o, KNOWN.installsHeader) + unknownKeys(src, KNOWN.source) + unknownKeys(cl, KNOWN.classifier) + unknownKeys(n, KNOWN.installsCounts);
  const generated_at = generatedAt(o, line, c);
  return {
    type: 'header',
    schema: INSTALLS_SCHEMA,
    version: 1,
    generated_at,
    source: {
      rows: countOrNull(getOpt(src, 'rows'), line, 'source.rows', MAX_COUNT),
      installations: countOrNull(getOpt(src, 'installations'), line, 'source.installations', MAX_COUNT),
      max_received_at: tsInOrNull(getOpt(src, 'max_received_at'), line, 'source.max_received_at', c),
    },
    classifier: {
      name: short(getOpt(cl, 'name'), line, 'classifier.name', c),
      rules: dateOrNull(getOpt(cl, 'rules'), line, 'classifier.rules'),
      gh_ranges_fetched_at: tsOrNull(getOpt(cl, 'gh_ranges_fetched_at'), line, 'classifier.gh_ranges_fetched_at'),
      azure_ranges_fetched_at: tsOrNull(getOpt(cl, 'azure_ranges_fetched_at'), line, 'classifier.azure_ranges_fetched_at'),
    },
    counts: {
      installation: count(get(n, 'installation', line, 'counts.installation'), line, 'counts.installation', MAX_FEED_LINES),
      person: count(get(n, 'person', line, 'counts.person'), line, 'counts.person', MAX_FEED_LINES),
    },
    salt_id: text(get(o, 'salt_id', line), SALT_ID, line, 'salt_id'),
  };
}

/** first_seen ≤ last_seen, and active_days end on the last_seen date (and start where first_seen says). */
function checkActivity(r: InstallationRow | PersonRow, line: number): void {
  if (r.first_seen !== null && r.first_seen > r.last_seen) fail(line, 'field "first_seen" is later than "last_seen"');
  const days = r.active_days;
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) fail(line, 'field "active_days" is empty');
  if (first < MIN_FEED_DATE) fail(line, `field "active_days" has a date before ${MIN_FEED_DATE}`);
  if (last !== r.last_seen.slice(0, 10)) fail(line, 'field "active_days" does not end on the date of "last_seen"');
  if (r.first_seen === null) return;
  const firstDay = r.first_seen.slice(0, 10);
  const cut = days.length >= MAX_ACTIVE_DAYS; // the export keeps the last 400 days only
  if (r.type === 'person') {
    // A person's first_seen is the first event of any member.
    if (cut ? first < firstDay : first !== firstDay) fail(line, 'field "active_days" does not start on the date of "first_seen"');
  } else if (!cut && first > firstDay) {
    // An installation's first_seen is its first install signal; other events may come before it, not after.
    fail(line, 'field "active_days" starts after the date of "first_seen"');
  }
}

function installation(o: Obj, line: number, c: Ctx): InstallationRow {
  const ev = obj(get(o, 'events', line), line, 'events');
  c.dropped += unknownKeys(o, KNOWN.installation) + unknownKeys(ev, KNOWN.events);
  const events = {} as InstallEvents;
  for (const k of EVENT_KEYS) events[k] = count(get(ev, k, line, `events.${k}`), line, `events.${k}`, MAX_COUNT);
  const reason = get(o, 'reason', line);
  const r: InstallationRow = {
    type: 'installation',
    id: text(get(o, 'id', line), INSTALL_ID, line, 'id'),
    person: textOrNull(get(o, 'person', line), PERSON_ID, line, 'person'),
    class: oneOf(get(o, 'class', line), INSTALL_CLASSES, line, 'class'),
    reason: reason === null ? null : oneOf(reason, INSTALL_REASONS, line, 'reason'),
    first_seen: tsInOrNull(get(o, 'first_seen', line), line, 'first_seen', c),
    last_seen: tsIn(get(o, 'last_seen', line), line, 'last_seen', c),
    events,
    version: short(get(o, 'version', line), line, 'version', c),
    first_version: short(get(o, 'first_version', line), line, 'first_version', c),
    deployment: short(get(o, 'deployment', line), line, 'deployment', c),
    os: short(get(o, 'os', line), line, 'os', c),
    arch: short(get(o, 'arch', line), line, 'arch', c),
    country: short(get(o, 'country', line), line, 'country', c),
    net: net(get(o, 'net', line), line),
    active_days: dayList(get(o, 'active_days', line), line, 'active_days'),
    new_7d: bool(get(o, 'new_7d', line), line, 'new_7d'),
    active_7d: bool(get(o, 'active_7d', line), line, 'active_7d'),
  };
  // FEED-FORMAT: reason is null for external (only); person is set for external (only).
  if (r.class === 'external') {
    if (r.reason !== null) fail(line, 'field "reason" must be null for class external');
    if (r.person === null) fail(line, 'field "person" is required for class external');
  } else {
    if (r.reason === null) fail(line, 'field "reason" is required unless class is external');
    if (r.person !== null) fail(line, 'field "person" must be null unless class is external');
  }
  checkActivity(r, line);
  return r;
}

function person(o: Obj, line: number, c: Ctx): PersonRow {
  c.dropped += unknownKeys(o, KNOWN.person);
  const r: PersonRow = {
    type: 'person',
    id: text(get(o, 'id', line), PERSON_ID, line, 'id'),
    first_seen: tsIn(get(o, 'first_seen', line), line, 'first_seen', c),
    last_seen: tsIn(get(o, 'last_seen', line), line, 'last_seen', c),
    installs: count(get(o, 'installs', line), line, 'installs', MAX_COUNT),
    country: short(get(o, 'country', line), line, 'country', c),
    net: net(get(o, 'net', line), line),
    deployment: short(get(o, 'deployment', line), line, 'deployment', c),
    os: short(get(o, 'os', line), line, 'os', c),
    arch: short(get(o, 'arch', line), line, 'arch', c),
    first_version: short(get(o, 'first_version', line), line, 'first_version', c),
    version: short(get(o, 'version', line), line, 'version', c),
    active_days: dayList(get(o, 'active_days', line), line, 'active_days'),
    returned: bool(get(o, 'returned', line), line, 'returned'),
  };
  if (r.installs < 1) fail(line, 'field "installs" is 0');
  checkActivity(r, line);
  return r;
}

function downloadsHeader(o: Obj, line: number, c: Ctx): DownloadsHeader {
  if (o.type !== 'header') fail(line, 'the first line must be the header');
  if (o.schema !== DOWNLOADS_SCHEMA) fail(line, `header field "schema" is not ${DOWNLOADS_SCHEMA}`);
  if (o.version !== 1) fail(line, 'header field "version" is not 1');
  const n = obj(get(o, 'counts', line), line, 'counts');
  c.dropped += unknownKeys(o, KNOWN.downloadsHeader) + unknownKeys(n, KNOWN.downloadsCounts);
  return {
    type: 'header',
    schema: DOWNLOADS_SCHEMA,
    version: 1,
    generated_at: generatedAt(o, line, c),
    repo: text(get(o, 'repo', line), REPO, line, 'repo'),
    counts: { snapshot: count(get(n, 'snapshot', line, 'counts.snapshot'), line, 'counts.snapshot', MAX_FEED_LINES) },
  };
}

function platforms(v: unknown, line: number): Record<string, number> {
  const o = obj(v, line, 'by_platform');
  const keys = Object.keys(o);
  if (keys.length > MAX_PLATFORMS) fail(line, `field "by_platform" has more than ${MAX_PLATFORMS} platforms`);
  for (const k of keys) {
    if (!PLATFORM.test(k)) fail(line, 'field "by_platform" has an invalid platform name');
    count(o[k], line, 'by_platform');
  }
  // Sorted keys (canonical); fromEntries defines own properties, so no prototype games.
  return Object.fromEntries(keys.sort().map((k) => [k, o[k] as number]));
}

function snapshot(o: Obj, line: number, c: Ctx): SnapshotRow {
  c.dropped += unknownKeys(o, KNOWN.snapshot);
  const s: SnapshotRow = {
    type: 'snapshot',
    date: dateIn(get(o, 'date', line), line, 'date', c),
    fetched_at: tsIn(get(o, 'fetched_at', line), line, 'fetched_at', c),
    archives: count(get(o, 'archives', line), line, 'archives'),
    all_assets: count(get(o, 'all_assets', line), line, 'all_assets'),
    by_platform: platforms(get(o, 'by_platform', line), line),
    latest_release: short(get(o, 'latest_release', line), line, 'latest_release', c),
    latest_archives: countOrNull(get(o, 'latest_archives', line), line, 'latest_archives'),
  };
  if (s.fetched_at.slice(0, 10) !== s.date) fail(line, 'field "date" is not the date of "fetched_at"');
  return s;
}

// ── file parsers ─────────────────────────────────────────────────────────────
interface RawLine {
  line: number;
  raw: string;
  obj: Obj;
}

function splitLines(input: string): RawLine[] {
  if (typeof input !== 'string') fail(0, 'file is not text');
  if (input.length > MAX_FEED_BYTES || Buffer.byteLength(input, 'utf8') > MAX_FEED_BYTES) fail(0, `file is larger than ${MAX_FEED_BYTES / 1048576} MB`);
  // Split at most just past the cap, so a huge run of newlines can't build a huge array first.
  const parts = input.split('\n', MAX_FEED_LINES + 2);
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  if (!parts.length) fail(0, 'file is empty');
  if (parts.length > MAX_FEED_LINES) fail(0, `file has more than ${MAX_FEED_LINES} lines`);
  return parts.map((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) fail(line, 'blank line');
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      fail(line, 'not valid JSON'); // never the parser's message: it quotes the input
    }
    if (!isObj(v)) fail(line, 'not a JSON object');
    if (hasDuplicateKeys(raw)) fail(line, 'a key appears twice in one object');
    return { line, raw, obj: v };
  });
}

const NONE: ReadonlySet<string> = new Set<string>();

function knownFor(type: unknown, headerLine: boolean, downloads: boolean): ReadonlySet<string> {
  if (headerLine) return downloads ? KNOWN.downloadsHeader : KNOWN.installsHeader;
  if (downloads) return type === 'snapshot' ? KNOWN.snapshot : NONE;
  return type === 'installation' ? KNOWN.installation : type === 'person' ? KNOWN.person : NONE;
}

function run<T>(input: string, downloads: boolean, build: (lines: RawLine[], c: Ctx) => T): ParseResult<T> {
  try {
    const lines = splitLines(input);
    for (const l of lines) scanLine(l.obj, l.raw, l.line, knownFor(l.obj.type, l.line === 1, downloads));
    const c = newCtx();
    return { ok: true, feed: build(lines, c), droppedFields: c.dropped, blankedValues: c.blanked };
  } catch (e) {
    if (e instanceof FeedError) return { ok: false, error: e.message };
    return { ok: false, error: 'file could not be parsed' };
  }
}

/** Parse + validate installs-v1.jsonl. */
export function parseInstallsFeed(input: string): ParseResult<InstallsFeed> {
  return run(input, false, (lines, c) => {
    const [first, ...rest] = lines;
    if (!first) fail(0, 'file is empty');
    const header = installsHeader(first.obj, first.line, c);
    const installations: InstallationRow[] = [];
    const people: PersonRow[] = [];
    const instLines: number[] = [];
    const personLines: number[] = [];
    const ids = new Set<string>();
    for (const l of rest) {
      const type = l.obj.type;
      if (type === 'installation') {
        if (people.length) fail(l.line, 'installation line after the person lines');
        const r = installation(l.obj, l.line, c);
        if (ids.has(r.id)) fail(l.line, 'duplicate installation id');
        ids.add(r.id);
        installations.push(r);
        instLines.push(l.line);
      } else if (type === 'person') {
        const r = person(l.obj, l.line, c);
        if (ids.has(r.id)) fail(l.line, 'duplicate person id');
        ids.add(r.id);
        people.push(r);
        personLines.push(l.line);
      } else if (type === 'header') {
        fail(l.line, 'second header line');
      } else {
        fail(l.line, 'field "type" is not installation or person');
      }
    }
    if (header.counts.installation !== installations.length) fail(0, 'header counts.installation does not match the number of installation lines');
    if (header.counts.person !== people.length) fail(0, 'header counts.person does not match the number of person lines');
    // Every person an installation names has a person line, with at least that many installs.
    // (A person can have installs that aren't listed: ones without any install signal.)
    const refs = new Map<string, number>(people.map((p) => [p.id, 0]));
    installations.forEach((r, i) => {
      if (r.person === null) return;
      const n = refs.get(r.person);
      if (n === undefined) fail(instLines[i] ?? 0, 'field "person" names a person that has no person line');
      refs.set(r.person, n + 1);
    });
    people.forEach((p, i) => {
      if (p.installs < (refs.get(p.id) ?? 0)) fail(personLines[i] ?? 0, 'field "installs" is lower than the number of installation lines that name this person');
    });
    return { header, installations, people };
  });
}

/** Parse + validate github-downloads-v1.jsonl. */
export function parseDownloadsFeed(input: string): ParseResult<DownloadsFeed> {
  return run(input, true, (lines, c) => {
    const [first, ...rest] = lines;
    if (!first) fail(0, 'file is empty');
    const header = downloadsHeader(first.obj, first.line, c);
    const snapshots: SnapshotRow[] = [];
    for (const l of rest) {
      if (l.obj.type === 'header') fail(l.line, 'second header line');
      if (l.obj.type !== 'snapshot') fail(l.line, 'field "type" is not snapshot');
      const s = snapshot(l.obj, l.line, c);
      const prev = snapshots[snapshots.length - 1];
      if (prev && s.date <= prev.date) fail(l.line, 'snapshots are not in ascending date order (one per date)');
      snapshots.push(s);
    }
    if (snapshots.length > MAX_SNAPSHOTS) fail(0, `file has more than ${MAX_SNAPSHOTS} snapshots`);
    if (header.counts.snapshot !== snapshots.length) fail(0, 'header counts.snapshot does not match the number of snapshot lines');
    return { header, snapshots };
  });
}

// ── stored rows (re-validated on read) ───────────────────────────────────────
export type FeedRow = InstallationRow | PersonRow | SnapshotRow;

/** Parse a stored payload back into a row; null when it isn't a valid row of that type. */
export function parseStoredRow(recordType: string, payload: string): FeedRow | null {
  try {
    if (typeof payload !== 'string' || payload.length > MAX_STORED_PAYLOAD) return null;
    const v: unknown = JSON.parse(payload);
    if (!isObj(v) || v.type !== recordType || hasDuplicateKeys(payload)) return null;
    const c = newCtx();
    if (recordType === 'installation') {
      scanLine(v, payload, 0, KNOWN.installation);
      return installation(v, 0, c);
    }
    if (recordType === 'person') {
      scanLine(v, payload, 0, KNOWN.person);
      return person(v, 0, c);
    }
    if (recordType === 'snapshot') {
      scanLine(v, payload, 0, KNOWN.snapshot);
      return snapshot(v, 0, c);
    }
    return null;
  } catch {
    return null;
  }
}

// ── import planning ──────────────────────────────────────────────────────────
export type FeedKind = 'installs' | 'downloads';
export type RecordType = 'installation' | 'person' | 'snapshot';
export const INSTALLS_RECORD_TYPES: readonly RecordType[] = ['installation', 'person'];
export const DOWNLOADS_RECORD_TYPES: readonly RecordType[] = ['snapshot'];

/** One row to store: the canonical payload and its hash. */
export interface FeedRecord {
  record_type: RecordType;
  record_id: string;
  class: string | null;
  first_seen: string | null;
  last_seen: string | null;
  payload: string;
  row_hash: string;
}

export const rowId = (tenantId: string, recordType: string, recordId: string) => `${tenantId}:${recordType}:${recordId}`;
export const metaRowId = (tenantId: string, kind: FeedKind) => rowId(tenantId, 'meta', kind);
/** sha256(canonical payload), first 32 hex chars. */
export const rowHash = (payload: string) => createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);

function record(record_type: RecordType, record_id: string, cls: string | null, first: string | null, last: string | null, row: FeedRow): FeedRecord {
  const payload = JSON.stringify(row);
  return { record_type, record_id, class: cls, first_seen: first, last_seen: last, payload, row_hash: rowHash(payload) };
}

export function installsRecords(feed: InstallsFeed): FeedRecord[] {
  return [
    ...feed.installations.map((r) => record('installation', r.id, r.class, r.first_seen, r.last_seen, r)),
    ...feed.people.map((r) => record('person', r.id, null, r.first_seen, r.last_seen, r)),
  ];
}

/** Snapshots are keyed by their UTC date. */
export function downloadsRecords(feed: DownloadsFeed): FeedRecord[] {
  return feed.snapshots.map((s) => record('snapshot', s.date, null, `${s.date}T00:00:00Z`, s.fetched_at, s));
}

export interface ExistingRow {
  row_id: string;
  row_hash: string;
  record_type: string;
}

export interface PlannedRow extends FeedRecord {
  row_id: string;
}

export interface ImportPlan {
  insert: PlannedRow[];
  update: PlannedRow[];
  /** row_ids to delete. */
  delete: string[];
  unchanged: number;
  /** Set when the import must not be applied (nothing to write then). */
  refused?: string;
  /** Header salt_id differs from the stored one: every id changed (full re-key). */
  saltRotated: boolean;
}

export interface PlanOptions {
  tenantId: string;
  /** Record types this file owns; rows of other types are never touched. */
  recordTypes: readonly RecordType[];
  /** INSTALLS_FEED_MAX_DELETE_FRACTION; default 0.5. */
  maxDeleteFraction?: number;
  /** salt_id of the incoming header / of the last imported header (installs file). */
  saltId?: string | null;
  storedSaltId?: string | null;
}

export const DEFAULT_MAX_DELETE_FRACTION = 0.5;

/** INSTALLS_FEED_MAX_DELETE_FRACTION: a number in [0, 1]; anything else → 0.5. */
export function parseDeleteFraction(v: string | number | null | undefined): number {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return DEFAULT_MAX_DELETE_FRACTION;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_MAX_DELETE_FRACTION;
}

/** INSTALLS_FEED_IMPORT_MINUTES: whole minutes in [1, 1440]; default 5. */
export function importIntervalMinutes(v: string | null | undefined): number {
  const n = v == null || !v.trim() ? NaN : Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 1440 ? n : 5;
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/**
 * Diff the incoming rows of one file against the stored rows it owns (this
 * tenant's rows of the file's record types; anything else is ignored).
 * Rows missing from the file are deleted — unless the import would lose more
 * than max(10, maxDeleteFraction × stored rows), overall or of any one record
 * type, which smells like a broken export and is refused (nothing is written).
 * A salt rotation (header salt_id changed) re-keys every id, so all rows are
 * replaced; there the guard compares row counts instead: the new file may not
 * be shorter than an ordinary import could make it.
 */
export function planImport(existing: readonly ExistingRow[], incoming: readonly FeedRecord[], opts: PlanOptions): ImportPlan {
  const owned = new Set<string>(opts.recordTypes);
  const have = new Map<string, ExistingRow>();
  for (const e of existing) {
    if (owned.has(e.record_type) && e.row_id.startsWith(`${opts.tenantId}:${e.record_type}:`)) have.set(e.row_id, e);
  }
  const insert: PlannedRow[] = [];
  const update: PlannedRow[] = [];
  const seen = new Set<string>();
  const incomingBy = new Map<string, number>();
  let unchanged = 0;
  for (const r of incoming) {
    if (!owned.has(r.record_type)) throw new Error('planImport: incoming record type is not owned by this file');
    const id = rowId(opts.tenantId, r.record_type, r.record_id);
    if (seen.has(id)) throw new Error('planImport: duplicate incoming row');
    seen.add(id);
    bump(incomingBy, r.record_type);
    const e = have.get(id);
    if (!e) insert.push({ ...r, row_id: id });
    else if (e.row_hash !== r.row_hash) update.push({ ...r, row_id: id });
    else unchanged++;
  }
  const del: string[] = [];
  const haveBy = new Map<string, number>();
  const delBy = new Map<string, number>();
  for (const [id, e] of have) {
    bump(haveBy, e.record_type);
    if (!seen.has(id)) {
      del.push(id);
      bump(delBy, e.record_type);
    }
  }
  const saltRotated = !!opts.saltId && !!opts.storedSaltId && opts.saltId !== opts.storedSaltId;
  const frac = parseDeleteFraction(opts.maxDeleteFraction);
  const limit = (n: number) => Math.max(10, frac * n);
  // Rows lost: those missing from the file, or after a re-key the drop in row count.
  const lost = (stored: number, kept: number, deleted: number) => (saltRotated ? Math.max(0, stored - kept) : deleted);
  const checks: Array<[string, number, number]> = [['', have.size, lost(have.size, seen.size, del.length)]];
  for (const t of opts.recordTypes) checks.push([`${t} `, haveBy.get(t) ?? 0, lost(haveBy.get(t) ?? 0, incomingBy.get(t) ?? 0, delBy.get(t) ?? 0)]);
  for (const [what, stored, n] of checks) {
    if (n <= limit(stored)) continue;
    const why = saltRotated
      ? `salt rotation (full re-key) brings ${stored - n} ${what}rows for ${stored} stored, ${n} fewer`
      : `would delete ${n} of ${stored} stored ${what}rows`;
    return {
      insert: [],
      update: [],
      delete: [],
      unchanged: 0,
      saltRotated: false,
      refused: `${why} (limit ${Math.floor(limit(stored))}, INSTALLS_FEED_MAX_DELETE_FRACTION=${frac}; set it to 1 for one import if this is intended)`,
    };
  }
  return { insert, update, delete: del, unchanged, saltRotated };
}

// ── meta rows ────────────────────────────────────────────────────────────────
export interface FeedMeta<H = InstallsHeader | DownloadsHeader> {
  file: string;
  header: H;
  imported_at: string;
  file_sha256: string;
}

export function metaPayload(file: string, header: InstallsHeader | DownloadsHeader, importedAt: string, sha256: string): string {
  const m: FeedMeta = { file, header, imported_at: importedAt, file_sha256: sha256 };
  return JSON.stringify(m);
}

/** Parse a stored meta payload (header re-validated and scanned); null when invalid. */
export function parseStoredMeta(payload: string): FeedMeta | null {
  try {
    if (typeof payload !== 'string' || payload.length > MAX_STORED_PAYLOAD) return null;
    const v: unknown = JSON.parse(payload);
    if (!isObj(v) || !isObj(v.header) || hasDuplicateKeys(payload)) return null;
    const file = v.file === INSTALLS_FILE || v.file === DOWNLOADS_FILE ? v.file : null;
    if (!file || !isIsoTs(v.imported_at) || typeof v.file_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.file_sha256)) return null;
    const installs = file === INSTALLS_FILE;
    scanLine(v.header, null, 0, installs ? KNOWN.installsHeader : KNOWN.downloadsHeader);
    const c = newCtx();
    const header = installs ? installsHeader(v.header, 0, c) : downloadsHeader(v.header, 0, c);
    return { file, header, imported_at: v.imported_at, file_sha256: v.file_sha256 };
  } catch {
    return null;
  }
}

// ── import result + log line ─────────────────────────────────────────────────
export interface ImportResult {
  file: string;
  generated_at: string | null;
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
  /** Not read: missing, or size + mtime unchanged since the last import in this process. */
  skipped: boolean;
  /** Plan refused (mass delete); stored rows kept. */
  refused: string | null;
  /** File failed validation; stored rows kept. */
  rejected: string | null;
  salt_rotated: boolean;
  meta_updated: boolean;
  /** IP-like free-text values stored as null. */
  blanked: number;
}

export function emptyImportResult(file: string): ImportResult {
  return {
    file, generated_at: null, inserted: 0, updated: 0, deleted: 0, unchanged: 0, skipped: false, refused: null, rejected: null,
    salt_rotated: false, meta_updated: false, blanked: 0,
  };
}

/** The one log line for an import that changed rows or was refused; null otherwise. */
export function describeImport(r: ImportResult): string | null {
  const head = `[installs-feed] ${r.file} (generated ${r.generated_at ?? '?'})`;
  if (r.refused) return `${head}: refused, ${r.refused}; keeping the stored rows`;
  if (!r.inserted && !r.updated && !r.deleted) return null;
  const notes = [
    r.salt_rotated ? 'salt rotated: full re-key' : '',
    r.blanked ? `${r.blanked} IP-like free-text value${r.blanked === 1 ? '' : 's'} blanked` : '',
  ].filter(Boolean);
  return `${head}: +${r.inserted} ~${r.updated} -${r.deleted}, ${r.unchanged} unchanged${notes.length ? ` (${notes.join('; ')})` : ''}`;
}
