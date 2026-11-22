#!/usr/bin/env python3
"""SynapCores installs feed: telemetry_events -> sanitized, one-way JSONL drop files for mktperf.

Runs on the telemetry host as two systemd units (units/):

  export   every 15 min, User=bitnami (the telemetry-ingest user). Reads telemetry_events incrementally
           from the local telemetry engine (127.0.0.1:8080, db main) with the telemetry key, classifies
           every installation with the installs-log rules (a port of the installs-sprint tel8w.py,
           2026-11-20 rules) and writes installs-v1.jsonl (FEED-FORMAT.md) into the drop directory.
           The unit may only reach localhost (IPAddressAllow=localhost).
  refresh  once a day, no telemetry key, no access to the export's private cache. Refreshes the GitHub
           Actions and Azure CI ranges (7-day union caches, like tel8w.py) and snapshots the public
           GitHub release download counters into github-downloads-v1.jsonl.

Privacy. The drop files never hold a full IP address (IPv4 /24 as "a.b.c", IPv6 /48) or a raw installation
id (HMAC-SHA256 with a salt that only this job reads). Every write is checked for IPv4/IPv6 address
patterns first; if one is found nothing is written and the job exits 3. The private state directory keeps
a copy of the telemetry rows it has read (raw IPs, same trust zone as the telemetry database), mode 0700.

Usage:
  synapcores_installs_feed.py export  [--dry-run] [--full] [--input ROWS.json] [--out-dir D] [--state-dir D]
                                       [--config F] [--salt-file F] [--key-file F] [--engine-url U] [--now T]
  synapcores_installs_feed.py refresh [--dry-run] [--force] [--skip-ranges] [--skip-downloads]
                                       [--seed-downloads-tsv F --seed-fetched-at T] [--out-dir D] [--state-dir D]
  synapcores_installs_feed.py selfcheck FILE...

Credentials and config default to $CREDENTIALS_DIRECTORY/{telemetry-apikey,feed-salt,feed-config}
(systemd LoadCredential=). Exit codes: 0 ok, 2 config/credentials, 3 privacy self-check failed,
4 engine or network error, 5 no CI ranges.
"""
import argparse
import bisect
import collections
import datetime as dt
import hashlib
import hmac
import ipaddress
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request

RULES = "2026-11-20"  # tel8w.py classification rules this port follows (new-install + nightly-ci changes)
CLASSIFIER = "tel8w-port"
FEED_FILE = "installs-v1.jsonl"
DOWNLOADS_FILE = "github-downloads-v1.jsonl"
DEFAULT_ENGINE = "http://127.0.0.1:8080"
DEFAULT_DATABASE = "main"
TABLE = "telemetry_events"
DEFAULT_STATE = "/var/lib/synapcores-installs-export"
DEFAULT_OUT = "/var/lib/synapcores-installs-feed"
UA = "synapcores-installs-feed/1"
COLUMNS = ("event_id", "installation_id", "event_type", "received_at", "ip", "deployment", "os", "architecture",
           "product_version", "country")
STARTS = {"installation_created", "instance_started"}
INSTALL_SIGNALS = ("installation_created", "instance_started", "installation_version_changed",
                   "installation_heartbeat")
EVENT_KEYS = INSTALL_SIGNALS + ("other",)
CLASS_OUT = {"person": "external", "ci": "ci", "internal": "internal", "likely-internal": "likely-internal",
             "partner": "partner", "test": "test"}
REASON_OUT = {"": None, "ops-smoke test row": "ops-smoke",
              "internal list (installation_id / IP / /24)": "internal-list",
              "likely-internal list": "likely-internal-list", "design partner /24": "partner-24",
              "later event from an internal IP or /24": "internal-later-event", "nightly-ci": "nightly-ci",
              "gh-actions-cidr": "gh-actions-cidr", "no-ip-nightly-docker": "no-ip-nightly-docker"}
NO_NET_CLASSES = {"internal", "likely-internal", "test"}  # our own networks never leave the host
RANGES_MAX_AGE = dt.timedelta(days=7)
META_KEYS = ("actions", "actions_macos")
GH_META_URL = "https://api.github.com/meta"
AZURE_URL = ("https://download.microsoft.com/download/7/1/D/71D86715-5596-4529-9B13-DA13A5DE5B63/"
             "ServiceTags_Public_{d}.json")
AZURE_TAG = "AzureCloud"
GH_RELEASES = "https://api.github.com/repos/SynapCores/synapcores-releases/releases"
GH_REPO = "SynapCores/synapcores-releases"
INCREMENTAL_OVERLAP = dt.timedelta(hours=1)
FULL_RESYNC_EVERY = dt.timedelta(hours=24)
INCR_MAX_ROWS = 5000
FULL_MAX_ROWS = 200000
MAX_ACTIVE_DAYS = 400
MAX_SNAPSHOTS = 400
DEFAULT_TEST_IID = "00000000-0000-4000-8000-00000000c0de"  # ops-smoke
DEFAULT_NIGHTLY = ("06:00", "07:30")  # recipe-cert cron 17 6 * * * -> engine events 06:26-06:58Z

TEXT_OK = re.compile(r"[A-Za-z0-9._+ -]{1,40}")
# Telemetry fields are attacker-writable (the ingest endpoint is public), so each one has a strict format; anything
# else is dropped (None). None of these can spell an IP address (no 4 digit groups, no colons).
FIELD_OK = {
    "country": re.compile(r"[A-Z]{2}"),
    "version": re.compile(r"v?[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:-[A-Za-z][A-Za-z0-9]{0,15}(?:\.[A-Za-z0-9]{1,16})?)?"),
    "word": re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,23}"),  # deployment, os, arch: docker, bare-metal, linux, x86_64
}
IPV4_ANY = re.compile(r"(?<![0-9.])[0-9]{1,3}(?:\.[0-9]{1,3}){3}(?![0-9])")
COLON_TOKEN = re.compile(r"[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*")
V6_PREFIX = 40  # IPv6 networks are written as /40: ~256 customer /48s, the same anonymity set as an IPv4 /24
NET_OK = re.compile(r"(?:[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,2}::/40)")
SIX_TO_FOUR = ipaddress.ip_network("2002::/16")  # 6to4: bits 16-47 are a full IPv4 address
NET24 = re.compile(r"[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}")
WATERMARK_OK = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\.000")
ARCHIVE_EXT = (".tar.gz", ".tgz", ".zip", ".deb", ".rpm", ".dmg", ".pkg", ".msi", ".exe")
PLATFORM = re.compile(r"(darwin|macos|linux|windows)[-_](aarch64|arm64|x86_64|amd64|x64)")


class FeedError(Exception):
    def __init__(self, msg, code=2):
        super().__init__(msg)
        self.code = code


# ---------------------------------------------------------------------------------------------------------
# time / ip helpers (same semantics as tel8w.py)
# ---------------------------------------------------------------------------------------------------------
def ts(s):
    return dt.datetime.fromisoformat(str(s).replace("Z", "+00:00").replace(" ", "T")[:19])


def utcnow():
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None, microsecond=0)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ") if t else None


def norm_ip(ip):
    """'' for missing/invalid, IPv4 for IPv4-mapped IPv6, else the canonical string."""
    if not ip:
        return ""
    try:
        a = ipaddress.ip_address(str(ip).strip())
    except ValueError:
        return ""
    if a.version == 6 and a.ipv4_mapped:
        a = a.ipv4_mapped
    return str(a)


def net_key(ip):
    """/24 as 'a.b.c'; IPv6 -> its /64 (tel8w.py clustering key)."""
    ip = norm_ip(ip)
    if not ip:
        return ""
    if ":" not in ip:
        return ".".join(ip.split(".")[:3])
    return str(ipaddress.ip_network(ip + "/64", strict=False))


def net_out(key):
    """Clustering key -> the network written to the feed: IPv4 'a.b.c' (/24), IPv6 'x:y::/40'. None if none.
    6to4 addresses (2002::/16) carry a full IPv4 address in their first 48 bits, so they become that IPv4's /24."""
    if not key or key == "no-ip":
        return None
    if ":" not in key:
        return key if NET24.fullmatch(key) else None
    n = ipaddress.ip_network(key, strict=False)
    if n.subnet_of(SIX_TO_FOUR) and n.prefixlen >= 48:
        v4 = ipaddress.IPv4Address(int(n.network_address) >> 80 & 0xFFFFFFFF)
        return ".".join(str(v4).split(".")[:3])
    n = n.supernet(new_prefix=V6_PREFIX) if n.prefixlen > V6_PREFIX else n
    out = f"{n.network_address.compressed}/{V6_PREFIX}"
    return out if n.prefixlen == V6_PREFIX and NET_OK.fullmatch(out) else None


def txt(v, kind="word"):
    """Telemetry free-text field -> value in its strict format (FIELD_OK[kind]) or None."""
    if v is None:
        return None
    s = str(v).strip()
    if not FIELD_OK[kind].fullmatch(s) or not TEXT_OK.fullmatch(s) or IPV4_ANY.search(s):
        return None
    return s


def norm_osarch(o, a):
    return {"darwin": "macos"}.get(o, o), {"arm64": "aarch64", "amd64": "x86_64"}.get(a, a)


class CidrSet:
    def __init__(self, cidrs):
        nets = []
        for c in cidrs:
            try:
                nets.append(ipaddress.ip_network(c, strict=False))
            except ValueError:
                pass
        self.iv, self.count = {}, {}
        for v in (4, 6):
            col = list(ipaddress.collapse_addresses([n for n in nets if n.version == v]))
            self.count[v] = len(col)
            self.iv[v] = ([int(n.network_address) for n in col], [int(n.broadcast_address) for n in col])

    def __contains__(self, ip):
        ip = norm_ip(ip)
        if not ip:
            return False
        a = ipaddress.ip_address(ip)
        starts, ends = self.iv[a.version]
        i = bisect.bisect_right(starts, int(a)) - 1
        return i >= 0 and ends[i] >= int(a)


def _collapse(cidrs):
    nets = []
    for c in cidrs:
        try:
            nets.append(ipaddress.ip_network(c, strict=False))
        except ValueError:
            pass
    out = []
    for v in (4, 6):
        out += [str(n) for n in ipaddress.collapse_addresses([n for n in nets if n.version == v])]
    return out


# ---------------------------------------------------------------------------------------------------------
# config (internal / partner lists; kept outside the repo, installed root-only, passed via LoadCredential)
# ---------------------------------------------------------------------------------------------------------
CONFIG_LISTS = ("internal_ip", "internal_24", "likely_internal_24", "internal_iid", "likely_internal_iid",
                "test_iid", "partner_24", "ci_extra_24")


def load_config(path):
    try:
        with open(path) as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        raise FeedError(f"config {path}: {type(e).__name__}")
    if not isinstance(raw, dict):
        raise FeedError("config: not a JSON object")
    cfg = {}
    for k in CONFIG_LISTS:
        v = raw.get(k, [])
        if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
            raise FeedError(f"config: {k} must be a list of strings")
        cfg[k] = set(v)
    if "test_iid" not in raw:
        cfg["test_iid"] = {DEFAULT_TEST_IID}
    for k in ("internal_24", "likely_internal_24", "partner_24", "ci_extra_24"):
        bad = [x for x in cfg[k] if not NET24.fullmatch(x)]
        if bad:
            raise FeedError(f"config: {k} entries must look like 'a.b.c' ({len(bad)} don't)")
    bad = [x for x in cfg["internal_ip"] if not norm_ip(x)]
    if bad:
        raise FeedError(f"config: internal_ip has {len(bad)} invalid address(es)")
    cfg["internal_ip"] = {norm_ip(x) for x in cfg["internal_ip"]}
    pm = raw.get("person_merge", [])
    if not isinstance(pm, list) or not all(isinstance(p, list) and len(p) == 2 and all(isinstance(x, str) for x in p)
                                           for p in pm):
        raise FeedError("config: person_merge must be a list of [installation_id, installation_id] pairs")
    cfg["person_merge"] = [tuple(p) for p in pm]
    win = raw.get("nightly_ci_utc", list(DEFAULT_NIGHTLY))
    try:
        lo, hi = (dt.time.fromisoformat(x) for x in win)
    except (TypeError, ValueError):
        raise FeedError("config: nightly_ci_utc must be [\"HH:MM\", \"HH:MM\"]")
    cfg["nightly_ci_utc"] = (lo, hi)
    return cfg


# ---------------------------------------------------------------------------------------------------------
# classification: port of tel8w.py classify() / cluster_people() (2026-11-20 rules)
# ---------------------------------------------------------------------------------------------------------
def nightly_docker_noip(ev, first):
    types = [e["event_type"] for e in ev]
    return ev[0].get("deployment") == "docker" and set(types) <= STARTS and len(types) <= 2 and 5 <= first.hour < 8


def nightly_ci_shape(ev, first, cfg):
    """The nightly recipe-cert install: first event inside the nightly window, Docker, created/started only,
    gone within the hour."""
    lo, hi = cfg["nightly_ci_utc"]
    return (ev[0].get("deployment") == "docker" and {e["event_type"] for e in ev} <= STARTS
            and ts(ev[-1]["received_at"]) - first <= dt.timedelta(hours=1) and lo <= first.time() < hi)


def classify(rows, cfg, ranges, azure=None):
    """-> (inst {iid: sorted events}, recs {iid: dict}). First matching rule wins, exactly as tel8w.py."""
    inst = collections.defaultdict(list)
    for r in rows:
        inst[r["installation_id"]].append(r)
    recs = {}
    for iid, ev in inst.items():
        ev.sort(key=lambda r: str(r["received_at"]))
        ips = [norm_ip(e.get("ip")) for e in ev]
        ip0 = ips[0]
        ipc = next((x for x in ips if x), "")
        k0, kc = net_key(ip0), net_key(ipc)
        keys = {net_key(x) for x in ips if x}
        first = ts(ev[0]["received_at"])
        if iid in cfg["test_iid"] or any(e.get("os") == "ops-smoke" for e in ev):
            c, why = "test", "ops-smoke test row"
        elif iid in cfg["internal_iid"] or ip0 in cfg["internal_ip"] or k0 in cfg["internal_24"]:
            c, why = "internal", "internal list (installation_id / IP / /24)"
        elif iid in cfg["likely_internal_iid"] or k0 in cfg["likely_internal_24"]:
            c, why = "likely-internal", "likely-internal list"
        elif k0 in cfg["partner_24"]:
            c, why = "partner", "design partner /24"
        elif keys & cfg["internal_24"] or any(x in cfg["internal_ip"] for x in ips):
            c, why = "internal", "later event from an internal IP or /24"
        elif ipc and nightly_ci_shape(ev, first, cfg) and (ipc in ranges or kc in cfg["ci_extra_24"] or
                                                           (azure is not None and ipc in azure)):
            c, why = "ci", "nightly-ci"
        elif ipc and (ipc in ranges or kc in cfg["ci_extra_24"]):
            c, why = "ci", "gh-actions-cidr"
        elif not ipc and nightly_docker_noip(ev, first):
            c, why = "ci", "no-ip-nightly-docker"
        else:
            c, why = "person", ""
        o, a = norm_osarch(ev[0].get("os"), ev[0].get("architecture"))
        sig = [e for e in ev if e["event_type"] in INSTALL_SIGNALS]
        recs[iid] = dict(iid=iid, c=c, why=why, first=first, last=ts(ev[-1]["received_at"]), keys=keys, key=kc,
                         dep=ev[0].get("deployment"), os=o, arch=a, ver=ev[0].get("product_version"),
                         country=ev[0].get("country"),
                         first_seen=ts(sig[0]["received_at"]) if sig else None,
                         first_type=sig[0]["event_type"] if sig else None)
    return inst, recs


def cluster_people(inst, recs, cfg):
    """-> list of person dicts sorted by first event (tel8w.py cluster_people)."""
    persons = [r for r in recs.values() if r["c"] == "person"]
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for r in persons:
        find("i:" + r["iid"])
        for k in r["keys"]:
            union("i:" + r["iid"], "n:" + k)
    for r in (r for r in persons if not r["keys"]):
        for s in persons:
            if s is not r and (s["country"], s["dep"], s["os"], s["arch"]) == (r["country"], r["dep"], r["os"], r["arch"]) \
                    and abs((s["first"] - r["first"]).total_seconds()) <= 48 * 3600:
                union("i:" + r["iid"], "i:" + s["iid"])
    for a, b in cfg["person_merge"]:
        if recs.get(a, {}).get("c") == "person" and recs.get(b, {}).get("c") == "person":
            union("i:" + a, "i:" + b)
    groups = collections.defaultdict(list)
    for r in persons:
        groups[find("i:" + r["iid"])].append(r)
    people = []
    for mem in groups.values():
        mem.sort(key=lambda r: r["first"])
        evs = sorted((e for m in mem for e in inst[m["iid"]]), key=lambda e: str(e["received_at"]))
        f = mem[0]
        first = ts(evs[0]["received_at"])
        b = next((net_key(e.get("ip")) for e in evs if norm_ip(e.get("ip"))), "")
        days = sorted({ts(e["received_at"]).date() for e in evs})
        start_days = sorted({ts(e["received_at"]).date() for e in evs if e["event_type"] in STARTS})
        later = [d for d in start_days if d > first.date()]
        vers = [e.get("product_version") for e in evs if e.get("product_version")]
        people.append(dict(b=b or "no-ip", country=f["country"], first=first, last=ts(evs[-1]["received_at"]),
                           dep=f["dep"], os=f["os"], arch=f["arch"], ver=f["ver"], latest_ver=vers[-1] if vers else None,
                           iids=[m["iid"] for m in mem], days=days, returned=bool(later)))
    people.sort(key=lambda p: p["first"])
    return people


# ---------------------------------------------------------------------------------------------------------
# sanitized feed
# ---------------------------------------------------------------------------------------------------------
def hid(salt, kind, value):
    return hmac.new(salt, f"{kind}:{value}".encode(), hashlib.sha256).hexdigest()[:32]


def salt_id(salt):
    return hashlib.sha256(salt).hexdigest()[:8]


def build_feed(rows, cfg, ranges, azure, salt, now, ranges_meta=None):
    """-> (header, installation lines, person lines, stats). Pure: no I/O."""
    rows = sorted(rows, key=lambda r: (str(r["received_at"]), str(r.get("event_id") or "")))
    inst, recs = classify(rows, cfg, ranges, azure)
    people = cluster_people(inst, recs, cfg)
    week = now - dt.timedelta(days=7)
    pid_of, person_lines = {}, []
    for p in people:
        pid = "p_" + hid(salt, "person", p["iids"][0])
        for iid in p["iids"]:
            pid_of[iid] = pid
        person_lines.append({
            "type": "person", "id": pid, "first_seen": iso(p["first"]), "last_seen": iso(p["last"]),
            "installs": len(p["iids"]), "country": txt(p["country"], "country"), "net": net_out(p["b"]),
            "deployment": txt(p["dep"]), "os": txt(p["os"]), "arch": txt(p["arch"]),
            "first_version": txt(p["ver"], "version"), "version": txt(p["latest_ver"], "version"),
            "active_days": [d.isoformat() for d in p["days"]][-MAX_ACTIVE_DAYS:], "returned": p["returned"]})
    inst_lines, skipped = [], 0
    for iid, r in sorted(recs.items(), key=lambda kv: (kv[1]["first"], kv[0])):
        if r["first_seen"] is None:  # no install signal at all: never a new install (tel8w.py), so not listed
            skipped += 1
            continue
        ev = inst[iid]
        counts = {k: 0 for k in EVENT_KEYS}
        for e in ev:
            counts[e["event_type"] if e["event_type"] in INSTALL_SIGNALS else "other"] += 1
        vers = [e.get("product_version") for e in ev if e.get("product_version")]
        cls = CLASS_OUT[r["c"]]
        inst_lines.append({
            "type": "installation", "id": "i_" + hid(salt, "installation", iid), "person": pid_of.get(iid),
            "class": cls, "reason": REASON_OUT[r["why"]], "first_seen": iso(r["first_seen"]),
            "last_seen": iso(r["last"]), "events": counts,
            "version": txt(vers[-1] if vers else None, "version"),
            "first_version": txt(vers[0] if vers else None, "version"),
            "deployment": txt(r["dep"]), "os": txt(r["os"]), "arch": txt(r["arch"]),
            "country": txt(r["country"], "country"),
            "net": None if cls in NO_NET_CLASSES else net_out(r["key"]),
            "active_days": sorted({ts(e["received_at"]).date().isoformat() for e in ev})[-MAX_ACTIVE_DAYS:],
            "new_7d": r["first_seen"] >= week, "active_7d": r["last"] >= week})
    rm = ranges_meta or {}
    header = {
        "type": "header", "schema": "synapcores-installs-feed", "version": 1, "generated_at": iso(now),
        "source": {"rows": len(rows), "installations": len(recs),
                   "max_received_at": iso(max((ts(r["received_at"]) for r in rows), default=None))},
        "classifier": {"name": CLASSIFIER, "rules": RULES, "gh_ranges_fetched_at": rm.get("gh"),
                       "azure_ranges_fetched_at": rm.get("azure")},
        "counts": {"installation": len(inst_lines), "person": len(person_lines)},
        "salt_id": salt_id(salt)}
    stats = dict(classes=collections.Counter(CLASS_OUT[r["c"]] for r in recs.values()), people=len(people),
                 skipped_no_signal=skipped)
    return header, inst_lines, person_lines, stats


def serialize(header, *groups):
    lines = [json.dumps(header, separators=(",", ":"))]
    for g in groups:
        lines += [json.dumps(x, separators=(",", ":")) for x in g]
    return ("\n".join(lines) + "\n").encode("ascii")


def ip_leaks(obj, path="$"):
    """Paths of string values that hold an IP address (anything but a valid 'net' prefix). [] = clean."""
    out = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "net" and isinstance(v, str):
                if not NET_OK.fullmatch(v):
                    out.append(f"{path}.{k}")
                continue
            if isinstance(k, str) and (IPV4_ANY.search(k) or _has_ipv6(k)):
                out.append(f"{path}.<key>")
            out += ip_leaks(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out += ip_leaks(v, f"{path}[{i}]")
    elif isinstance(obj, str):
        if IPV4_ANY.search(obj) or _has_ipv6(obj):
            out.append(path)
    return out


def _has_ipv6(s):
    for tok in COLON_TOKEN.findall(s):
        for cand in {tok, tok.strip(":."), tok.split("/")[0]}:
            try:
                ipaddress.IPv6Address(cand)
                return True
            except ValueError:
                pass
    return False


def selfcheck_bytes(data, kind=None):
    """Validate a drop file: JSON lines, header counts, id formats, no IP leaks. -> list of problems."""
    problems = []
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError:
        return ["not ASCII"]
    lines = text.splitlines()
    if not lines:
        return ["empty file"]
    objs = []
    for n, line in enumerate(lines, 1):
        try:
            objs.append(json.loads(line))
        except ValueError:
            problems.append(f"line {n}: not JSON")
    if problems:
        return problems
    head = objs[0]
    if head.get("type") != "header":
        return ["line 1: not a header"]
    schema = head.get("schema")
    if kind and schema != kind:
        problems.append(f"header: schema {schema!r}, expected {kind!r}")
    counts = collections.Counter(o.get("type") for o in objs[1:])
    if dict(counts) != {k: v for k, v in (head.get("counts") or {}).items() if v}:
        problems.append(f"header counts {head.get('counts')} != lines {dict(counts)}")
    idre = {"installation": re.compile(r"i_[0-9a-f]{32}"), "person": re.compile(r"p_[0-9a-f]{32}")}
    for n, o in enumerate(objs[1:], 2):
        t = o.get("type")
        if t in idre and not idre[t].fullmatch(str(o.get("id"))):
            problems.append(f"line {n}: bad {t} id")
        if t == "installation" and o.get("person") is not None and not idre["person"].fullmatch(str(o["person"])):
            problems.append(f"line {n}: bad person ref")
    for n, o in enumerate(objs, 1):
        for p in ip_leaks(o):
            problems.append(f"line {n}: IP-like value at {p}")
    if IPV4_ANY.search(text):
        problems.append("raw text matches an IPv4 address pattern")
    return problems


def write_atomic(path, data, mode=0o640):
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:
        dfd = os.open(d, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass
    st, dst = os.stat(path), os.stat(d)
    if st.st_gid != dst.st_gid:
        print(f"WARNING: {os.path.basename(path)} group {st.st_gid} != directory group {dst.st_gid} "
              f"(is the drop directory setgid?)", file=sys.stderr)


def write_json_private(path, obj):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    write_atomic(path, json.dumps(obj, separators=(",", ":")).encode(), mode=0o600)


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


# ---------------------------------------------------------------------------------------------------------
# engine access (localhost only) + incremental sync
# ---------------------------------------------------------------------------------------------------------
class Engine:
    def __init__(self, url, key, database=DEFAULT_DATABASE, timeout=60):
        self.url, self.key, self.database, self.timeout = url.rstrip("/"), key, database, timeout
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # never via a proxy
        self.queries = 0

    def query(self, sql, max_rows=None):
        body = {"database": self.database, "sql": sql}
        if max_rows:
            body["max_rows"] = max_rows
        req = urllib.request.Request(self.url + "/v1/query/execute", data=json.dumps(body).encode(), method="POST",
                                     headers={"Authorization": f"ApiKey {self.key}", "Content-Type": "application/json",
                                              "User-Agent": UA})
        self.queries += 1
        try:
            with self.opener.open(req, timeout=self.timeout) as r:
                doc = json.load(r)
        except urllib.error.HTTPError as e:
            raise FeedError(f"engine HTTP {e.code}", 4)
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise FeedError(f"engine unreachable or bad response ({type(e).__name__})", 4)
        if isinstance(doc, dict) and doc.get("error"):
            err = doc["error"]
            raise FeedError(f"engine error {err.get('code') if isinstance(err, dict) else ''}".strip(), 4)
        data = doc.get("data", doc) if isinstance(doc, dict) else {}
        cols = [c.get("name") if isinstance(c, dict) else str(c) for c in (data.get("columns") or [])]
        return [dict(zip(cols, r)) if isinstance(r, list) else r for r in (data.get("rows") or [])]


def clean_row(r):
    """Keep the columns the classifier needs; None for rows it can't use."""
    if not isinstance(r, dict):
        return None
    out = {k: r.get(k) for k in COLUMNS}
    iid, et = out["installation_id"], out["event_type"]
    if not isinstance(iid, str) or not iid or len(iid) > 128 or not isinstance(et, str) or not et:
        return None
    try:
        ts(out["received_at"])
    except (TypeError, ValueError):
        return None
    if not out["event_id"]:
        out["event_id"] = "h:" + hashlib.sha256(json.dumps(out, sort_keys=True, default=str).encode()).hexdigest()[:32]
    return out


def sync_rows(engine, cache, state, now, full=False):
    """Bring the private row cache up to date. Incremental by received_at (TEXT 'YYYY-MM-DD HH:MM:SS.mmm' on the
    engine, so the watermark uses the same format) with a 1 h overlap and dedupe by event_id; a full re-read
    when there is no cache, once a day, when the increment is too big, or when COUNT(*) disagrees with the cache
    (deleted or late rows). -> (cache, info)."""
    cols = ", ".join(COLUMNS)
    info = {"bad_rows": 0}
    last_full = state.get("last_full_sync")
    why = ("--full" if full else "no cache" if not cache else "no full sync yet" if not last_full
           else "daily full sync" if now - ts(last_full) >= FULL_RESYNC_EVERY else None)
    if why is None:
        mx = max(ts(r["received_at"]) for r in cache.values())
        wm = (mx - INCREMENTAL_OVERLAP).strftime("%Y-%m-%d %H:%M:%S.000")
        if not WATERMARK_OK.fullmatch(wm):  # it goes into the SQL text: only our own fixed format
            raise FeedError("internal error: bad watermark", 4)
        got = engine.query(f"SELECT {cols} FROM {TABLE} WHERE received_at >= '{wm}'", max_rows=INCR_MAX_ROWS)
        if len(got) >= INCR_MAX_ROWS:
            why = "increment hit max_rows"
        else:
            added = 0
            for r in got:
                c = clean_row(r)
                if c is None:
                    info["bad_rows"] += 1
                    continue
                added += c["event_id"] not in cache
                cache[c["event_id"]] = c
            n = engine.query(f"SELECT COUNT(*) AS n FROM {TABLE}")
            total = int(n[0]["n"]) if n else -1
            expected = len(cache) + int(state.get("unusable_rows") or 0)
            if total != expected:  # deleted, late or new unusable rows: re-read everything
                why = f"count mismatch (engine {total}, expected {expected})"
            else:
                info.update(mode="incremental", watermark=wm, fetched=len(got), added=added)
    if why is not None:
        got = engine.query(f"SELECT {cols} FROM {TABLE}", max_rows=FULL_MAX_ROWS)
        if len(got) >= FULL_MAX_ROWS:
            raise FeedError(f"full read returned {len(got)} rows = max_rows; raise FULL_MAX_ROWS", 4)
        cache = {}
        info["bad_rows"] = 0
        for r in got:
            c = clean_row(r)
            if c is None:
                info["bad_rows"] += 1
                continue
            cache[c["event_id"]] = c
        state["last_full_sync"] = iso(now)
        state["unusable_rows"] = len(got) - len(cache)  # unusable rows + duplicate event_ids
        info.update(mode="full", why=why, fetched=len(got), added=None)
    return cache, info


# ---------------------------------------------------------------------------------------------------------
# CI ranges (GitHub Actions + Azure), union caches like tel8w.py
# ---------------------------------------------------------------------------------------------------------
def ranges_paths(state_dir):
    d = os.path.join(state_dir, "ranges")
    return os.path.join(d, "gh-actions-ranges.json"), os.path.join(d, "azure-ranges.json")


def load_ranges(state_dir):
    """-> (gh CidrSet, azure CidrSet or None, {gh: fetched_at, azure: fetched_at}). FeedError 5 without GitHub ranges:
    without them CI installs would be counted as external."""
    ghp, azp = ranges_paths(state_dir)
    gh, az = read_json(ghp), read_json(azp)
    if not gh or not gh.get("union"):
        raise FeedError(f"no GitHub Actions ranges at {ghp}; run `refresh` or install the seed caches", 5)
    meta = {"gh": gh.get("fetched_at"), "azure": az.get("fetched_at") if az else None}
    return CidrSet(gh["union"]), (CidrSet(az["union"]) if az and az.get("union") else None), meta


def _get_json(url, timeout, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def refresh_gh_ranges(path, now, force=False, timeout=30):
    cache = read_json(path)
    if cache and not force and now - ts(cache["fetched_at"]) <= RANGES_MAX_AGE:
        return cache, f"github ranges fresh (fetched {cache['fetched_at']})", False
    meta = _get_json(GH_META_URL, timeout, {"Accept": "application/vnd.github+json"})
    if not meta.get("actions"):
        raise ValueError("api.github.com/meta has no actions ranges")
    latest = {k: sorted(set(meta.get(k) or [])) for k in META_KEYS}
    hist = (cache or {}).get("history", []) + [dict(fetched_at=iso(now), source=GH_META_URL,
                                                     **{f"n_{k}": len(v) for k, v in latest.items()})]
    new = dict(about="GitHub Actions runner ranges for the installs feed CI rule. 'union' = every range seen in any "
                     "fetch (classification uses it); 'latest' = the last fetch.",
               source=GH_META_URL, fetched_at=iso(now), keys=list(META_KEYS), latest=latest,
               union=_collapse((cache or {}).get("union", []) + [c for k in META_KEYS for c in latest[k]]),
               history=hist[-60:])
    return new, f"github ranges refreshed ({len(new['union'])} CIDRs)", True


def refresh_azure_ranges(path, now, force=False, timeout=60):
    cache = read_json(path)
    if cache and not force and now - ts(cache["fetched_at"]) <= RANGES_MAX_AGE:
        return cache, f"azure ranges fresh (fetched {cache['fetched_at']})", False
    errs = []
    monday = now.date() - dt.timedelta(days=now.weekday())
    for k in range(6):  # published weekly, sometimes a few days late
        d = monday - dt.timedelta(weeks=k)
        url = AZURE_URL.format(d=f"{d:%Y%m%d}")
        try:
            st = _get_json(url, timeout)
            tag = next(v for v in st["values"] if v.get("name") == AZURE_TAG)
            prefixes = sorted(set(tag["properties"]["addressPrefixes"]))
        except Exception as e:  # 404 for a Monday not published yet, offline, DNS
            errs.append(f"{d:%Y%m%d} {type(e).__name__}")
            continue
        hist = (cache or {}).get("history", []) + [dict(fetched_at=iso(now), source=url,
                                                         change_number=st.get("changeNumber"), n_prefixes=len(prefixes))]
        new = dict(about=f"Microsoft {AZURE_TAG} service-tag ranges for the nightly-ci rule. 'union' = every range "
                         "seen in any fetch.", source=url, fetched_at=iso(now), change_number=st.get("changeNumber"),
                   union=_collapse((cache or {}).get("union", []) + prefixes), history=hist[-60:])
        return new, f"azure ranges refreshed ({len(new['union'])} CIDRs)", True
    raise ValueError("no Azure service tags file: " + "; ".join(errs))


# ---------------------------------------------------------------------------------------------------------
# GitHub release downloads (public counters, once a day)
# ---------------------------------------------------------------------------------------------------------
def is_archive(name):
    n = name.lower()
    return n.endswith(ARCHIVE_EXT) and not n.endswith(".sha256")


def platform_of(name):
    m = PLATFORM.search(name.lower())
    if not m:
        return "other"
    o = {"macos": "darwin"}.get(m.group(1), m.group(1))
    a = {"arm64": "aarch64", "amd64": "x86_64", "x64": "x86_64"}.get(m.group(2), m.group(2))
    return f"{o}-{a}"


def make_snapshot(assets, fetched_at, latest_tag):
    """assets: [(tag, asset name, download_count)] -> snapshot line (aggregates only, no asset names)."""
    arch = [(t, n, c) for t, n, c in assets if is_archive(n)]
    plat = collections.Counter()
    for _, n, c in arch:
        plat[platform_of(n)] += c
    return {"type": "snapshot", "date": fetched_at.date().isoformat(), "fetched_at": iso(fetched_at),
            "archives": sum(c for _, _, c in arch), "all_assets": sum(c for _, _, c in assets),
            "by_platform": dict(sorted(plat.items())), "latest_release": txt(latest_tag, "version"),
            "latest_archives": sum(c for t, _, c in arch if t == latest_tag)}


def fetch_release_assets(timeout=30):
    rels = []
    for page in range(1, 11):
        batch = _get_json(f"{GH_RELEASES}?per_page=100&page={page}", timeout,
                          {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
        if not isinstance(batch, list):
            raise ValueError("unexpected releases payload")
        rels += batch
        if len(batch) < 100:
            break
    rels = [r for r in rels if not r.get("draft")]
    assets = [(str(r.get("tag_name")), str(a.get("name")), int(a.get("download_count") or 0))
              for r in rels for a in (r.get("assets") or [])]
    stable = sorted((r for r in rels if not r.get("prerelease")), key=lambda r: str(r.get("published_at") or ""),
                    reverse=True)
    return assets, (str(stable[0]["tag_name"]) if stable else None)


def read_seed_tsv(path):
    """Baseline file 'tag<TAB>asset<TAB>count' (newest release first) -> (assets, latest tag)."""
    assets = []
    with open(path) as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) == 3 and parts[2].strip().isdigit():
                assets.append((parts[0], parts[1], int(parts[2])))
    if not assets:
        raise FeedError(f"seed {path}: no rows")
    return assets, assets[0][0]


def add_snapshot(history, snap):
    """One snapshot per UTC date: the first fetch of the day is kept, so the series stays ~24 h apart."""
    if any(s["date"] == snap["date"] for s in history):
        return history, False
    return sorted(history + [snap], key=lambda s: s["date"])[-MAX_SNAPSHOTS:], True


def downloads_file(history, now):
    header = {"type": "header", "schema": "synapcores-github-downloads", "version": 1, "generated_at": iso(now),
              "repo": GH_REPO, "counts": {"snapshot": len(history)}}
    return serialize(header, history)


# ---------------------------------------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------------------------------------
CRED_FLAGS = {"feed-config": "--config", "feed-salt": "--salt-file", "telemetry-apikey": "--key-file"}


def cred_path(explicit, name):
    if explicit:
        return explicit
    d = os.environ.get("CREDENTIALS_DIRECTORY")
    if not d:
        raise FeedError(f"no {CRED_FLAGS[name]} and no $CREDENTIALS_DIRECTORY (run under systemd LoadCredential= "
                        f"or pass the file)")
    return os.path.join(d, name)


def read_secret(path, what, min_len=16):
    try:
        with open(path, "rb") as f:
            v = f.read().strip()
    except OSError as e:
        raise FeedError(f"{what}: cannot read ({type(e).__name__})")
    if len(v) < min_len:
        raise FeedError(f"{what}: too short")
    return v


def summarize(header, inst_lines, person_lines, now):
    m30, w = now - dt.timedelta(days=30), now - dt.timedelta(days=7)
    ext = [x for x in inst_lines if x["class"] == "external"]
    new30 = sum(1 for x in ext if ts(x["first_seen"]) >= m30)
    ppl30 = sum(1 for p in person_lines if ts(p["first_seen"]) >= m30)
    act7 = sum(1 for x in ext if ts(x["last_seen"]) >= w)
    pact7 = sum(1 for p in person_lines if ts(p["last_seen"]) >= w)
    part7 = sum(1 for x in inst_lines if x["class"] == "partner" and ts(x["last_seen"]) >= w)
    return (f"last 30 d: {new30} new external install(s), {ppl30} new people; last 7 d active: {act7} external "
            f"install(s), {pact7} people, {part7} partner install(s)")


def cmd_export(a):
    now = ts(a.now) if a.now else utcnow()
    cfg = load_config(cred_path(a.config, "feed-config"))
    salt = read_secret(cred_path(a.salt_file, "feed-salt"), "salt", min_len=32)
    state_dir = a.state_dir or os.environ.get("STATE_DIRECTORY", "").split(":")[0] or DEFAULT_STATE
    priv = os.path.join(state_dir, "private")
    cache_path, state_path = os.path.join(priv, "events-cache.json"), os.path.join(priv, "export-state.json")
    state = read_json(state_path, {}) or {}
    if a.input:
        with open(a.input) as f:
            raw = json.load(f)
        rows = [c for c in (clean_row(r) for r in raw) if c]
        info = {"mode": "input file", "fetched": len(raw), "bad_rows": len(raw) - len(rows)}
        cache = None
    else:
        key = read_secret(cred_path(a.key_file, "telemetry-apikey"), "telemetry key").decode()
        engine = Engine(a.engine_url, key, a.database)
        cache = {r["event_id"]: r for r in (read_json(cache_path, []) or [])}
        cache, info = sync_rows(engine, cache, state, now, full=a.full)
        rows = list(cache.values())
        info["queries"] = engine.queries
    ranges, azure, rmeta = load_ranges(state_dir)
    header, inst_lines, person_lines, stats = build_feed(rows, cfg, ranges, azure, salt, now, rmeta)
    data = serialize(header, inst_lines, person_lines)
    problems = selfcheck_bytes(data, "synapcores-installs-feed")
    cls = ", ".join(f"{k} {v}" for k, v in sorted(stats["classes"].items()))
    src = f"{info['mode']}: {info['fetched']} fetched" + (f", {info['added']} new" if info.get("added") is not None else "") \
        + (f" ({info['why']})" if info.get("why") else "") + (f", {info['bad_rows']} unusable" if info.get("bad_rows") else "")
    print(f"installs-feed export: {len(rows)} rows ({src}); {header['source']['installations']} installations "
          f"({cls}); {stats['people']} people; {summarize(header, inst_lines, person_lines, now)}")
    if problems:
        print("PRIVACY SELF-CHECK FAILED, nothing written: " + "; ".join(problems[:10]), file=sys.stderr)
        return 3
    out = os.path.join(a.out_dir, FEED_FILE)
    sha = hashlib.sha256(data).hexdigest()
    if a.dry_run:
        print(f"dry run: self-check passed; would write {out} ({len(data)} bytes, sha256 {sha[:12]}); nothing written")
        return 0
    write_atomic(out, data, 0o640)
    if cache is not None:
        write_json_private(cache_path, list(cache.values()))
        state.update(last_run=iso(now), last_rows=len(rows), last_sha256=sha)
        write_json_private(state_path, state)
    print(f"wrote {out} ({len(data)} bytes, sha256 {sha[:12]})")
    return 0


def cmd_refresh(a):
    now = ts(a.now) if a.now else utcnow()
    state_dir = a.state_dir or os.environ.get("STATE_DIRECTORY", "").split(":")[0] or DEFAULT_STATE
    rc = 0
    if not a.skip_ranges:
        ghp, azp = ranges_paths(state_dir)
        for name, fn, path in (("github", refresh_gh_ranges, ghp), ("azure", refresh_azure_ranges, azp)):
            try:
                new, msg, changed = fn(path, now, force=a.force)
                print(msg)
                if changed and not a.dry_run:
                    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
                    write_atomic(path, json.dumps(new, indent=0).encode(), 0o600)
            except Exception as e:  # keep the old cache (union policy); classification keeps working
                print(f"WARNING: {name} ranges refresh failed ({type(e).__name__}); keeping the cached copy",
                      file=sys.stderr)
                rc = 4
    if not a.skip_downloads:
        hpath = os.path.join(state_dir, "downloads", "history.json")
        history = read_json(hpath, []) or []
        changed = False
        if a.seed_downloads_tsv:
            if not a.seed_fetched_at:
                raise FeedError("--seed-downloads-tsv needs --seed-fetched-at YYYY-MM-DDTHH:MM:SSZ")
            assets, latest = read_seed_tsv(a.seed_downloads_tsv)
            history, added = add_snapshot(history, make_snapshot(assets, ts(a.seed_fetched_at), latest))
            changed |= added
            print(f"seed snapshot {ts(a.seed_fetched_at):%Y-%m-%d}: " + ("added" if added else "already present"))
        today = now.date().isoformat()
        if a.force or not any(s["date"] == today for s in history):
            try:
                assets, latest = fetch_release_assets()
                snap = make_snapshot(assets, now, latest)
                if a.force:
                    history = [s for s in history if s["date"] != today]
                history, added = add_snapshot(history, snap)
                changed |= added
                print(f"github downloads {today}: archives {snap['archives']}, all assets {snap['all_assets']}, "
                      f"latest {snap['latest_release']} ({snap['latest_archives']} archive downloads)")
            except Exception as e:
                print(f"WARNING: GitHub release fetch failed ({type(e).__name__}); next run retries", file=sys.stderr)
                rc = 4
        else:
            print(f"github downloads {today}: already snapshotted today")
        data = downloads_file(history, now)
        problems = selfcheck_bytes(data, "synapcores-github-downloads")
        if problems:
            print("PRIVACY SELF-CHECK FAILED, nothing written: " + "; ".join(problems[:10]), file=sys.stderr)
            return 3
        if a.dry_run:
            print(f"dry run: would write {DOWNLOADS_FILE} with {len(history)} snapshot(s); nothing written")
        else:
            if changed:
                write_json_private(hpath, history)
            out = os.path.join(a.out_dir, DOWNLOADS_FILE)
            if changed or not os.path.exists(out):
                write_atomic(out, data, 0o640)
                print(f"wrote {out} ({len(history)} snapshot(s))")
    return rc


def cmd_selfcheck(a):
    rc = 0
    for p in a.files:
        with open(p, "rb") as f:
            data = f.read()
        probs = selfcheck_bytes(data)
        print(f"{p}: " + ("OK" if not probs else "FAILED: " + "; ".join(probs[:20])))
        rc = rc or (3 if probs else 0)
    return rc


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="telemetry_events -> installs-v1.jsonl")
    e.add_argument("--dry-run", action="store_true", help="read + classify + self-check, write nothing")
    e.add_argument("--full", action="store_true", help="full re-read instead of incremental")
    e.add_argument("--input", help="rows from a JSON file instead of the engine (tests, offline runs)")
    e.add_argument("--engine-url", default=DEFAULT_ENGINE)
    e.add_argument("--database", default=DEFAULT_DATABASE)
    e.add_argument("--key-file")
    e.add_argument("--salt-file")
    e.add_argument("--config")
    e.add_argument("--now", help=argparse.SUPPRESS)
    r = sub.add_parser("refresh", help="CI ranges + GitHub release download snapshot (network, no telemetry key)")
    r.add_argument("--dry-run", action="store_true")
    r.add_argument("--force", action="store_true", help="refetch even if fresh / already snapshotted today")
    r.add_argument("--skip-ranges", action="store_true")
    r.add_argument("--skip-downloads", action="store_true")
    r.add_argument("--seed-downloads-tsv", help="add a baseline snapshot from a tag/asset/count TSV")
    r.add_argument("--seed-fetched-at", help="when the seed TSV was taken, YYYY-MM-DDTHH:MM:SSZ")
    r.add_argument("--now", help=argparse.SUPPRESS)
    for p in (e, r):
        p.add_argument("--state-dir")
        p.add_argument("--out-dir", default=DEFAULT_OUT)
    s = sub.add_parser("selfcheck", help="validate drop files (no IPs, ids, header counts)")
    s.add_argument("files", nargs="+")
    a = ap.parse_args(argv)
    try:
        return {"export": cmd_export, "refresh": cmd_refresh, "selfcheck": cmd_selfcheck}[a.cmd](a)
    except FeedError as ex:
        print(f"ERROR: {ex}", file=sys.stderr)
        return ex.code


if __name__ == "__main__":
    sys.exit(main())
