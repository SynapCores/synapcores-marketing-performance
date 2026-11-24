# Installs feed (telemetry → mktperf, one-way)

Shows SynapCores installs next to site visits in the Marketing Performance app without giving the app
any access to the telemetry database, and without giving the export job any access to the app.

```
telemetry_events (telemetry engine, 127.0.0.1:8080, db main)
   │  export unit, every 15 min, User=bitnami, telemetry key via LoadCredential, egress: localhost only
   ▼
/var/lib/synapcores-installs-feed/installs-v1.jsonl         sanitized: HMAC ids, /24 (IPv6 /40) only, no full IPs
/var/lib/synapcores-installs-feed/github-downloads-v1.jsonl  public GitHub release counters (refresh unit, daily)
   │  read-only for mktperf-app (group), it can't write, replace or delete
   ▼
mktperf app: imports into its own engine (table pm_install_feed), page /installs
```

- The drop-file format is in [FEED-FORMAT.md](FEED-FORMAT.md).
- Classification is a port of the installs-sprint `tel8w.py` (2026-11-20 rules): test, internal, likely-internal,
  partner, CI (GitHub Actions ranges, the nightly-ci rule with AzureCloud ranges, the no-IP launch-week rule),
  external. New installs = installation ids first seen through any install signal. People = clusters of external
  installs that share a /24 (IPv6 /64), plus the no-IP and manual-merge rules.
  `tests/test_matches_tel8w.py` checks the port against tel8w.py on a real pull (installation by installation,
  people, and the weekly / daily installs-log numbers).
- The internal / partner lists are private. They live in a root-only config file
  (`/etc/synapcores/installs-feed.json`, generated from tel8w.py with `tests/tel8w_config.py`), never in this repo.

## Files and permissions

| path | owner:group | mode | who reads it |
|---|---|---|---|
| `/opt/synapcores-installs-feed/` (this directory: script, units, docs) | root:root | 0755 / files 0644 | the units |
| `/etc/synapcores/telemetry-ingest.apikey` (exists today) | root:root | 0600 | systemd → export unit only (`LoadCredential=telemetry-apikey`) |
| `/etc/synapcores/installs-feed.salt` (HMAC salt, `openssl rand -hex 32`, generated on the host) | root:root | 0600 | systemd → export unit only (`LoadCredential=feed-salt`) |
| `/etc/synapcores/installs-feed.json` (internal / partner lists) | root:root | 0600 | systemd → export unit only (`LoadCredential=feed-config`) |
| `/var/lib/synapcores-installs-export/` (state) | bitnami:bitnami | 0700 | export + refresh units |
| `…/private/events-cache.json`, `export-state.json` (copy of the telemetry rows read so far: raw IPs) | bitnami:bitnami | 0600 | export unit only (the refresh unit has it in `InaccessiblePaths`) |
| `…/ranges/gh-actions-ranges.json`, `azure-ranges.json` (public CI ranges) | bitnami:bitnami | 0600 | export reads, refresh writes |
| `…/downloads/history.json` (public download snapshots) | bitnami:bitnami | 0600 | refresh unit |
| `/var/lib/synapcores-installs-feed/` (drop directory, `units/synapcores-installs-feed.tmpfiles.conf`) | bitnami:mktperf-app | 2750 | mktperf-app: list + read |
| `…/installs-v1.jsonl`, `…/github-downloads-v1.jsonl` | bitnami:mktperf-app | 0640 | mktperf-app: read |
| `/etc/systemd/system/synapcores-installs-{export,refresh}.{service,timer}`, `/etc/tmpfiles.d/synapcores-installs-feed.conf` | root:root | 0644 | systemd |

Why it holds:
- The export unit runs as the telemetry-ingest user (bitnami already reads the telemetry key), but with
  `NoNewPrivileges=yes` and an empty capability set, so that account's sudo is unusable inside the unit, and
  `IPAddressAllow=localhost`, so the process that holds raw IPs can't reach the internet. It can't read
  `/etc/mktperf` or `/var/lib/mktperf-app` (root 0600 / mktperf-app 0700, and `InaccessiblePaths=`), so it never
  sees the mktperf key.
- mktperf-app is not in the bitnami group and can't read `/etc/synapcores/*` or `/opt/telemetry-ingest/.env`,
  so it never sees the telemetry key or the salt. It only reads the two drop files, and its importer
  validates them again (ids, /24 format, no IP-like strings anywhere) and refuses a file that fails.
- The drop directory belongs to the writer, so the less-trusted reader can't plant symlinks or replace files.
  Files are written to a temp file in the same directory and renamed, so the reader never sees a partial file.
- Before every write the job self-checks the output for IPv4 / IPv6 address patterns; on a hit it writes
  nothing and exits 3.

## Units

| unit | when | credentials | network |
|---|---|---|---|
| `synapcores-installs-export.service` / `.timer` | `*:02/15` (every 15 min) + 3 min after boot | telemetry key, salt, config | localhost only |
| `synapcores-installs-refresh.service` / `.timer` | daily 06:40 UTC (+ 10 min after boot, catch-up after downtime) | none | api.github.com, download.microsoft.com |

The export reads `telemetry_events` incrementally: rows with `received_at` from one hour before the newest cached
row (deduplicated by `event_id`), plus a full re-read when there is no cache, once a day, when the increment is
large, or when `COUNT(*)` disagrees with the cache (deleted or late rows). The CI ranges come from the refresh
unit's caches (7-day refresh, union of every fetch, like tel8w.py); without GitHub ranges the export refuses to
run (exit 5) rather than count CI installs as external.

## Commands

```sh
# dry run: read + classify + self-check, write nothing (prints the numbers)
synapcores_installs_feed.py export --dry-run
# offline run on a JSON pull (no engine): rows from `SELECT * FROM telemetry_events`
synapcores_installs_feed.py export --input rows.json --config cfg.json --salt-file salt --state-dir S --out-dir D
# refresh only the download snapshot, or seed a baseline from a tag/asset/count TSV
synapcores_installs_feed.py refresh --skip-ranges [--seed-downloads-tsv F --seed-fetched-at 2026-11-22T01:50:00Z]
# validate drop files (exit 3 on any problem)
synapcores_installs_feed.py selfcheck /var/lib/synapcores-installs-feed/*.jsonl
```

Exit codes: 0 ok, 2 config/credentials, 3 privacy self-check failed (nothing written), 4 engine or network
error, 5 no CI ranges.

## Tests

```sh
cd ops/installs-feed && python3 -I -m unittest discover -s tests -v
# parity with tel8w.py on a real pull (private data, kept outside the repo):
TEL8W_PATH=…/tel8w.py TEL_SNAPSHOT=/tmp/…/tel.json TEL8W_RANGES_DIR=…/installs-sprint python3 -I -m unittest discover -s tests -v
```

## Rollback

```sh
sudo systemctl disable --now synapcores-installs-export.timer synapcores-installs-refresh.timer
sudo rm -f /etc/systemd/system/synapcores-installs-{export,refresh}.{service,timer} /etc/tmpfiles.d/synapcores-installs-feed.conf
sudo systemctl daemon-reload
sudo rm -rf /var/lib/synapcores-installs-export /var/lib/synapcores-installs-feed /opt/synapcores-installs-feed   # the state dir holds the raw-row cache
sudo rm -f /etc/synapcores/installs-feed.json /etc/synapcores/installs-feed.salt
```
On the app side, unset `INSTALLS_FEED_DIR` / `INSTALLS_FEED_TENANT_ID` (the page then says it isn't
configured) or roll back the release; the `pm_install_feed` table can stay (or `DELETE FROM pm_install_feed`;
no DROP, see the engine memory notes in `apps/marketing-performance/src/lib/derived-rebuild.ts`).
