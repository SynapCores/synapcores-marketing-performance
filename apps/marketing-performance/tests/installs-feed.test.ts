import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DOWNLOADS_RECORD_TYPES,
  INSTALLS_RECORD_TYPES,
  MAX_FEED_BYTES,
  describeImport,
  downloadsRecords,
  emptyImportResult,
  hasDuplicateKeys,
  importIntervalMinutes,
  installsRecords,
  looksLikeFullIp,
  looksLikeIpLoose,
  metaPayload,
  parseDeleteFraction,
  parseDownloadsFeed,
  parseInstallsFeed,
  parseStoredMeta,
  parseStoredRow,
  planImport,
  rowHash,
  rowId,
  type ExistingRow,
  type FeedRecord,
  type InstallsFeed,
} from '../src/lib/installs/feed';

// Synthetic fixtures: fake hex ids, RFC 5737 / RFC 3849 documentation networks.
const FIX = join(__dirname, '..', '..', 'tests', 'fixtures');
const INSTALLS = readFileSync(join(FIX, 'installs-v1.sample.jsonl'), 'utf8');
const DOWNLOADS = readFileSync(join(FIX, 'github-downloads-v1.sample.jsonl'), 'utf8');

type J = Record<string, any>;
const lines = (s: string): J[] => s.trimEnd().split('\n').map((l) => JSON.parse(l) as J);
const file = (objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
/** The fixture with line `i` (0 = header) edited. */
function edit(src: string, i: number, f: (o: J) => void): string {
  const ls = lines(src);
  f(ls[i]!);
  return file(ls);
}
function installsOk(text = INSTALLS): InstallsFeed {
  const r = parseInstallsFeed(text);
  if (!r.ok) assert.fail(`expected ok, got: ${r.error}`);
  return r.feed;
}
function rejected(text: string, downloads = false): string {
  const r = downloads ? parseDownloadsFeed(text) : parseInstallsFeed(text);
  assert.equal(r.ok, false, 'expected the file to be rejected');
  return (r as { error: string }).error;
}
const TENANT = 't-1';
const existingFrom = (recs: FeedRecord[]): ExistingRow[] => recs.map((r) => ({ row_id: rowId(TENANT, r.record_type, r.record_id), row_hash: r.row_hash, record_type: r.record_type }));
const installsPlanOpts = { tenantId: TENANT, recordTypes: INSTALLS_RECORD_TYPES, saltId: '9f2c41d0', storedSaltId: '9f2c41d0' };

// ── parsing ──────────────────────────────────────────────────────────────────
test('parses the sample installs feed', () => {
  const r = parseInstallsFeed(INSTALLS);
  assert.ok(r.ok);
  const f = r.feed;
  assert.equal(f.header.generated_at, '2026-11-22T01:45:00Z');
  assert.equal(f.header.salt_id, '9f2c41d0');
  assert.equal(f.header.classifier.rules, '2026-11-20');
  assert.equal(f.header.source.rows, 120);
  assert.equal(f.installations.length, 8);
  assert.equal(f.people.length, 3);
  assert.equal(r.droppedFields, 2); // header x_debug + installation extra_note
  assert.equal(r.blankedValues, 0);
  const a4 = f.installations.find((x) => x.id === 'i_' + 'a4'.repeat(16))!;
  assert.equal(a4.net, '2001:db8:1200::/40');
  assert.equal(a4.events.instance_started, 1);
  assert.equal(f.installations.find((x) => x.class === 'internal')!.net, null);
});

test('parses the sample downloads feed', () => {
  const r = parseDownloadsFeed(DOWNLOADS);
  assert.ok(r.ok);
  assert.equal(r.feed.header.repo, 'SynapCores/synapcores-releases');
  assert.deepEqual(r.feed.snapshots.map((s) => s.archives), [700, 730, 760, 812]);
  assert.deepEqual(Object.keys(r.feed.snapshots[0]!.by_platform), ['darwin-aarch64', 'linux-aarch64', 'linux-x86_64']);
});

test('header counts must equal the lines per type', () => {
  assert.match(rejected(edit(INSTALLS, 0, (h) => (h.counts.installation = 9))), /counts\.installation does not match/);
  assert.match(rejected(edit(INSTALLS, 0, (h) => (h.counts.person = 2))), /counts\.person does not match/);
  assert.match(rejected(edit(DOWNLOADS, 0, (h) => (h.counts.snapshot = 5)), true), /counts\.snapshot does not match/);
  // A missing line is caught the same way.
  const ls = lines(INSTALLS);
  ls.splice(3, 1);
  assert.match(rejected(file(ls)), /counts\.installation/);
});

test('header must be first, with the expected schema and version', () => {
  const ls = lines(INSTALLS);
  assert.match(rejected(file([ls[1], ls[0], ...ls.slice(2)])), /^line 1: the first line must be the header/);
  assert.match(rejected(edit(INSTALLS, 0, (h) => (h.schema = 'something-else'))), /schema/);
  assert.match(rejected(edit(INSTALLS, 0, (h) => (h.version = 2))), /version/);
  assert.match(rejected(edit(INSTALLS, 0, (h) => (h.salt_id = 'XYZ'))), /salt_id/);
  assert.match(rejected(file([...ls, ls[0]])), /second header line/);
});

test('a full IPv4 address anywhere rejects the whole file, without echoing it', () => {
  const ip = '192.0.2.44';
  const cases = [
    edit(INSTALLS, 1, (o) => (o.debug = `seen from ${ip}`)), // unexpected field
    edit(INSTALLS, 1, (o) => (o.debug = { nested: [ip] })),
    edit(INSTALLS, 1, (o) => (o[ip] = 1)), // as a key
    edit(INSTALLS, 0, (h) => (h.source.peer = ip)), // nested unknown header field
    edit(INSTALLS, 1, (o) => (o.net = ip)), // four octets in net
    edit(INSTALLS, 1, (o) => (o.deployment = ip)), // passes the short-string charset, still refused
    edit(INSTALLS, 10, (o) => (o.extra = `x ${ip}`)), // person line
    INSTALLS.replace('"net":"203.0.113"', `"net":"${ip}","net":"203.0.113"`), // hidden by a duplicate key
    INSTALLS.replace('"os":"linux"', '"os":"linux","x":"\\u0031\\u0039\\u0032.0.2.44"'), // \u escapes
  ];
  for (const text of cases) {
    const err = rejected(text);
    assert.ok(!err.includes(ip) && !err.includes('192.0.2'), `error must not echo the value: ${err}`);
    assert.match(err, /^line \d+: /);
  }
  assert.match(rejected(cases[0]!), /^line 2: an unknown field looks like a full IP address/);
  assert.match(rejected(cases[5]!), /^line 2: field "deployment" looks like a full IP address/);
  assert.match(rejected(edit(DOWNLOADS, 2, (o) => (o.note = ip)), true), /^line 3: /);
});

test('IPv6 more specific than a /40 is rejected; /40 networks and timestamps pass', () => {
  assert.match(rejected(edit(INSTALLS, 4, (o) => (o.net = '2001:db8:1::/48'))), /^line 5: field "net"/); // /48 is too specific
  assert.match(rejected(edit(INSTALLS, 4, (o) => (o.net = '2001:db8:1:2::/64'))), /^line 5: field "net"/);
  assert.match(rejected(edit(INSTALLS, 4, (o) => (o.net = '2001:db8::1'))), /^line 5: field "net"/);
  assert.match(rejected(edit(INSTALLS, 4, (o) => (o.note = '2001:db8::1'))), /^line 5: an unknown field/);
  assert.match(rejected(edit(INSTALLS, 4, (o) => (o.note = '2001:db8:0:1:2:3:4:5'))), /^line 5: /);
  assert.match(rejected(edit(INSTALLS, 4, (o) => (o.net = '2001:DB8:1200::/40'))), /field "net"/); // lowercase only
  for (const s of ['192.0.2.1', '10.0.0.255', '2001:db8::1', '::1', 'fe80::1', '2001:db8:1:2::', '1:2:3:4', '::ffff:192.0.2.1', 'at 2001:0db8:85a3:0000:0000:8a2e:0370:7334']) {
    assert.equal(looksLikeFullIp(s), true, s);
  }
  for (const s of ['2026-11-22T02:15:03Z', '2001:db8:1200::/40', '2001:db8:1::', '203.0.113', '2.4.4-ce', 'v2.5.1-ce', 'linux-x86_64', '9f2c41d0', 'i_' + 'ab'.repeat(16)]) {
    assert.equal(looksLikeFullIp(s), false, s);
  }
});

test('ids must be i_/p_ + 32 lowercase hex', () => {
  const bad = ['i_' + 'A1'.repeat(16), 'i_' + 'a'.repeat(31), 'p_' + 'a1'.repeat(16), 'i_' + 'g1'.repeat(16)];
  for (const id of bad) {
    const err = rejected(edit(INSTALLS, 1, (o) => (o.id = id)));
    assert.equal(err, 'line 2: field "id" is invalid');
  }
  assert.equal(rejected(edit(INSTALLS, 1, (o) => (o.person = 'i_' + 'a1'.repeat(16)))), 'line 2: field "person" is invalid');
  assert.equal(rejected(edit(INSTALLS, 9, (o) => (o.id = 'p_123'))), 'line 10: field "id" is invalid');
  // Duplicates would collide on row_id.
  assert.match(rejected(edit(INSTALLS, 2, (o) => (o.id = 'i_' + 'a1'.repeat(16)))), /^line 3: duplicate installation id/);
});

test('enums, timestamps, dates, numbers and short strings are checked', () => {
  const bad: Array<[number, (o: J) => void, RegExp]> = [
    [1, (o) => (o.class = 'customer'), /field "class"/],
    [1, (o) => (o.reason = 'because'), /field "reason"/],
    [1, (o) => (o.first_seen = '2026-11-20T10:00:00.000Z'), /field "first_seen" is not a UTC timestamp/],
    [1, (o) => (o.last_seen = '2026-11-20 10:00:00'), /field "last_seen"/],
    [1, (o) => (o.last_seen = '2026-02-30T10:00:00Z'), /field "last_seen"/],
    [1, (o) => (o.active_days = ['2026-11-21', '2026-11-20']), /ascending/],
    [1, (o) => (o.active_days = ['2026-11-20', '2026-11-20']), /ascending/],
    [1, (o) => (o.active_days = ['2026-13-01']), /field "active_days"/],
    [1, (o) => (o.active_days = Array.from({ length: 401 }, (_, i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10))), /more than 400/],
    [1, (o) => (o.events.other = -1), /events\.other/],
    [1, (o) => (o.events.other = 1.5), /events\.other/],
    [1, (o) => delete o.events.installation_heartbeat, /missing field "events\.installation_heartbeat"/],
    [1, (o) => (o.version = 'x'.repeat(41)), /field "version"/],
    [1, (o) => (o.deployment = '<script>'), /field "deployment"/],
    [1, (o) => (o.country = 42), /field "country"/],
    [1, (o) => (o.new_7d = 'yes'), /field "new_7d"/],
    [1, (o) => delete o.net, /missing field "net"/],
    [9, (o) => (o.installs = -2), /field "installs"/],
    [9, (o) => (o.returned = null), /field "returned"/],
    [0, (h) => (h.generated_at = 'yesterday'), /field "generated_at"/],
    [0, (h) => (h.classifier.rules = '20-11-2026'), /classifier\.rules/],
  ];
  for (const [i, f, re] of bad) {
    const err = rejected(edit(INSTALLS, i, f));
    assert.match(err, re);
    assert.match(err, new RegExp(`^line ${i + 1}: `));
  }
  // An absurd number is not a count.
  assert.match(rejected(INSTALLS.replace('"installs":2', '"installs":1e400')), /field "installs"/);
});

test('structure: JSON objects only, no blank lines, installations before people, known types', () => {
  const ls = INSTALLS.trimEnd().split('\n');
  const bad = [...ls];
  bad[3] = '{"type":"installation", oops';
  assert.equal(rejected(bad.join('\n')), 'line 4: not valid JSON');
  assert.equal(rejected([...ls.slice(0, 3), '', ...ls.slice(3)].join('\n')), 'line 4: blank line');
  assert.equal(rejected([...ls.slice(0, 3), '[1,2]', ...ls.slice(3)].join('\n')), 'line 4: not a JSON object');
  assert.match(rejected([ls[0], ls[9], ...ls.slice(1, 9), ...ls.slice(10)].join('\n')), /installation line after the person lines/);
  assert.match(rejected(edit(INSTALLS, 2, (o) => (o.type = 'summary'))), /^line 3: field "type"/);
  assert.equal(rejected(''), 'file is empty');
  // Trailing newline optional.
  assert.ok(parseInstallsFeed(INSTALLS.trimEnd()).ok);
});

test('size caps: 8 MB and 20,000 lines', () => {
  assert.match(rejected('x'.repeat(MAX_FEED_BYTES + 1)), /larger than 8 MB/);
  const many = [INSTALLS.split('\n')[0], ...Array.from({ length: 20_000 }, () => '{}')].join('\n');
  assert.match(rejected(many), /more than 20000 lines/);
});

test('6to4 networks carry a whole IPv4 address: rejected as net and anywhere else', () => {
  assert.match(rejected(edit(INSTALLS, 4, (o) => (o.net = '2002:cb00:710d::/48'))), /^line 5: field "net" looks like a full IP address/);
  assert.match(rejected(edit(INSTALLS, 4, (o) => (o.net = '2002:cb00::/48'))), /^line 5: field "net"/); // = 203.0.0.0
  assert.match(rejected(edit(INSTALLS, 4, (o) => (o.net = '2002::/48'))), /^line 5: field "net" is not an IPv4 \/24/);
  assert.match(rejected(edit(INSTALLS, 4, (o) => (o.net = '2002:cb00::/40'))), /^line 5: field "net"/); // 6to4 never as IPv6
  assert.match(rejected(edit(INSTALLS, 1, (o) => (o.note = 'via 2002:c000:201'))), /^line 2: an unknown field looks like a full IP address/);
  assert.equal(looksLikeFullIp('2002:cb00:710d::/48'), true);
  assert.equal(looksLikeFullIp('2002:cb00'), false); // a /16 at most
});

test('non-ASCII or control characters anywhere reject the file', () => {
  assert.equal(rejected(edit(INSTALLS, 1, (o) => (o.note = '１.２.３.４'))), 'line 2: an unknown field contains non-ASCII or control characters');
  assert.match(rejected(edit(INSTALLS, 1, (o) => (o['ｎｏｔｅ'] = 1))), /^line 2: an unknown field name contains non-ASCII/);
  assert.match(rejected(edit(INSTALLS, 1, (o) => (o.note = '2001:db8\u200b:1:2::1'))), /^line 2: .*non-ASCII/);
  assert.match(rejected(edit(INSTALLS, 0, (h) => (h.source.note = 'tab\there'))), /^line 1: field "source" contains non-ASCII or control characters/);
});

test('a key twice in one object rejects the file', () => {
  assert.equal(rejected(INSTALLS.replace('"class":"external"', '"class":"ci","class":"external"')), 'line 2: a key appears twice in one object');
  assert.equal(rejected(INSTALLS.replace('"other":0}', '"other":0,"other":0}')), 'line 2: a key appears twice in one object');
  assert.equal(hasDuplicateKeys('{"a":{"a":1},"b":[{"a":1},{"a":2}],"c":"\\"a\\":1,\\"a\\""}'), false);
  assert.equal(hasDuplicateKeys('{"a":1,"\\u0061":2}'), true);
});

test('free text that looks like an IPv4 address written another way is blanked, not stored', () => {
  const text = edit(INSTALLS, 1, (o) => {
    o.version = 'ip-10-1-2-3';
    o.deployment = '10 1 2 3';
    o.country = '203_0_113_7';
    o.os = '0xcb00710d';
    o.arch = '3405803789';
    o.first_version = '2026.11.20.1'; // a calendar version is kept
  });
  const r = parseInstallsFeed(text);
  assert.ok(r.ok);
  assert.equal(r.blankedValues, 5);
  const a1 = r.feed.installations[0]!;
  assert.deepEqual([a1.version, a1.deployment, a1.country, a1.os, a1.arch, a1.first_version], [null, null, null, null, null, '2026.11.20.1']);
  const payload = installsRecords(r.feed)[0]!.payload;
  for (const s of ['10-1-2-3', '10 1 2 3', '203_0_113_7', 'cb00710d', '3405803789']) assert.ok(!payload.includes(s), s);
  for (const s of ['1.2.3. 4', '+1.+2.+3.+4', '1 . 2 . 3 . 4', 'ip10-1-2-3', '300.1.2.3.4']) assert.equal(looksLikeIpLoose(s), true, s);
  for (const s of ['2.4.4-ce', 'v2.5.1-ce', '2026.11.20.1', 'linux', 'x86_64', 'bare-metal', 'PL', '12345678']) assert.equal(looksLikeIpLoose(s), false, s);
  // Four dotted numbers are the contract's "full IPv4": the export job blanks those, so here they reject the file.
  assert.match(rejected(edit(INSTALLS, 1, (o) => (o.deployment = 'host.10.1.2.3'))), /^line 2: field "deployment" looks like a full IP address/);
});

test('counts in the installs file stay below 2^24', () => {
  assert.equal(rejected(edit(INSTALLS, 1, (o) => (o.events.other = 16_777_216))), 'line 2: field "events.other" is not a whole number between 0 and 16777215');
  assert.ok(parseInstallsFeed(edit(INSTALLS, 1, (o) => (o.events.other = 16_777_215))).ok);
});

test('rules that tie fields together are enforced', () => {
  const bad: Array<[number, (o: J) => void, string]> = [
    [1, (o) => (o.reason = 'nightly-ci'), 'line 2: field "reason" must be null for class external'],
    [1, (o) => (o.person = null), 'line 2: field "person" is required for class external'],
    [5, (o) => (o.reason = null), 'line 6: field "reason" is required unless class is external'],
    [5, (o) => (o.person = 'p_' + '01'.repeat(16)), 'line 6: field "person" must be null unless class is external'],
    [1, (o) => (o.person = 'p_' + '0f'.repeat(16)), 'line 2: field "person" names a person that has no person line'],
    [9, (o) => (o.installs = 1), 'line 10: field "installs" is lower than the number of installation lines that name this person'],
    [9, (o) => (o.installs = 0), 'line 10: field "installs" is 0'],
    [1, (o) => (o.first_seen = '2026-11-21T10:00:00Z'), 'line 2: field "first_seen" is later than "last_seen"'],
    [1, (o) => (o.active_days = ['2026-11-20']), 'line 2: field "active_days" does not end on the date of "last_seen"'],
    [1, (o) => (o.active_days = []), 'line 2: field "active_days" is empty'],
    [1, (o) => (o.active_days = ['2026-11-21']), 'line 2: field "active_days" starts after the date of "first_seen"'],
    [9, (o) => (o.active_days = ['2026-11-15', '2026-11-20', '2026-11-21']), 'line 10: field "active_days" does not start on the date of "first_seen"'],
  ];
  for (const [i, f, msg] of bad) assert.equal(rejected(edit(INSTALLS, i, f)), msg);
  // An installation may have events before its first install signal.
  assert.ok(parseInstallsFeed(edit(INSTALLS, 1, (o) => (o.active_days = ['2026-11-19', '2026-11-20', '2026-11-21']))).ok);
  assert.equal(rejected(edit(DOWNLOADS, 2, (o) => (o.fetched_at = '2026-11-20T01:50:00Z')), true), 'line 3: field "date" is not the date of "fetched_at"');
});

test('timestamps and dates must be plausible: 2024 or later, at most a day after generated_at', () => {
  const window = 'is not between 2024-01-01 and a day after generated_at';
  assert.equal(rejected(edit(INSTALLS, 1, (o) => (o.first_seen = '2000-01-01T00:00:00Z'))), `line 2: field "first_seen" ${window}`);
  assert.equal(
    rejected(edit(INSTALLS, 1, (o) => { o.last_seen = '2026-11-23T02:00:00Z'; o.active_days = ['2026-11-20', '2026-11-23']; })),
    `line 2: field "last_seen" ${window}`,
  );
  assert.equal(rejected(edit(INSTALLS, 0, (h) => (h.generated_at = '9999-12-31T23:59:59Z'))), 'line 1: field "generated_at" is not between 2024-01-01 and 2100');
  assert.equal(rejected(edit(INSTALLS, 0, (h) => (h.source.max_received_at = '2027-01-01T00:00:00Z'))), `line 1: field "source.max_received_at" ${window}`);
  assert.equal(rejected(edit(INSTALLS, 7, (o) => (o.active_days = ['2019-12-31', '2026-11-17', '2026-11-18']))), 'line 8: field "active_days" has a date before 2024-01-01');
  assert.equal(rejected(edit(DOWNLOADS, 1, (o) => { o.date = '2000-01-01'; o.fetched_at = '2000-01-01T01:50:00Z'; }), true), `line 2: field "date" ${window}`);
  // Up to a day after generated_at is fine (clock skew).
  assert.ok(parseInstallsFeed(edit(INSTALLS, 1, (o) => { o.last_seen = '2026-11-22T12:00:00Z'; o.active_days = ['2026-11-20', '2026-11-21', '2026-11-22']; })).ok);
});

test('downloads feed: ascending unique dates, platform names, repo', () => {
  const ls = lines(DOWNLOADS);
  assert.match(rejected(file([ls[0], ls[2], ls[1], ls[3], ls[4]]), true), /^line 3: snapshots are not in ascending date order/);
  assert.match(rejected(file([ls[0], ls[1], ls[1], ls[3], ls[4]]), true), /ascending date order/);
  assert.match(rejected(DOWNLOADS.replace('"darwin-aarch64":100', '"__proto__":100'), true), /platform name/);
  assert.match(rejected(edit(DOWNLOADS, 0, (h) => (h.repo = 'not a repo')), true), /field "repo"/);
  assert.match(rejected(edit(DOWNLOADS, 1, (o) => (o.archives = -1)), true), /field "archives"/);
  assert.match(rejected(edit(DOWNLOADS, 1, (o) => (o.type = 'installation')), true), /field "type" is not snapshot/);
});

test('unknown fields are dropped: the stored payload is canonical', () => {
  const recs = installsRecords(installsOk());
  const a1 = recs.find((r) => r.record_id === 'i_' + 'a1'.repeat(16))!;
  assert.ok(!a1.payload.includes('extra_note'));
  assert.deepEqual(Object.keys(JSON.parse(a1.payload)).slice(0, 5), ['type', 'id', 'person', 'class', 'reason']);
  assert.equal(a1.row_hash, rowHash(a1.payload));
  assert.match(a1.row_hash, /^[0-9a-f]{32}$/);
  // Same data, no extra fields, keys in another order → identical payloads and hashes.
  const clean = file(
    lines(INSTALLS).map((o) => {
      delete o.extra_note;
      delete o.x_debug;
      return Object.fromEntries(Object.entries(o).reverse());
    }),
  );
  assert.deepEqual(installsRecords(installsOk(clean)), recs);
});

test('stored rows and meta are re-validated on read', () => {
  const feed = installsOk();
  for (const r of installsRecords(feed)) {
    const back = parseStoredRow(r.record_type, r.payload);
    assert.ok(back);
    assert.equal(JSON.stringify(back), r.payload);
  }
  const tampered = installsRecords(feed)[0]!.payload.replace('"net":"203.0.113"', '"net":"203.0.113.7"');
  assert.equal(parseStoredRow('installation', tampered), null);
  assert.equal(parseStoredRow('person', installsRecords(feed)[0]!.payload), null); // wrong type
  const d = parseDownloadsFeed(DOWNLOADS);
  assert.ok(d.ok);
  for (const r of downloadsRecords(d.feed)) assert.ok(parseStoredRow('snapshot', r.payload));
  const meta = parseStoredMeta(metaPayload('installs-v1.jsonl', feed.header, '2026-11-22T01:46:00Z', 'a'.repeat(64)));
  assert.ok(meta);
  assert.equal(meta.header.generated_at, '2026-11-22T01:45:00Z');
  assert.equal(parseStoredMeta('{"file":"installs-v1.jsonl"}'), null);
  // Meta is scanned like a feed line.
  const leaky = { ...feed.header, classifier: { ...feed.header.classifier, name: '192.0.2.1' } };
  assert.equal(parseStoredMeta(metaPayload('installs-v1.jsonl', leaky, '2026-11-22T01:46:00Z', 'a'.repeat(64))), null);
});

// ── planImport ───────────────────────────────────────────────────────────────
test('planImport: the same file twice is all unchanged (idempotent)', () => {
  const recs = installsRecords(installsOk());
  const first = planImport([], recs, installsPlanOpts);
  assert.equal(first.insert.length, 11);
  assert.equal(first.insert[0]!.row_id, `${TENANT}:installation:i_${'a1'.repeat(16)}`);
  const again = planImport(existingFrom(recs), installsRecords(installsOk()), installsPlanOpts);
  assert.deepEqual({ i: again.insert.length, u: again.update.length, d: again.delete.length, n: again.unchanged, r: again.refused }, { i: 0, u: 0, d: 0, n: 11, r: undefined });
});

test('planImport: a small change is one update; new and removed rows insert / delete', () => {
  const recs = installsRecords(installsOk());
  const changed = edit(INSTALLS, 1, (o) => {
    o.last_seen = '2026-11-21T12:00:00Z';
    o.events.installation_heartbeat = 3;
  });
  const p = planImport(existingFrom(recs), installsRecords(installsOk(changed)), installsPlanOpts);
  assert.equal(p.update.length, 1);
  assert.equal(p.update[0]!.record_id, 'i_' + 'a1'.repeat(16));
  assert.equal(p.update[0]!.last_seen, '2026-11-21T12:00:00Z');
  assert.equal(p.unchanged, 10);
  assert.equal(p.insert.length + p.delete.length, 0);

  const ls = lines(INSTALLS);
  const removed = ls.splice(2, 1)[0]!; // drop a2
  ls.splice(2, 0, { ...removed, id: 'i_' + 'f0'.repeat(16) }); // add a new id
  const p2 = planImport(existingFrom(recs), installsRecords(installsOk(file(ls))), installsPlanOpts);
  assert.deepEqual(p2.insert.map((r) => r.record_id), ['i_' + 'f0'.repeat(16)]);
  assert.deepEqual(p2.delete, [`${TENANT}:installation:i_${'a2'.repeat(16)}`]);
});

/** n stored installation rows with fake ids. */
const storedRows = (n: number): ExistingRow[] =>
  Array.from({ length: n }, (_, i) => ({ row_id: rowId(TENANT, 'installation', 'i_' + i.toString(16).padStart(32, '0')), row_hash: 'x'.repeat(32), record_type: 'installation' }));

/** The fixture with every id re-keyed (what a salt rotation looks like) and a new salt_id. */
function rekeyed(): string {
  const flip = (s: string) => s.replace(/([ip])_([0-9a-f]{2})\2{15}/g, (_m, k: string, h: string) => `${k}_${(h[1]! + h[0]!).repeat(16)}`);
  return file(lines(flip(INSTALLS)).map((o, i) => (i === 0 ? { ...o, salt_id: '0badc0de' } : o)));
}

test('planImport: refuses a mass delete; a salt rotation replaces every row when the new file is as large', () => {
  const recs = installsRecords(installsOk()); // 11 rows, none matching the stored ones
  const p = planImport(storedRows(40), recs, installsPlanOpts);
  assert.ok(p.refused);
  assert.match(p.refused, /^would delete 40 of 40 stored rows \(limit 20, INSTALLS_FEED_MAX_DELETE_FRACTION=0\.5; set it to 1 for one import if this is intended\)$/);
  assert.equal(p.insert.length + p.update.length + p.delete.length, 0); // nothing to write
  // A real rotation: same rows, new ids.
  const stored = existingFrom(recs);
  const rot = planImport(stored, installsRecords(installsOk(rekeyed())), { ...installsPlanOpts, saltId: '0badc0de' });
  assert.equal(rot.refused, undefined);
  assert.equal(rot.saltRotated, true);
  assert.equal(rot.delete.length, 11);
  assert.equal(rot.insert.length, 11);
  // A "rotation" that brings far fewer rows is still refused (header-only file, or a truncated export).
  const short = planImport(storedRows(40), recs, { ...installsPlanOpts, saltId: '0badc0de' });
  assert.match(short.refused ?? '', /^salt rotation \(full re-key\) brings 11 rows for 40 stored, 29 fewer \(limit 20/);
  assert.match(planImport(storedRows(40), [], { ...installsPlanOpts, saltId: '0badc0de' }).refused ?? '', /brings 0 rows for 40 stored/);
  // Explicit override.
  assert.equal(planImport(storedRows(40), recs, { ...installsPlanOpts, maxDeleteFraction: 1 }).refused, undefined);
});

test('planImport: the limit also applies to each record type', () => {
  // 30 installations + 15 people stored; the new file has every installation but no person lines.
  const people = Array.from({ length: 15 }, (_, i): ExistingRow => ({ row_id: rowId(TENANT, 'person', 'p_' + i.toString(16).padStart(32, '0')), row_hash: 'y'.repeat(32), record_type: 'person' }));
  const inst = storedRows(30);
  const keepAll = inst.map((r): FeedRecord => ({ record_type: 'installation', record_id: r.row_id.split(':')[2]!, class: 'external', first_seen: null, last_seen: null, payload: '{}', row_hash: r.row_hash }));
  const p = planImport([...inst, ...people], keepAll, installsPlanOpts); // 15 of 45 overall is within the limit
  assert.match(p.refused ?? '', /^would delete 15 of 15 stored person rows \(limit 10,/);
});

test("planImport: ignores stored rows of other tenants and other files", () => {
  const recs = installsRecords(installsOk());
  const foreign: ExistingRow[] = [
    { row_id: rowId('t-2', 'installation', 'i_' + 'a1'.repeat(16)), row_hash: 'z'.repeat(32), record_type: 'installation' },
    { row_id: rowId(TENANT, 'snapshot', '2026-11-18'), row_hash: 'z'.repeat(32), record_type: 'snapshot' },
    { row_id: rowId(TENANT, 'meta', 'installs'), row_hash: 'z'.repeat(32), record_type: 'meta' },
  ];
  const p = planImport([...existingFrom(recs), ...foreign], recs, installsPlanOpts);
  assert.deepEqual({ d: p.delete.length, i: p.insert.length, n: p.unchanged }, { d: 0, i: 0, n: 11 });
});

test('planImport: the delete limit is max(10, fraction × stored rows)', () => {
  const keep = (rows: ExistingRow[], n: number): FeedRecord[] =>
    rows.slice(0, n).map((r) => ({ record_type: 'installation', record_id: r.row_id.split(':')[2]!, class: 'external', first_seen: null, last_seen: null, payload: '{}', row_hash: r.row_hash }));
  const s30 = storedRows(30);
  assert.equal(planImport(s30, keep(s30, 15), installsPlanOpts).refused, undefined); // deletes 15 = limit
  assert.ok(planImport(s30, keep(s30, 14), installsPlanOpts).refused); // deletes 16
  const s8 = storedRows(8);
  assert.equal(planImport(s8, [], installsPlanOpts).delete.length, 8); // ≤ 10 always allowed
});

test("planImport: a file never deletes another file's rows", () => {
  const d = parseDownloadsFeed(DOWNLOADS);
  assert.ok(d.ok);
  const existing = [...existingFrom(installsRecords(installsOk())), ...storedRows(50)];
  const p = planImport(existing, downloadsRecords(d.feed), { tenantId: TENANT, recordTypes: DOWNLOADS_RECORD_TYPES });
  assert.equal(p.refused, undefined);
  assert.equal(p.delete.length, 0);
  assert.equal(p.insert.length, 4);
  assert.equal(p.insert[0]!.row_id, `${TENANT}:snapshot:2026-11-18`);
  assert.throws(() => planImport([], installsRecords(installsOk()), { tenantId: TENANT, recordTypes: DOWNLOADS_RECORD_TYPES }));
});

// ── helpers ──────────────────────────────────────────────────────────────────
test('describeImport: one line for writes and refusals, nothing otherwise', () => {
  const r = { ...emptyImportResult('installs-v1.jsonl'), generated_at: '2026-11-22T02:15:03Z', inserted: 2, updated: 3, unchanged: 363 };
  assert.equal(describeImport(r), '[installs-feed] installs-v1.jsonl (generated 2026-11-22T02:15:03Z): +2 ~3 -0, 363 unchanged');
  assert.equal(describeImport({ ...r, inserted: 0, updated: 0, meta_updated: true }), null);
  assert.match(describeImport({ ...r, inserted: 0, updated: 0, refused: 'would delete 300 of 368 stored rows' })!, /refused, would delete 300 of 368 stored rows; keeping the stored rows$/);
  assert.match(describeImport({ ...r, deleted: 368, inserted: 368, salt_rotated: true })!, /salt rotated: full re-key/);
  assert.match(describeImport({ ...r, blanked: 2 })!, /363 unchanged \(2 IP-like free-text values blanked\)$/);
});

test('env parsing: delete fraction and import interval', () => {
  assert.equal(parseDeleteFraction(undefined), 0.5);
  assert.equal(parseDeleteFraction('0.2'), 0.2);
  assert.equal(parseDeleteFraction('1'), 1);
  assert.equal(parseDeleteFraction('2'), 0.5);
  assert.equal(parseDeleteFraction('nope'), 0.5);
  assert.equal(importIntervalMinutes(undefined), 5);
  assert.equal(importIntervalMinutes('15'), 15);
  assert.equal(importIntervalMinutes('0'), 5);
  assert.equal(importIntervalMinutes('2.5'), 5);
});
