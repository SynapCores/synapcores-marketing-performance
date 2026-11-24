#!/usr/bin/env node
// Regenerates src/lib/visitor/crawler-ranges.bundled.json (the offline fallback
// for crawler IP verification) from the URLs in crawler-sources.json.
// A source that fails keeps its previously bundled prefixes.
//   node bin/update-crawler-ranges.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'visitor');
const { sources } = JSON.parse(readFileSync(join(dir, 'crawler-sources.json'), 'utf8'));
const outPath = join(dir, 'crawler-ranges.bundled.json');
let prev = { sources: {} };
try { prev = JSON.parse(readFileSync(outPath, 'utf8')); } catch {}

const valid = (c) => {
  const [a, l] = String(c).split('/');
  const v = isIP(a);
  const n = l === undefined ? (v === 4 ? 32 : 128) : Number(l);
  return (v === 4 && n >= 0 && n <= 32) || (v === 6 && n >= 0 && n <= 128);
};

const out = { fetchedAt: new Date().toISOString(), sources: {} };
for (const s of sources) {
  try {
    const res = await fetch(s.url, { headers: { accept: 'application/json', 'user-agent': 'mktperf-crawler-ranges/1.0' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = JSON.parse(await res.text());
    const list = (doc.prefixes ?? []).map((p) => p.ipv4Prefix ?? p.ipv6Prefix).filter((c) => typeof c === 'string' && valid(c));
    if (!list.length) throw new Error('no prefixes');
    out.sources[s.id] = list;
    console.log(`${s.id}: ${list.length}`);
  } catch (e) {
    out.sources[s.id] = prev.sources?.[s.id] ?? [];
    console.log(`${s.id}: FAILED (${e.message}); kept ${out.sources[s.id].length} bundled`);
  }
}
writeFileSync(outPath, JSON.stringify(out) + '\n');
console.log('wrote', outPath);
