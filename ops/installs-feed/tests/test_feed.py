"""Unit tests for the installs feed export job. Synthetic data only (RFC 5737 / RFC 3849 documentation networks).

  cd ops/installs-feed && python3 -I -m unittest discover -s tests -v
"""
import datetime as dt
import json
import os
import stat
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import synapcores_installs_feed as F  # noqa: E402

GH = F.CidrSet(["192.0.2.0/24", "2001:db8:aaaa::/48"])  # stands in for the GitHub Actions ranges
AZ = F.CidrSet(["198.51.100.0/24"])  # stands in for AzureCloud
SALT = b"0123456789abcdef0123456789abcdef-test-salt"
NOW = dt.datetime(2026, 11, 22, 12, 0, 0)

_n = [0]


def wjson(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f)


def wtext(path, s):
    with open(path, "w") as f:
        f.write(s)


def rbytes(path):
    with open(path, "rb") as f:
        return f.read()


def ev(iid, t, et="instance_started", ip=None, dep="docker", os_="linux", arch="x86_64", ver="2.5.1-ce", country="US"):
    _n[0] += 1
    return {"event_id": f"e{_n[0]:05d}", "installation_id": iid, "event_type": et, "received_at": t, "ip": ip,
            "deployment": dep, "os": os_, "architecture": arch, "product_version": ver, "country": country}


def cfg(**over):
    base = {"internal_ip": {"203.0.113.7"}, "internal_24": {"100.100.14"}, "likely_internal_24": {"100.100.15"},
            "internal_iid": {"iid-internal"}, "likely_internal_iid": set(), "test_iid": {F.DEFAULT_TEST_IID},
            "partner_24": {"100.64.9"}, "ci_extra_24": set(), "person_merge": [],
            "nightly_ci_utc": (dt.time(6, 0), dt.time(7, 30))}
    base.update(over)
    return base


def classes(rows, c=None, azure=AZ):
    _, recs = F.classify(rows, c or cfg(), GH, azure)
    return {k: (v["c"], v["why"]) for k, v in recs.items()}


class ClassifyRules(unittest.TestCase):
    def test_test_rows(self):
        r = classes([ev("a", "2026-11-01 10:00:00.000", os_="ops-smoke", arch="none"),
                     ev(F.DEFAULT_TEST_IID, "2026-11-01 10:00:00.000", ip="100.70.1.1")])
        self.assertEqual(r["a"][0], "test")
        self.assertEqual(r[F.DEFAULT_TEST_IID][0], "test")

    def test_internal_lists(self):
        r = classes([ev("iid-internal", "2026-11-01 10:00:00.000", ip="100.70.1.1"),
                     ev("by-ip", "2026-11-01 10:00:00.000", ip="203.0.113.7"),
                     ev("by-24", "2026-11-01 10:00:00.000", ip="100.100.14.99")])
        self.assertEqual({k: v[0] for k, v in r.items()}, {"iid-internal": "internal", "by-ip": "internal",
                                                            "by-24": "internal"})
        self.assertEqual(r["by-24"][1], "internal list (installation_id / IP / /24)")

    def test_same_24_other_host_is_not_internal_ip(self):
        r = classes([ev("x", "2026-11-01 10:00:00.000", ip="203.0.113.8")])  # only .7 is listed
        self.assertEqual(r["x"][0], "person")

    def test_likely_internal_and_partner(self):
        r = classes([ev("li", "2026-11-01 10:00:00.000", ip="100.100.15.4"),
                     ev("pa", "2026-11-01 10:00:00.000", ip="100.64.9.20")])
        self.assertEqual(r["li"][0], "likely-internal")
        self.assertEqual(r["pa"], ("partner", "design partner /24"))

    def test_internal_from_later_event(self):
        r = classes([ev("late", "2026-11-01 10:00:00.000", ip=None),
                     ev("late", "2026-11-02 10:00:00.000", et="installation_heartbeat", ip="100.100.14.5")])
        self.assertEqual(r["late"], ("internal", "later event from an internal IP or /24"))

    def test_nightly_ci_uses_azure_only_inside_the_window(self):
        rows = [ev("n1", "2026-11-03 06:30:00.000", et="installation_created", ip="198.51.100.10"),
                ev("n1", "2026-11-03 06:30:01.000", ip="198.51.100.10"),
                ev("day", "2026-11-03 12:30:00.000", et="installation_created", ip="198.51.100.11"),
                ev("day", "2026-11-03 12:30:01.000", ip="198.51.100.11")]
        r = classes(rows)
        self.assertEqual(r["n1"], ("ci", "nightly-ci"))
        self.assertEqual(r["day"][0], "person")  # a real user on an Azure VM stays a person
        r = classes(rows, azure=None)  # no Azure ranges: the nightly rule falls back to GitHub ranges only
        self.assertEqual(r["n1"][0], "person")

    def test_nightly_shape_needs_short_life(self):
        r = classes([ev("long", "2026-11-03 06:30:00.000", ip="198.51.100.10"),
                     ev("long", "2026-11-03 08:30:00.000", ip="198.51.100.10")])
        self.assertEqual(r["long"][0], "person")

    def test_gh_actions_any_time_ipv4_and_ipv6(self):
        r = classes([ev("g4", "2026-11-03 15:00:00.000", ip="192.0.2.50"),
                     ev("g6", "2026-11-03 15:00:00.000", ip="2001:db8:aaaa:1::5")])
        self.assertEqual(r["g4"], ("ci", "gh-actions-cidr"))
        self.assertEqual(r["g6"], ("ci", "gh-actions-cidr"))

    def test_first_non_empty_ip_decides_ci(self):
        r = classes([ev("c", "2026-11-03 15:00:00.000", ip=None),
                     ev("c", "2026-11-03 15:00:05.000", ip="192.0.2.51")])
        self.assertEqual(r["c"][0], "ci")

    def test_no_ip_nightly_docker(self):
        r = classes([ev("q", "2026-07-30 06:10:00.000", et="installation_created"),
                     ev("q", "2026-07-30 06:10:01.000"),
                     ev("p", "2026-07-30 13:10:00.000", et="installation_created")])
        self.assertEqual(r["q"], ("ci", "no-ip-nightly-docker"))
        self.assertEqual(r["p"][0], "person")

    def test_rule_order_internal_beats_ci(self):
        r = classes([ev("z", "2026-11-03 15:00:00.000", ip="192.0.2.52"),
                     ev("z", "2026-11-04 15:00:00.000", ip="100.100.14.1")])
        self.assertEqual(r["z"], ("internal", "later event from an internal IP or /24"))


class People(unittest.TestCase):
    def test_clusters(self):
        rows = [ev("a", "2026-11-01 10:00:00.000", ip="100.80.1.1"),
                ev("b", "2026-11-05 10:00:00.000", ip="100.80.1.2"),  # same /24 as a
                ev("b", "2026-11-06 10:00:00.000", ip="100.81.7.7"),
                ev("c", "2026-11-07 10:00:00.000", ip="100.81.7.8"),  # joins via b's second /24
                ev("d", "2026-11-01 11:00:00.000", ip=None, country="US"),  # no IP, same shape within 48 h -> a
                ev("e", "2026-11-09 10:00:00.000", ip="100.90.1.1"),
                ev("f", "2026-11-10 10:00:00.000", ip="100.91.1.1")]
        c = cfg(person_merge=[("e", "f")])
        inst, recs = F.classify(rows, c, GH, AZ)
        people = F.cluster_people(inst, recs, c)
        groups = sorted(sorted(p["iids"]) for p in people)
        self.assertEqual(groups, [["a", "b", "c", "d"], ["e", "f"]])
        p0 = next(p for p in people if "a" in p["iids"])
        self.assertEqual(p0["b"], "100.80.1")
        self.assertEqual(p0["first"], dt.datetime(2026, 11, 1, 10, 0, 0))

    def test_returned_means_started_on_a_later_day(self):
        rows = [ev("a", "2026-11-01 10:00:00.000", ip="100.80.1.1"),
                ev("a", "2026-11-02 10:00:00.000", et="installation_heartbeat", ip="100.80.1.1"),
                ev("b", "2026-11-01 10:00:00.000", ip="100.82.1.1"),
                ev("b", "2026-11-03 10:00:00.000", ip="100.82.1.1")]
        inst, recs = F.classify(rows, cfg(), GH, AZ)
        people = {p["iids"][0]: p for p in F.cluster_people(inst, recs, cfg())}
        self.assertFalse(people["a"]["returned"])  # a heartbeat is not a new start
        self.assertTrue(people["b"]["returned"])


def sample_rows():
    return [
        ev("ext-1", "2026-11-20 09:00:00.000", et="installation_created", ip="100.80.1.1", country="PL"),
        ev("ext-1", "2026-11-20 09:00:01.000", ip="100.80.1.1", country="PL"),
        ev("ext-1", "2026-11-21 09:00:00.000", et="installation_heartbeat", ip="100.80.1.1", ver="2.5.2-ce"),
        ev("ext-6", "2026-10-01 09:00:00.000", ip="2001:db8:1234:5678::9", dep="bare-metal", os_="darwin", arch="arm64"),
        ev("ci-1", "2026-11-21 15:40:00.000", et="installation_created", ip="192.0.2.9"),
        ev("int-1", "2026-11-21 10:00:00.000", ip="203.0.113.7"),
        ev("odd", "2026-11-21 11:00:00.000", et="mystery_event", ip="100.85.1.1"),  # no install signal
        ev("ext-2", "2026-11-21 13:00:00.000", ip="100.86.1.1", ver="1.2.3.4", country="<script>"),
    ]


class Feed(unittest.TestCase):
    def build(self, rows=None, salt=SALT):
        return F.build_feed(rows or sample_rows(), cfg(), GH, AZ, salt, NOW, {"gh": "2026-11-18T15:16:08Z"})

    def test_lines_and_ids(self):
        header, inst, people, stats = self.build()
        self.assertEqual(header["counts"], {"installation": len(inst), "person": len(people)})
        self.assertEqual(stats["skipped_no_signal"], 1)
        by_cls = {}
        for x in inst:
            self.assertRegex(x["id"], r"^i_[0-9a-f]{32}$")
            by_cls.setdefault(x["class"], []).append(x)
        self.assertEqual(sorted(by_cls), ["ci", "external", "internal"])
        for p in people:
            self.assertRegex(p["id"], r"^p_[0-9a-f]{32}$")
        ext = {x["first_seen"]: x for x in by_cls["external"]}
        e1 = ext["2026-11-20T09:00:00Z"]
        self.assertEqual(e1["events"], {"installation_created": 1, "instance_started": 1,
                                        "installation_version_changed": 0, "installation_heartbeat": 1, "other": 0})
        self.assertEqual((e1["first_version"], e1["version"]), ("2.5.1-ce", "2.5.2-ce"))
        self.assertEqual(e1["net"], "100.80.1")
        self.assertEqual(e1["active_days"], ["2026-11-20", "2026-11-21"])
        self.assertTrue(e1["new_7d"] and e1["active_7d"])
        e6 = ext["2026-10-01T09:00:00Z"]
        self.assertEqual(e6["net"], "2001:db8:1200::/40")
        self.assertEqual((e6["os"], e6["arch"]), ("macos", "aarch64"))
        self.assertFalse(e6["new_7d"] or e6["active_7d"])
        e2 = ext["2026-11-21T13:00:00Z"]
        self.assertIsNone(e2["version"])  # a 4-part dotted version looks like an IPv4: dropped
        self.assertIsNone(e2["country"])  # not [A-Za-z0-9._+ -]
        self.assertIsNone(by_cls["internal"][0]["net"])  # our own networks never leave the host
        self.assertEqual(by_cls["internal"][0]["reason"], "internal-list")
        self.assertEqual(by_cls["ci"][0]["reason"], "gh-actions-cidr")
        for x in by_cls["external"]:
            self.assertIn(x["person"], {p["id"] for p in people})
        for x in by_cls["ci"] + by_cls["internal"]:
            self.assertIsNone(x["person"])

    def test_no_raw_ids_or_ips_in_output(self):
        header, inst, people, _ = self.build()
        data = F.serialize(header, inst, people)
        text = data.decode()
        for r in sample_rows():
            self.assertNotIn(r["installation_id"], text.replace("installation", ""))
            if r["ip"]:
                self.assertNotIn(r["ip"], text)
        self.assertEqual(F.selfcheck_bytes(data, "synapcores-installs-feed"), [])

    def test_hmac_stable_and_salt_bound(self):
        a, b, c = self.build()[1], self.build()[1], self.build(salt=SALT + b"x")[1]
        self.assertEqual([x["id"] for x in a], [x["id"] for x in b])
        self.assertFalse({x["id"] for x in a} & {x["id"] for x in c})
        self.assertNotEqual(self.build()[0]["salt_id"], self.build(salt=SALT + b"x")[0]["salt_id"])

    def test_order_independent(self):
        rows = sample_rows()
        a = F.serialize(*self.build(rows)[:3])
        b = F.serialize(*self.build(list(reversed([dict(r) for r in rows])))[:3])
        self.assertEqual(a, b)


class Privacy(unittest.TestCase):
    def mk(self, extra):
        head = {"type": "header", "schema": "s", "version": 1, "generated_at": "2026-11-22T12:00:00Z",
                "counts": {"installation": 1}}
        line = {"type": "installation", "id": "i_" + "a" * 32, "person": None, "net": "100.80.1",
                "first_seen": "2026-11-21T13:00:00Z"}
        line.update(extra)
        return F.serialize(head, [line])

    def test_clean_file_passes(self):
        self.assertEqual(F.selfcheck_bytes(self.mk({})), [])
        self.assertEqual(F.selfcheck_bytes(self.mk({"net": "2001:db8::/40"})), [])
        self.assertTrue(F.selfcheck_bytes(self.mk({"net": "2001:db8:1::/48"})))  # /48 is too specific

    def test_ipv4_anywhere_fails(self):
        self.assertTrue(F.selfcheck_bytes(self.mk({"os": "linux 100.80.1.2"})))
        self.assertTrue(F.selfcheck_bytes(self.mk({"net": "100.80.1.2"})))
        self.assertTrue(F.selfcheck_bytes(self.mk({"x": {"y": ["::ffff:100.80.1.2"]}})))

    def test_ipv6_anywhere_fails(self):
        self.assertTrue(F.selfcheck_bytes(self.mk({"country": "2001:db8::1"})))
        self.assertTrue(F.selfcheck_bytes(self.mk({"net": "2001:db8:1:2::/64"})))
        self.assertTrue(F.selfcheck_bytes(self.mk({"note": "fe80::1%eth0"})))

    def test_header_count_mismatch_and_bad_id(self):
        head = {"type": "header", "schema": "s", "counts": {"installation": 2}}
        self.assertTrue(F.selfcheck_bytes(F.serialize(head, [{"type": "installation", "id": "i_" + "a" * 32}])))
        head["counts"] = {"installation": 1}
        self.assertTrue(F.selfcheck_bytes(F.serialize(head, [{"type": "installation", "id": "raw-uuid"}])))

    def test_txt(self):
        self.assertEqual(F.txt(" docker "), "docker")
        self.assertIsNone(F.txt("x" * 41))
        self.assertIsNone(F.txt("a;b"))
        self.assertIsNone(F.txt("10.1.2.3"))
        self.assertTrue(F.IPV4_ANY.search("host.10.1.2.3"))
        self.assertEqual(F.txt("2.5.1-ce", "version"), "2.5.1-ce")
        self.assertEqual(F.txt("v2.5.1-ce", "version"), "v2.5.1-ce")
        self.assertIsNone(F.txt("2.5.1-ce"))  # not a word
        self.assertIsNone(F.txt("1.2.3.4", "version"))
        self.assertIsNone(F.txt("192-168-1-1"))  # an IPv4 spelled with dashes is not a word
        self.assertIsNone(F.txt("3232235777", "version"))  # nor as a number
        self.assertEqual(F.txt("PL", "country"), "PL")
        self.assertIsNone(F.txt("Poland", "country"))
        self.assertEqual([F.txt(x) for x in ("bare-metal", "x86_64", "macos")], ["bare-metal", "x86_64", "macos"])

    def test_net_out(self):
        self.assertEqual(F.net_out("100.80.1"), "100.80.1")
        self.assertEqual(F.net_out("2001:db8:1234:5678::/64"), "2001:db8:1200::/40")
        self.assertEqual(F.net_out("2001:db8:0:5678::/64"), "2001:db8::/40")
        # 6to4 embeds a full IPv4 in bits 16-47: written as that address's /24, never as an IPv6 prefix
        self.assertEqual(F.net_out("2002:c000:0204:1::/64"), "192.0.2")
        self.assertIsNone(F.net_out("no-ip"))
        self.assertIsNone(F.net_out(""))


class Files(unittest.TestCase):
    def test_write_atomic(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "f.jsonl")
            F.write_atomic(p, b"one\n")
            F.write_atomic(p, b"two\n")
            self.assertEqual(rbytes(p), b"two\n")
            self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o640)
            self.assertEqual(os.listdir(d), ["f.jsonl"])

    def test_config_validation(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "c.json")
            for bad in ({"internal_24": ["1.2.3.0/24"]}, {"internal_ip": ["nope"]}, {"person_merge": [["a"]]},
                        {"nightly_ci_utc": ["6"]}, ["x"]):
                wjson(p, bad)
                with self.assertRaises(F.FeedError):
                    F.load_config(p)
            wjson(p, {"internal_24": ["100.100.14"], "person_merge": [["a", "b"]]})
            c = F.load_config(p)
            self.assertEqual(c["test_iid"], {F.DEFAULT_TEST_IID})
            self.assertEqual(c["nightly_ci_utc"], (dt.time(6, 0), dt.time(7, 30)))


class FakeEngine:
    def __init__(self, rows):
        self.rows, self.log = list(rows), []

    def query(self, sql, max_rows=None):
        self.log.append(sql)
        if sql.startswith("SELECT COUNT(*)"):
            return [{"n": len(self.rows)}]
        if "WHERE received_at >= '" in sql:
            wm = sql.split("'")[1]
            got = [r for r in self.rows if r["received_at"] >= wm]  # TEXT comparison, like the engine
        else:
            got = list(self.rows)
        return got[:max_rows] if max_rows else got


class Sync(unittest.TestCase):
    def test_full_then_incremental_then_recovery(self):
        rows = [ev("a", "2026-11-21 08:00:00.000"), ev("a", "2026-11-21 09:30:00.500")]
        eng, state = FakeEngine(rows), {}
        cache, info = F.sync_rows(eng, {}, state, NOW)
        self.assertEqual((info["mode"], len(cache)), ("full", 2))
        eng.rows.append(ev("b", "2026-11-21 10:00:00.000"))
        cache, info = F.sync_rows(eng, cache, state, NOW)
        self.assertEqual((info["mode"], info["added"], len(cache)), ("incremental", 1, 3))
        self.assertEqual(info["watermark"], "2026-11-21 08:30:00.000")  # max 09:30:00 - 1 h overlap
        eng.rows.pop(0)  # a row deleted at the source -> count mismatch -> full re-read
        cache, info = F.sync_rows(eng, cache, state, NOW)
        self.assertEqual((info["mode"], len(cache)), ("full", 2))
        self.assertIn("count mismatch", info["why"])
        cache, info = F.sync_rows(eng, cache, state, NOW + dt.timedelta(hours=25))
        self.assertEqual((info["mode"], info["why"]), ("full", "daily full sync"))

    def test_bad_rows_are_skipped_not_fatal(self):
        rows = [ev("a", "2026-11-21 08:00:00.000"), {"event_id": "x", "installation_id": None, "event_type": "e",
                                                       "received_at": "2026-11-21 08:00:00.000"}]
        eng, state = FakeEngine(rows), {}
        cache, info = F.sync_rows(eng, {}, state, NOW)
        self.assertEqual((len(cache), info["bad_rows"], state["unusable_rows"]), (1, 1, 1))
        cache, info = F.sync_rows(eng, cache, state, NOW)  # the known unusable row doesn't force a re-read
        self.assertEqual(info["mode"], "incremental")


class Downloads(unittest.TestCase):
    ASSETS = [("v2.5.1-ce", "install-ce.sh", 6), ("v2.5.1-ce", "synapcores-ce-v2.5.1-ce-darwin-aarch64.tar.gz", 6),
              ("v2.5.1-ce", "synapcores-ce-v2.5.1-ce-darwin-aarch64.tar.gz.sha256", 5),
              ("v2.5.1-ce", "synapcores-ce-v2.5.1-ce-linux-x86_64.tar.gz", 4),
              ("v1.0.0-ce", "synapcores-ce-v1.0.0-ce-linux-x86_64.tar.gz", 10)]

    def test_snapshot(self):
        s = F.make_snapshot(self.ASSETS, NOW, "v2.5.1-ce")
        self.assertEqual((s["archives"], s["all_assets"], s["latest_archives"]), (20, 31, 10))
        self.assertEqual(s["by_platform"], {"darwin-aarch64": 6, "linux-x86_64": 14})
        self.assertEqual(s["date"], "2026-11-22")

    def test_first_snapshot_of_the_day_wins_and_file_is_clean(self):
        h, added = F.add_snapshot([], F.make_snapshot(self.ASSETS, NOW, "v2.5.1-ce"))
        h, added2 = F.add_snapshot(h, F.make_snapshot(self.ASSETS, NOW + dt.timedelta(hours=3), "v2.5.1-ce"))
        self.assertEqual((added, added2, len(h)), (True, False, 1))
        self.assertEqual(F.selfcheck_bytes(F.downloads_file(h, NOW), "synapcores-github-downloads"), [])

    def test_seed_tsv(self):
        with tempfile.NamedTemporaryFile("w", suffix=".tsv", delete=False) as f:
            f.write("".join(f"{t}\t{n}\t{c}\n" for t, n, c in self.ASSETS))
        try:
            assets, latest = F.read_seed_tsv(f.name)
            self.assertEqual((len(assets), latest), (5, "v2.5.1-ce"))
        finally:
            os.unlink(f.name)


class Commands(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = self.tmp.name
        self.state, self.out = os.path.join(d, "state"), os.path.join(d, "out")
        os.makedirs(os.path.join(self.state, "ranges"))
        os.makedirs(self.out)
        wjson(os.path.join(self.state, "ranges", "gh-actions-ranges.json"),
              {"fetched_at": "2026-11-18T15:16:08Z", "union": ["192.0.2.0/24"]})
        self.cfgp, self.saltp, self.inp = (os.path.join(d, n) for n in ("cfg.json", "salt", "rows.json"))
        wjson(self.cfgp, {"internal_ip": ["203.0.113.7"]})
        wtext(self.saltp, "ab" * 32)
        wjson(self.inp, sample_rows())

    def tearDown(self):
        self.tmp.cleanup()

    def run_export(self, *extra):
        return F.main(["export", "--input", self.inp, "--state-dir", self.state, "--out-dir", self.out,
                       "--config", self.cfgp, "--salt-file", self.saltp, "--now", "2026-11-22T12:00:00Z", *extra])

    def test_dry_run_writes_nothing(self):
        self.assertEqual(self.run_export("--dry-run"), 0)
        self.assertEqual(os.listdir(self.out), [])

    def test_export_writes_clean_file(self):
        self.assertEqual(self.run_export(), 0)
        p = os.path.join(self.out, F.FEED_FILE)
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o640)
        self.assertEqual(F.selfcheck_bytes(rbytes(p), "synapcores-installs-feed"), [])
        self.assertEqual(F.main(["selfcheck", p]), 0)
        self.assertFalse(os.path.exists(os.path.join(self.state, "private")))  # --input never touches the cache

    def test_missing_ranges_refuses(self):
        os.unlink(os.path.join(self.state, "ranges", "gh-actions-ranges.json"))
        self.assertEqual(self.run_export(), 5)
        self.assertEqual(os.listdir(self.out), [])

    def test_short_salt_refused(self):
        wtext(self.saltp, "short")
        self.assertEqual(self.run_export(), 2)

    def test_refresh_seed_offline(self):
        tsv = os.path.join(self.tmp.name, "seed.tsv")
        wtext(tsv, "v2.5.1-ce\tsynapcores-ce-v2.5.1-ce-linux-x86_64.tar.gz\t4\n")
        orig = F.fetch_release_assets
        F.fetch_release_assets = lambda: (_ for _ in ()).throw(OSError("offline"))
        try:
            rc = F.main(["refresh", "--skip-ranges", "--state-dir", self.state, "--out-dir", self.out,
                         "--seed-downloads-tsv", tsv, "--seed-fetched-at", "2026-11-22T01:50:00Z",
                         "--now", "2026-11-23T06:40:00Z"])
        finally:
            F.fetch_release_assets = orig
        self.assertEqual(rc, 4)  # the fetch failed, but the seed snapshot was still published
        p = os.path.join(self.out, F.DOWNLOADS_FILE)
        lines = [json.loads(x) for x in rbytes(p).decode().splitlines()]
        self.assertEqual([x["type"] for x in lines], ["header", "snapshot"])
        self.assertEqual(lines[1]["archives"], 4)


if __name__ == "__main__":
    unittest.main()
