"""Parity with the installs-log reference (installs-sprint tel8w.py) on a real telemetry pull.

Skipped unless all three are set (the data is private and never committed):
  TEL8W_PATH        path to tel8w.py
  TEL_SNAPSHOT      read-only `SELECT * FROM telemetry_events` pull (JSON array, as in tel8w.py's header)
  TEL8W_RANGES_DIR  directory with tel8w.py's gh-actions-ranges.json + azure-ranges.json caches

Checks, per installation: class, rule, first/last event, first install signal, /24 key, deployment/os/arch/
version/country; the person clusters; and the installs-log numbers (new installs, new people, active people,
CI ids, internal ids) for every week of the last 8 and every day of the last 30, computed both ways: from
tel8w.py's records and from the sanitized feed lines the app imports.
"""
import collections
import datetime as dt
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)
import synapcores_installs_feed as F  # noqa: E402
from tel8w_config import config_from_tel8w, load_tel8w  # noqa: E402

ENV = ("TEL8W_PATH", "TEL_SNAPSHOT", "TEL8W_RANGES_DIR")
SKIP = not all(os.environ.get(k) for k in ENV)


@unittest.skipIf(SKIP, "set TEL8W_PATH, TEL_SNAPSHOT and TEL8W_RANGES_DIR to compare with tel8w.py")
class MatchesTel8w(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.T = load_tel8w(os.environ["TEL8W_PATH"])
        rd = os.environ["TEL8W_RANGES_DIR"]
        rows = F.read_json(os.environ["TEL_SNAPSHOT"])
        gh = F.read_json(os.path.join(rd, "gh-actions-ranges.json"))["union"]
        az = F.read_json(os.path.join(rd, "azure-ranges.json"))["union"]
        cls.rows = rows
        cls.end = max(cls.T.ts(r["received_at"]) for r in rows).replace(hour=0, minute=0, second=0) + dt.timedelta(days=1)
        # reference: tel8w.py's own functions, its own CidrSet
        cls.t_inst, cls.t_recs = cls.T.classify(rows, cls.T.CidrSet(gh), cls.T.CidrSet(az))
        cls.t_people = cls.T.cluster_people(cls.t_inst, cls.t_recs)
        # port: config generated from tel8w.py's lists, written + re-read through load_config()
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(config_from_tel8w(cls.T), f)
        cls.cfg = F.load_config(f.name)
        os.unlink(f.name)
        cls.f_ranges, cls.f_azure = F.CidrSet(gh), F.CidrSet(az)
        cls.f_inst, cls.f_recs = F.classify([dict(r) for r in rows], cls.cfg, cls.f_ranges, cls.f_azure)
        cls.f_people = F.cluster_people(cls.f_inst, cls.f_recs, cls.cfg)
        salt = b"parity-test-salt-0123456789abcdef0123"
        cls.header, cls.lines, cls.plines, cls.stats = F.build_feed([dict(r) for r in rows], cls.cfg, cls.f_ranges,
                                                                    cls.f_azure, salt, cls.end)
        cls.hid = {iid: "i_" + F.hid(salt, "installation", iid) for iid in cls.t_recs}

    def test_every_installation_same_class_and_fields(self):
        self.assertEqual(set(self.t_recs), set(self.f_recs))
        keys = ("c", "why", "first", "last", "first_seen", "first_type", "key", "keys", "dep", "os", "arch", "ver",
                "country")
        diffs = [(iid, k) for iid, t in self.t_recs.items() for k in keys if t[k] != self.f_recs[iid][k]]
        self.assertEqual(diffs, [])

    def test_class_counts_line_up(self):
        t = collections.Counter(F.CLASS_OUT[r["c"]] for r in self.t_recs.values())
        self.assertEqual(t, self.stats["classes"])
        self.assertEqual(self.header["source"]["installations"], len(self.t_recs))

    def test_same_people(self):
        t = sorted(sorted(p["iids"]) for p in self.t_people)
        f = sorted(sorted(p["iids"]) for p in self.f_people)
        self.assertEqual(t, f)
        tp = {p["iids"][0]: p for p in self.t_people}
        for p in self.f_people:
            q = tp[p["iids"][0]]
            self.assertEqual((p["first"], p["last"], p["b"], p["days"], p["returned"]),
                             (q["first"], q["last"], q["b"], q["days"], q["returned"]))

    def test_feed_lines_follow_the_records(self):
        by_id = {x["id"]: x for x in self.lines}
        signal = [r for r in self.t_recs.values() if r["first_seen"]]
        self.assertEqual(len(by_id), len(signal))
        for r in signal:
            x = by_id[self.hid[r["iid"]]]
            self.assertEqual(x["class"], F.CLASS_OUT[r["c"]])
            self.assertEqual(x["first_seen"], F.iso(r["first_seen"]))
            self.assertEqual(x["last_seen"], F.iso(r["last"]))
            self.assertEqual(x["person"] is not None, r["c"] == "person")
        self.assertEqual(F.selfcheck_bytes(F.serialize(self.header, self.lines, self.plines)), [])

    def windows(self):
        weeks = [(self.end - dt.timedelta(days=7 * (i + 1)), self.end - dt.timedelta(days=7 * i)) for i in range(8)]
        days = [(self.end - dt.timedelta(days=i + 1), self.end - dt.timedelta(days=i)) for i in range(30)]
        return weeks[::-1] + days[::-1]

    def test_installs_log_numbers_from_the_feed(self):
        """What the app computes from the feed == what tel8w.py prints, window by window."""
        T, recs, people = self.T, self.t_recs, self.t_people
        pid = {iid: p["label"] for p in people for iid in p["iids"]}
        INT = ("internal", "likely-internal", "test")
        feed_days = lambda x: {dt.date.fromisoformat(d) for d in x["active_days"]}  # noqa: E731
        bad = []
        for s, z in self.windows():
            ref = dict(
                new=len(T.new_installs(recs, s, z)),
                people=sum(1 for p in people if s <= p["first"] < z),
                active=len({pid[r["installation_id"]] for r in self.rows
                            if r["installation_id"] in pid and s <= T.ts(r["received_at"]) < z}),
                ci=sum(1 for r in recs.values() if r["first_seen"] and s <= r["first_seen"] < z and r["c"] == "ci"),
                internal=sum(1 for r in recs.values() if r["first_seen"] and s <= r["first_seen"] < z and r["c"] in INT))
            inwin = lambda t: s <= F.ts(t) < z  # noqa: E731
            dset = {(s + dt.timedelta(days=i)).date() for i in range((z - s).days)}
            got = dict(
                new=sum(1 for x in self.lines if x["class"] == "external" and inwin(x["first_seen"])),
                people=sum(1 for p in self.plines if inwin(p["first_seen"])),
                active=sum(1 for p in self.plines if feed_days(p) & dset),
                ci=sum(1 for x in self.lines if x["class"] == "ci" and inwin(x["first_seen"])),
                internal=sum(1 for x in self.lines if x["class"] in INT and inwin(x["first_seen"])))
            if ref != got:
                bad.append((f"{s:%m-%d}->{z:%m-%d}", ref, got))
        self.assertEqual(bad, [])


if __name__ == "__main__":
    unittest.main()
