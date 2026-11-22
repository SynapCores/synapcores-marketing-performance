# Installs feed: drop-file format (v1)

One-way, sanitized feed from the telemetry engine (agentNet :8080, db `main`, table
`telemetry_events`) to the Marketing Performance app (mktperf). The export job writes
these files; the app only reads them. Neither side holds the other's database key.

```
telemetry engine :8080 --(export job, User=bitnami, telemetry key via LoadCredential,
                          egress localhost only)--> /var/lib/synapcores-installs-feed/*.jsonl
                          (dir bitnami:mktperf-app 2750, files 0640)
mktperf-app (read-only) --> its own engine :18420, table pm_install_feed
```

Drop directory: `/var/lib/synapcores-installs-feed/` (owner `bitnami`, group `mktperf-app`,
mode `2750`). Files are `0640 bitnami:mktperf-app`, written atomically (temp file in the same
directory, fsync, rename). `mktperf-app` can read them but can't create, replace or delete anything.

Privacy rules (enforced by the writer, checked again by the app's importer):
- No full IP addresses. Networks only: IPv4 `/24` written as three octets (`"203.0.113"`),
  IPv6 `/40` written as `"2001:db8:1200::/40"` (a /40 holds ~256 customer /48s, the same anonymity set as an
  IPv4 /24; a /48 is often a single site). 6to4 addresses (`2002::/16`) carry a full IPv4 address in their first
  48 bits, so they are written as that IPv4's /24.
- No raw installation ids. Ids are `i_` / `p_` + 32 lowercase hex chars: HMAC-SHA256 with a
  salt that only the export job can read (`/etc/synapcores/installs-feed.salt`, root 0600,
  passed in with systemd `LoadCredential=`).
- Fields copied from telemetry are attacker-writable (the ingest endpoint is public), so each has a strict
  format and anything else becomes `null`: `country` = two capital letters; versions and `latest_release` =
  `[v]N.N.N[-tag[.x]]`; `deployment`, `os`, `arch` = a letter followed by up to 23 of `[A-Za-z0-9_-]`. None of
  these formats can spell an IP address. All of them also fit the app's general rule: at most 40 chars of
  `[A-Za-z0-9._+ -]`.

All timestamps are UTC, `YYYY-MM-DDTHH:MM:SSZ`. Dates are UTC `YYYY-MM-DD`.

## `installs-v1.jsonl` (export unit, every 15 min)

Line 1 is the header; then every `installation` line; then every `person` line.

```json
{"type":"header","schema":"synapcores-installs-feed","version":1,
 "generated_at":"2026-11-22T02:15:03Z",
 "source":{"rows":1500,"installations":380,"max_received_at":"2026-11-21T11:49:07Z"},
 "classifier":{"name":"tel8w-port","rules":"2026-11-20",
               "gh_ranges_fetched_at":"2026-11-18T15:16:08Z","azure_ranges_fetched_at":"2026-11-20T17:43:35Z"},
 "counts":{"installation":380,"person":15},
 "salt_id":"9f2c41d0"}
```

- `counts` must equal the number of lines of each type (the importer rejects the file otherwise).
- `salt_id` = first 8 hex chars of SHA-256(salt). If it changes, every id changes; the importer
  replaces all rows in that case (a salt rotation is a full re-key, not new installs).

```json
{"type":"installation","id":"i_0123456789abcdef0123456789abcdef","person":"p_…" ,
 "class":"external","reason":null,
 "first_seen":"2026-11-05T09:12:00Z","last_seen":"2026-11-06T10:00:00Z",
 "events":{"installation_created":1,"instance_started":2,"installation_version_changed":0,
           "installation_heartbeat":0,"other":0},
 "version":"2.4.4-ce","first_version":"2.4.4-ce",
 "deployment":"bare-metal","os":"linux","arch":"aarch64","country":"PL","net":"203.0.113",
 "active_days":["2026-11-05","2026-11-06"],"new_7d":false,"active_7d":false}
```

| field | meaning |
|---|---|
| `class` | `external` (tel8w.py "person"), `ci`, `internal`, `likely-internal`, `partner`, `test` |
| `reason` | why it isn't external: `ops-smoke`, `internal-list`, `likely-internal-list`, `partner-24`, `internal-later-event`, `nightly-ci`, `gh-actions-cidr`, `no-ip-nightly-docker`; `null` for external |
| `person` | person id for `external` installs (same id = same person cluster), else `null` |
| `first_seen` | first install signal (any of the 4 event types) = the day it counts as a **new install** |
| `last_seen` | last event of any type |
| `events` | event counts by type (`other` = any unknown type) |
| `version` / `first_version` | product_version of the last / first event that carried one |
| `deployment`, `os`, `arch`, `country` | from the first event (os/arch normalized like tel8w.py: darwin→macos, arm64→aarch64, amd64→x86_64) |
| `net` | /24 (or IPv6 /40) of the first event that carried an IP; `null` if none did, and always `null` for `internal`, `likely-internal` and `test` (our own networks never leave the host) |
| `active_days` | UTC dates with any event, ascending, at most the last 400 |
| `new_7d` / `active_7d` | `first_seen` / `last_seen` within 7 days before `generated_at` |

```json
{"type":"person","id":"p_…","first_seen":"2026-11-05T09:12:00Z","last_seen":"2026-11-06T10:00:00Z",
 "installs":1,"country":"PL","net":"203.0.113","deployment":"bare-metal","os":"linux","arch":"aarch64",
 "first_version":"2.4.4-ce","version":"2.4.4-ce","active_days":["2026-11-05","2026-11-06"],
 "returned":true}
```

A person = a cluster of `external` installs that share any /24 (IPv6 /64) on any event, plus
no-IP installs matched by country + deployment + os/arch within 48 h, plus documented manual
merges (tel8w.py `cluster_people`). `first_seen` = first event of any member (the day it counts
as a **new person**). `returned` = engine started again on a later UTC day than the first event.

## `github-downloads-v1.jsonl` (refresh unit, once a day; optional)

Public release download counters of `SynapCores/synapcores-releases` (unauthenticated GitHub
API). Cumulative counters, so per-day downloads = difference between consecutive snapshots.
They include CI and bot downloads; GitHub doesn't say who downloaded.

```json
{"type":"header","schema":"synapcores-github-downloads","version":1,"generated_at":"2026-11-22T06:40:00Z",
 "repo":"SynapCores/synapcores-releases","counts":{"snapshot":2}}
{"type":"snapshot","date":"2026-11-22","fetched_at":"2026-11-22T01:50:00Z","archives":812,"all_assets":1530,
 "by_platform":{"darwin-aarch64":120,"linux-aarch64":90,"linux-x86_64":600,"other":2},
 "latest_release":"v2.5.1-ce","latest_archives":14}
```

- `archives` = downloads of release archives (`.tar.gz`, `.tgz`, `.zip`, `.deb`, `.rpm`, `.dmg`, `.pkg`, `.msi`, `.exe`), all releases.
- `all_assets` = every asset including `.sha256` files and `install-ce.sh`.
- `by_platform` = archive downloads by `<os>-<arch>` parsed from the asset name.
- Snapshots are ascending by `date`, one per UTC date (the last fetch of the day wins), at most 400.
