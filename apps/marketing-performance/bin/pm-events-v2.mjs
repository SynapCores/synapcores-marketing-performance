#!/usr/bin/env node
// pm_events / pm_events_v2 operations tool (PM_EVENTS_V2, release H). Plain Node, no dependencies.
//
//   node bin/pm-events-v2.mjs [--env /etc/mktperf/app.env] status
//   node bin/pm-events-v2.mjs [--env …] verify
//   node bin/pm-events-v2.mjs [--env …] reverse-copy [--apply] [--since 'YYYY-MM-DD HH:MM:SS'] [--force] [--pause-ms 3000]
//
// status        migration state, row counts and a column/type comparison of the two tables (read-only).
// verify        every pm_events row must be in pm_events_v2 exactly once with identical values. Differences only
//               in the columns the IP sweep / reclassify change (ip, ip_truncated, is_bot, bot_*, device_type)
//               are counted separately and don't fail. Also counts the v2-only rows (events after the cutover).
//               Read-only. Exit 1 on any mismatch.
// reverse-copy  ROLLBACK helper, run after PM_EVENTS_V2 was removed and the app restarted (it writes pm_events
//               again): copies the pm_events_v2 rows that pm_events lacks back into pm_events, verifies them by id,
//               then marks the state v1 so a later re-enable starts a fresh, id-checked copy. Dry run unless
//               --apply. Scans all of pm_events_v2 (id-checked, ~1 min at 40k rows) unless --since narrows it.
//               Refuses unless pm_events holds the newest row (the app demonstrably writes pm_events again) and
//               the newest pm_events_v2 row is >120 s old; --force skips both. Before marking v1 it re-reads
//               pm_events_v2 and the state; if anything changed during the copy it stops (exit 3) without
//               marking v1, so it can simply be run again.
//               Each INSERT into the indexed pm_events costs ~0.5 s and a memory spike on 2.5.1: rows go up to
//               500 per statement (and ~90 KB of SQL; the engine limit is ~100 KB), with --pause-ms (default
//               3000) between statements.
//
// Engine: SYNAPCORES_URL + SYNAPCORES_ADMIN_API_KEY from --env <file> (only those two keys are read, both
// required there), or from the environment without --env. Prints counts (and at most 5 event ids of
// mismatches), never row contents or secrets; engine error text is redacted.
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const COLUMNS = [
  'event_id', 'tenant_id', 'pixel_id', 'source_kind', 'anonymous_id', 'session_id',
  'occurred_at', 'received_at', 'event_type',
  'page_url', 'page_path', 'page_title', 'site', 'referrer', 'referrer_domain',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'ttclid', 'msclkid',
  'user_agent', 'browser', 'browser_version', 'os', 'os_version', 'device_type',
  'is_bot', 'bot_name', 'bot_category', 'bot_verified', 'bot_rules_version',
  'ip', 'ip_prefix', 'ip_truncated',
  'country', 'country_name', 'region', 'city', 'latitude', 'longitude', 'timezone',
  'language', 'screen_w', 'screen_h', 'viewport_w', 'viewport_h', 'properties',
];
/** Columns the IP sweep and the reclassify change in place (verify reports them apart). */
export const MUTABLE = ['ip', 'ip_truncated', 'is_bot', 'bot_name', 'bot_category', 'bot_verified', 'bot_rules_version', 'device_type'];
const OLD = 'pm_events';
const V2 = 'pm_events_v2';
const META = 'pm_events_meta';
const META_KEY = 'pm_events_store';
const TARGET_ROWS = 500;
const WINDOW_LIMIT = 2000;
const ID_CHUNK = 400;
const TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// ── pure helpers (exported for tests/events-v2.test.ts) ─────────────────────
export function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}

/** 'YYYY-MM-DD HH:MM:SS' (UTC) → epoch ms; null unless it is a real date in that exact shape. */
export function parseTs(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?$/.exec(s.trim());
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 19) === `${m[1]}T${m[2]}` ? t : null; // rejects 2026-02-30, 25:00
}
export const fmtTs = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19).replace('T', ' ');

/** The engine answers { data: { columns, rows, truncated, … }, meta }. */
export function parseReply(text) {
  const body = JSON.parse(text);
  const w = body && typeof body.data === 'object' && body.data !== null ? body.data : body;
  if (!w || !Array.isArray(w.rows) || !Array.isArray(w.columns)) throw new Error('engine reply has no columns/rows');
  const names = w.columns.map((c) => (typeof c === 'string' ? c : c.name));
  const rows = w.rows.map((r) => (Array.isArray(r) ? Object.fromEntries(names.map((n, i) => [n, r[i]])) : r));
  return { rows, columns: w.columns, truncated: w.truncated === true };
}

/** Engine error text without quoted literals or IP-like tokens (it can echo row values). */
export function redact(msg) {
  return String(msg)
    .replace(/'(?:[^']|'')*'/g, "'…'")
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => (m.length > 40 ? '"…"' : m))
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, '<ip>')
    .slice(0, 300);
}

/**
 * Row tuples packed into INSERT statements of at most maxRows rows and maxBytes of SQL (the INSERT head
 * included): the engine refuses statements over ~100 KB ("SQL query exceeds maximum length"), and on the
 * indexed pm_events every statement costs the same O(rows) spike whatever its size, so fewer, fuller
 * statements are better.
 */
export function packValues(rows, maxRows = 500, maxBytes = 90 * 1024) {
  const head = Buffer.byteLength(`INSERT INTO ${OLD} (${COLUMNS.join(',')}) VALUES `, 'utf8');
  const out = [];
  let cur = [];
  let size = head;
  for (const r of rows) {
    const t = '(' + COLUMNS.map((c) => lit(r[c])).join(',') + ')';
    const n = Buffer.byteLength(t, 'utf8') + 1;
    if (cur.length && (cur.length >= maxRows || size + n > maxBytes)) {
      out.push(cur);
      cur = [];
      size = head;
    }
    cur.push(t);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Strict argument parsing: known command and flags only. */
export function parseArgs(argv) {
  const out = { cmd: null, env: null, apply: false, force: false, since: null, pauseMs: 3000 };
  const takes = new Set(['--env', '--since', '--pause-ms']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (takes.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--env') out.env = v;
      else if (a === '--since') {
        if (!TS.test(v) || parseTs(v) == null) throw new Error("--since wants a real 'YYYY-MM-DD HH:MM:SS' (UTC)");
        out.since = v;
      } else {
        if (!/^\d+$/.test(v)) throw new Error('--pause-ms wants a whole number of milliseconds');
        out.pauseMs = Number(v);
      }
    } else if (a === '--apply') out.apply = true;
    else if (a === '--force') out.force = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (out.cmd == null) out.cmd = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!['status', 'verify', 'reverse-copy'].includes(out.cmd ?? '')) throw new Error('command must be status, verify or reverse-copy');
  if (out.cmd !== 'reverse-copy' && (out.apply || out.force || out.since)) throw new Error('--apply/--force/--since go with reverse-copy');
  return out;
}

/** Canonical row (all columns, or all but the mutable ones). */
export function canon(r, skip = []) {
  return JSON.stringify(COLUMNS.filter((c) => !skip.includes(c)).map((c) => (r[c] === undefined ? null : r[c])));
}

// ── engine ──────────────────────────────────────────────────────────────────
let CFG;
let ARGS;
function engineConfig() {
  let url;
  let key;
  if (ARGS.env) {
    for (const line of readFileSync(ARGS.env, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?(SYNAPCORES_URL|SYNAPCORES_ADMIN_API_KEY)\s*=\s*(.*?)\s*$/.exec(line.replace(/^﻿/, '').replace(/\r$/, ''));
      if (!m) continue;
      const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
      if (m[1] === 'SYNAPCORES_URL') url = v;
      else key = v;
    }
    if (!url || !key) throw new Error(`SYNAPCORES_URL and SYNAPCORES_ADMIN_API_KEY must both be set in ${ARGS.env}`);
  } else {
    url = process.env.SYNAPCORES_URL;
    key = process.env.SYNAPCORES_ADMIN_API_KEY;
    if (!url || !key) throw new Error('SYNAPCORES_URL and SYNAPCORES_ADMIN_API_KEY are required (environment or --env file)');
  }
  return { url: url.replace(/\/+$/, ''), key };
}

function sql(statement) {
  CFG ??= engineConfig();
  const u = new URL(CFG.url + '/v1/query/execute');
  const body = JSON.stringify({ sql: statement });
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${CFG.key}` },
      timeout: 300_000,
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        if (res.statusCode !== 200) {
          let msg = text;
          try { msg = JSON.parse(text)?.error?.message ?? msg; } catch { /* keep text */ }
          return reject(new Error(`engine HTTP ${res.statusCode}: ${redact(msg)}`));
        }
        try {
          resolve(parseReply(text));
        } catch (e) {
          reject(new Error(`engine reply: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('engine request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const COLS = COLUMNS.join(', ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function one(statement) {
  const r = await sql(statement);
  if (r.rows.length !== 1) throw new Error(`expected exactly one row from: ${statement.slice(0, 60)}…`);
  return r.rows[0];
}
async function count(statement) {
  const n = Number((await one(statement)).n);
  if (!Number.isFinite(n)) throw new Error(`no count from: ${statement.slice(0, 60)}…`);
  return n;
}
async function bounds(table) {
  const r = await one(`SELECT MIN(received_at) AS lo, MAX(received_at) AS hi, COUNT(*) AS n FROM ${table}`);
  const t = (v) => {
    if (v == null) return null;
    const ms = parseTs(v);
    if (ms == null) throw new Error(`unexpected timestamp shape from ${table}`);
    return fmtTs(ms);
  };
  const n = Number(r.n);
  if (!Number.isFinite(n)) throw new Error(`no count from ${table}`);
  return { lo: t(r.lo), hi: t(r.hi), n };
}
async function tableExists(table) {
  try {
    await sql(`SELECT COUNT(*) AS n FROM ${table} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}
async function readMeta() {
  if (!(await tableExists(META))) return { meta: null, exists: false, raw: [] };
  const r = await sql(`SELECT v FROM ${META} WHERE k = ${lit(META_KEY)}`);
  const order = ['v1', 'backfill', 'v2'];
  const raw = r.rows.map((x) => String(x.v));
  const metas = raw.map((v) => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
  metas.sort((a, b) => order.indexOf(b.state) - order.indexOf(a.state) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return { meta: metas[0] ?? null, exists: r.rows.length > 0, raw };
}

/**
 * Visit the rows of `table` received in [fromTs, end], window by window (adaptive, ~TARGET_ROWS rows),
 * then the rows with received_at IS NULL (paged by event_id). Every SELECT has an explicit LIMIT (the
 * engine cuts an unlimited SELECT at 1000 rows); a window that fills it is split and read again.
 */
async function forEachWindow(table, fromTs, visit) {
  const b = await bounds(table);
  if (b.hi != null && fromTs != null) {
    const end = parseTs(b.hi);
    let lo = parseTs(fromTs);
    if (lo == null || end == null) throw new Error('bad window bounds');
    let span = 3_600_000;
    while (lo <= end) {
      const hi = lo + span;
      const res = await sql(`SELECT ${COLS} FROM ${table} WHERE received_at >= '${fmtTs(lo)}' AND received_at < '${fmtTs(hi)}' LIMIT ${WINDOW_LIMIT}`);
      if (res.truncated || res.rows.length >= WINDOW_LIMIT) {
        if (span <= 1000) throw new Error(`more than ${WINDOW_LIMIT} rows received in one second at ${fmtTs(lo)}`);
        span = Math.max(1000, Math.floor(span / 2000) * 1000);
        continue;
      }
      await visit(res.rows, `${fmtTs(lo)}..${fmtTs(hi)}`);
      lo = hi;
      if (res.rows.length > 2 * TARGET_ROWS) span = Math.max(1000, Math.floor(span / 2000) * 1000);
      else if (res.rows.length < TARGET_ROWS / 4) span = Math.min(7 * 86_400_000, span * 2);
    }
  }
  let after = null;
  for (;;) {
    const page = (await sql(`SELECT ${COLS} FROM ${table} WHERE received_at IS NULL${after == null ? '' : ` AND event_id > ${lit(after)}`} ORDER BY event_id LIMIT ${WINDOW_LIMIT}`)).rows;
    if (page.length) await visit(page, 'received_at IS NULL');
    if (page.length < WINDOW_LIMIT) break;
    after = String(page[page.length - 1].event_id);
  }
  return b;
}

async function idsIn(table, ids, cols = 'event_id') {
  const out = [];
  for (const part of chunk(ids, ID_CHUNK)) {
    const r = await sql(`SELECT ${cols} FROM ${table} WHERE event_id IN (${part.map(lit).join(',')}) LIMIT ${part.length * 4}`);
    out.push(...r.rows);
  }
  return out;
}

// ── commands ────────────────────────────────────────────────────────────────
async function status() {
  const { meta } = await readMeta();
  const show = meta
    ? Object.fromEntries(['state', 'cutoverAt', 'watermark', 'nullsDone', 'checked', 'copied', 'passes', 'startedAt', 'finishedAt', 'oldSyncedTo', 'oldCount', 'rolledBackAt'].map((k) => [k, meta[k] ?? null]))
    : null;
  console.log('meta:', JSON.stringify(show));
  const types = {};
  for (const t of [OLD, V2]) {
    if (!(await tableExists(t))) { console.log(`${t}: (missing)`); continue; }
    const b = await bounds(t);
    console.log(`${t}: rows=${b.n} received ${b.lo ?? '-'} .. ${b.hi ?? '-'}`);
    const r = await sql(`SELECT * FROM ${t} LIMIT 1`);
    if (r.rows.length) types[t] = Object.fromEntries(r.columns.map((c) => [c.name, c.data_type]));
  }
  if (types[OLD] && types[V2]) {
    const diff = [...new Set([...Object.keys(types[OLD]), ...Object.keys(types[V2])])].filter((c) => types[OLD][c] !== types[V2][c]);
    console.log(`columns: ${Object.keys(types[OLD]).length} vs ${Object.keys(types[V2]).length}; name/type differences: ${diff.length ? diff.join(', ') : 'none'}`);
  }
  const cutMs = meta?.cutoverAt ? Date.parse(meta.cutoverAt) : NaN;
  if (Number.isFinite(cutMs) && (await tableExists(V2))) {
    const cut = fmtTs(cutMs);
    console.log(`${V2} rows received since the cutover (${cut}): ${await count(`SELECT COUNT(*) AS n FROM ${V2} WHERE received_at >= '${cut}'`)}`);
    console.log(`${OLD} rows received since the cutover: ${await count(`SELECT COUNT(*) AS n FROM ${OLD} WHERE received_at >= '${cut}'`)}`);
  } else if (meta?.cutoverAt) console.log('cutoverAt in pm_events_meta is not a valid time');
  return 0;
}

async function verify() {
  const t0 = Date.now();
  let windows = 0, oldRows = 0, ok = 0, mutableOnly = 0, missing = 0, dup = 0, diff = 0, matched = 0;
  const bad = [];
  const note = (s) => { if (bad.length < 5) bad.push(s); };
  const b = await bounds(OLD);
  await forEachWindow(OLD, b.lo, async (rows) => {
    windows++;
    oldRows += rows.length;
    const ids = rows.map((r) => String(r.event_id));
    const copies = new Map();
    for (const r of await idsIn(V2, ids, COLS)) {
      const k = String(r.event_id);
      copies.set(k, [...(copies.get(k) ?? []), r]);
    }
    for (const r of rows) {
      const c = copies.get(String(r.event_id)) ?? [];
      matched += c.length;
      if (c.length === 0) { missing++; note(`missing ${r.event_id}`); }
      else if (c.length > 1) { dup++; note(`duplicate ${r.event_id}`); }
      else if (canon(c[0]) === canon(r)) ok++;
      else if (canon(c[0], MUTABLE) === canon(r, MUTABLE)) mutableOnly++;
      else { diff++; note(`different ${r.event_id}`); }
    }
  });
  const v2n = (await bounds(V2)).n;
  console.log(`verify: ${OLD} rows ${oldRows} (count ${b.n}) in ${windows} windows: identical in ${V2} ${ok}, ` +
    `differing only in sweep/reclassify columns ${mutableOnly}, missing ${missing}, duplicated ${dup}, different ${diff}`);
  console.log(`verify: ${V2} rows ${v2n}; rows not from ${OLD} (written after the cutover) ${v2n - matched} (${Math.round((Date.now() - t0) / 1000)}s)`);
  if (bad.length) console.log('verify: first mismatches:', bad.join(', '));
  const good = missing === 0 && dup === 0 && diff === 0 && oldRows === b.n;
  console.log(good ? 'verify: OK' : 'verify: FAILED');
  return good ? 0 : 1;
}

async function v2Snapshot() {
  const b = await bounds(V2);
  return `${b.n}|${b.hi ?? '-'}`;
}

async function reverseCopy() {
  const { apply, force, since, pauseMs } = ARGS;
  if (!(await tableExists(V2))) { console.log(`${V2} does not exist: nothing to copy back`); return 0; }
  const { meta, exists, raw } = await readMeta();
  const v2b = await bounds(V2);
  const oldb = await bounds(OLD);
  const newest = parseTs(v2b.hi);
  if (!force) {
    if (newest != null && Date.now() - newest < 120_000) {
      console.log(`refusing: the newest ${V2} row is ${Math.round((Date.now() - newest) / 1000)}s old, so the app still writes ${V2}.`);
      console.log('Remove the PM_EVENTS_V2 drop-in, `systemctl daemon-reload`, restart mktperf-app, check `systemctl show mktperf-app -p Environment`, wait 2 minutes, then run this again (or pass --force).');
      return 2;
    }
    if (v2b.hi != null && !(oldb.hi != null && oldb.hi > v2b.hi)) {
      console.log(`refusing: ${OLD} has no row newer than ${V2}'s newest (${v2b.hi}), so nothing shows the app writes ${OLD} again.`);
      console.log('Wait for a beacon after the flag-off restart (or pass --force if the site is idle).');
      return 2;
    }
  }
  const from = since ?? v2b.lo;
  console.log(`reverse-copy (${apply ? 'APPLY' : 'dry run'}): ${V2} rows received since ${from ?? '-'} (+ any without received_at); state ${meta?.state ?? '-'}`);
  const before = await v2Snapshot();
  let windows = 0, scanned = 0, present = 0, copied = 0, toCopy = 0;
  await forEachWindow(V2, from, async (rows, label) => {
    windows++;
    scanned += rows.length;
    const ids = [...new Set(rows.map((r) => String(r.event_id)))];
    const inOld = new Set((await idsIn(OLD, ids)).map((r) => String(r.event_id)));
    const seen = new Set();
    const todo = rows.filter((r) => {
      const k = String(r.event_id);
      if (inOld.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    present += ids.length - todo.length;
    toCopy += todo.length;
    if (!apply || !todo.length) return;
    for (const values of packValues(todo)) {
      await sql(`INSERT INTO ${OLD} (${COLUMNS.join(',')}) VALUES ${values.join(',')}`);
      copied += values.length;
      if (pauseMs) await sleep(pauseMs);
    }
    const n = (await idsIn(OLD, ids)).length;
    if (n !== ids.length) throw new Error(`window ${label}: ${n} of ${ids.length} ids in ${OLD} after the copy`);
  });
  console.log(`reverse-copy: ${windows} windows, ${scanned} ${V2} rows scanned, ${present} already in ${OLD}, ${apply ? `${copied} copied and verified` : `${toCopy} would be copied`}`);
  // Everything in scope must have been scanned, and nothing may have changed meanwhile.
  const inScope = from == null ? 0 : await count(`SELECT COUNT(*) AS n FROM ${V2} WHERE received_at >= '${from}'`);
  const nulls = await count(`SELECT COUNT(*) AS n FROM ${V2} WHERE received_at IS NULL`);
  if (scanned !== inScope + nulls) {
    console.log(`stopping: scanned ${scanned} rows but ${inScope + nulls} are in scope; nothing marked. Run it again.`);
    return 3;
  }
  if (!apply) return 0;
  const after = await v2Snapshot();
  const metaNow = await readMeta();
  if (after !== before || JSON.stringify(metaNow.raw) !== JSON.stringify(raw)) {
    console.log(`stopping: ${V2} or the state changed during the copy (rows/newest ${before} -> ${after}), so the app may still be writing ${V2}. Nothing marked; check the flag, then run it again.`);
    return 3;
  }
  if (exists && meta) {
    const next = { ...meta, state: 'v1', rolledBackAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await sql(`UPDATE ${META} SET v = ${lit(JSON.stringify(next))} WHERE k = ${lit(META_KEY)}`);
    console.log(`reverse-copy: state set to v1 (was ${meta.state}); re-enabling PM_EVENTS_V2 later starts a fresh id-checked copy`);
  }
  return 0;
}

async function main(argv) {
  try {
    ARGS = parseArgs(argv);
  } catch (e) {
    console.error(`error: ${e.message}`);
    console.error('usage: node pm-events-v2.mjs [--env <app.env>] status | verify | reverse-copy [--apply] [--since TS] [--force] [--pause-ms N]');
    return 64;
  }
  const run = { status, verify, 'reverse-copy': reverseCopy }[ARGS.cmd];
  return run();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(typeof code === 'number' ? code : 0),
    (e) => {
      console.error(`error: ${redact(e?.message ?? e)}`);
      process.exit(1);
    },
  );
}
