"""Tests for the transform helpers in oh.py (#91). Run inside the executor image against a throwaway
MongoDB: MONGODB_URI must point at an isolated test database (scripts/test-oh-sdk.sh does this)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

DESCRIBE = os.path.join(tempfile.mkdtemp(), "describe.json")
os.environ.setdefault("OH_OUTPUTS", json.dumps([
    {"collection": "prices_t", "key": ["security_id", "date"], "write_mode": "upsert", "known_at_field": "known_at"},
    {"collection": "snap_t", "key": ["k"], "write_mode": "replace", "static": True},
]))
os.environ.setdefault("OH_WINDOW", json.dumps({"start": "2026-11-01", "end": "2026-11-03", "lookback_start": "2026-10-20"}))
os.environ["OH_DESCRIBE_PATH"] = DESCRIBE

import oh  # noqa: E402

DB = oh._db()


def setUpModule():
    for c in ("prices_t", "snap_t", "dq_issues", "eod_t", "trading_calendar"):
        DB[c].drop()


class Window(unittest.TestCase):
    def test_window(self):
        self.assertEqual((oh.window.start, oh.window.end, oh.window.lookback_start), ("2026-11-01", "2026-11-03", "2026-10-20"))
        self.assertEqual(oh.window["end"], "2026-11-03")


class Outputs(unittest.TestCase):
    def test_undeclared_collections_are_refused(self):
        with self.assertRaises(PermissionError):
            oh.write("eod_prices", [{"a": 1}])
        with self.assertRaises(PermissionError):
            oh.upsert("eod_prices", [{"a": 1}], key=["a"])
        with self.assertRaises(KeyError):
            oh.output("nope")

    def test_upsert_is_idempotent_and_skips_unchanged_rows(self):
        out = oh.output("prices_t")
        rows = [{"security_id": "S1", "date": "2026-11-0%d" % d, "close": d, "known_at": "x"} for d in (1, 2, 3)]
        self.assertEqual(out.upsert(rows), {"written": 3, "unchanged": 0})
        self.assertEqual(out.upsert(rows), {"written": 0, "unchanged": 3})
        rows[1]["close"] = 99
        self.assertEqual(out.upsert(rows), {"written": 1, "unchanged": 2})
        self.assertEqual(DB["prices_t"].count_documents({"security_id": "S1"}), 3)
        self.assertEqual(DB["prices_t"].find_one({"security_id": "S1", "date": "2026-11-02"})["close"], 99)

    def test_point_in_time_and_keys_are_enforced(self):
        out = oh.output("prices_t")
        with self.assertRaisesRegex(ValueError, "known_at"):
            out.upsert([{"security_id": "S2", "date": "2026-11-01", "close": 1}])
        with self.assertRaisesRegex(ValueError, "key field"):
            out.upsert([{"security_id": "S2", "close": 1, "known_at": "x"}])

    def test_dataframes_with_missing_values_and_replace_mode(self):
        import numpy as np
        import pandas as pd

        frame = pd.DataFrame({"security_id": ["S3", "S3"], "date": ["2026-11-01", "2026-11-02"],
                              "close": [1.5, np.nan], "ts": [pd.Timestamp("2026-11-01"), pd.NaT], "known_at": ["x", "x"]})
        self.assertEqual(oh.output("prices_t").upsert_df(frame)["written"], 2)
        doc = DB["prices_t"].find_one({"security_id": "S3", "date": "2026-11-02"})
        self.assertIsNone(doc["close"])
        self.assertIsNone(doc["ts"])
        snap = oh.output("snap_t")
        snap.upsert([{"k": 1}, {"k": 2}])
        snap.upsert([{"k": 3}])
        self.assertEqual([d["k"] for d in DB["snap_t"].find({}, {"_id": 0})], [3], "replace mode replaces")


class DataQuality(unittest.TestCase):
    def test_dq_is_idempotent(self):
        for _ in range(3):
            oh.dq("stale_price", "warn", security_id="S1", date="2026-11-03", bars=5)
        oh.dq("zero_volume", "info", security_id="S1", date="2026-11-03")
        oh._flush_dq()
        oh.dq("stale_price", "error", security_id="S1", date="2026-11-03")
        oh._flush_dq()
        self.assertEqual(DB["dq_issues"].count_documents({"security_id": "S1", "issue_type": {"$in": ["stale_price", "zero_volume"]}}), 2)
        stale = DB["dq_issues"].find_one({"issue_type": "stale_price"})
        self.assertEqual((stale["collection"], stale["severity"], stale["resolved"]), ("prices_t", "error", False))
        with self.assertRaises(ValueError):
            oh.dq("x", "fatal")

    def test_buffered_issues_are_written_at_exit(self):
        code = "import oh; oh.dq('exit_flush', 'warn', security_id='S9', date='2026-11-03')"
        subprocess.run([sys.executable, "-c", code], check=True, env={**os.environ})
        self.assertEqual(DB["dq_issues"].count_documents({"issue_type": "exit_flush"}), 1)


class ReadsDescribeDuckdbPit(unittest.TestCase):
    def test_columns_and_chunks(self):
        DB["eod_t"].insert_many([{"symbol": "A", "date": f"2026-10-{d:02d}", "close": d, "volume": 1} for d in range(1, 26)])
        frame = oh.read_df("eod_t", {"date": {"$gte": oh.window.lookback_start}}, columns=["symbol", "date", "close"])
        self.assertEqual(sorted(frame.columns), ["close", "date", "symbol"])
        self.assertEqual(len(frame), 6)
        chunks = list(oh.read_df("eod_t", chunksize=10))
        self.assertEqual([len(c) for c in chunks], [10, 10, 5])

    def test_describe_hands_docs_to_the_runner(self):
        oh.describe("prices_t", description="Adjusted prices", fields={"close": "Close, USD"}, grain="security × day")
        oh.describe("prices_t", fields={"known_at": {"description": "When known", "unit": "UTC"}})
        with open(DESCRIBE) as h:
            docs = json.load(h)
        self.assertEqual(docs[0]["fields"]["close"], {"description": "Close, USD"})
        self.assertEqual(docs[0]["fields"]["known_at"]["unit"], "UTC")
        self.assertEqual(docs[0]["grain"], "security × day")

    def test_duckdb_joins_frames_and_collections(self):
        import pandas as pd

        con = oh.duckdb(bars=("eod_t", {}), meta=pd.DataFrame({"symbol": ["A"], "sector": ["Tech"]}))
        n, sector = con.execute("select count(*), any_value(m.sector) from bars b join meta m using (symbol)").fetchone()
        self.assertEqual((n, sector), (25, "Tech"))

    def test_pit(self):
        from datetime import date

        self.assertEqual(oh.pit.eod_known_at("2026-11-03").isoformat(), "2026-11-03T21:00:00+00:00")
        # Without a trading calendar: weekday sessions. After Friday's close -> Monday.
        self.assertEqual(oh.pit.as_of("2026-10-30T21:00:00Z"), date(2026, 11, 2))
        self.assertEqual(oh.pit.as_of(oh.pit.eod_known_at("2026-11-03"), same_day=True), date(2026, 11, 3))


class Preview(unittest.TestCase):
    """#95: a preview captures rows and checks per output, writes nothing and reads only the sample symbols."""

    def test_preview_writes_nothing(self):
        DB["pv_raw"].drop()
        DB["pv_raw"].insert_many([{"symbol": s, "date": f"2026-01-0{d}", "close": d} for s in "ABC" for d in range(1, 6)])
        out_path = os.path.join(tempfile.mkdtemp(), "preview.json")
        code = """
import oh
rows = oh.read("pv_raw")
assert {r["symbol"] for r in rows} == {"A", "B"}, rows
data = [{"symbol": r["symbol"], "date": r["date"], "close": r["close"], "known_at": r["date"] + "T21:00:00Z",
         "note": None if r["close"] < 4 else "x"} for r in rows]
data.append(dict(data[0]))                       # a duplicate key
data.append({"symbol": "A", "date": "2026-01-09", "close": 1})  # no known_at: counted, not raised
data[1]["close"] = float("inf")                  # not JSON: shown as a string
oh.output("pv_out").upsert(data)
oh.output("pv_static").upsert([{"k": 1}, {"k": 2}])
oh.dq("odd", "warn", security_id="A", date="2026-01-01")
"""
        env = {**os.environ, "OH_PREVIEW": "1", "OH_PREVIEW_PATH": out_path, "OH_SAMPLE_SYMBOLS": json.dumps(["A", "B"]),
               "OH_OUTPUTS": json.dumps([
                   {"collection": "pv_out", "key": ["symbol", "date"], "write_mode": "upsert", "known_at_field": "known_at"},
                   {"collection": "pv_static", "key": ["k"], "write_mode": "replace", "static": True}]),
               "OH_DQ_COLLECTION": "pv_out"}
        env.pop("OH_WINDOW", None)
        subprocess.run([sys.executable, "-c", code], check=True, env=env)
        self.assertNotIn("pv_out", DB.list_collection_names())
        self.assertNotIn("pv_static", DB.list_collection_names())
        self.assertEqual(DB["dq_issues"].count_documents({"collection": "pv_out"}), 0)
        with open(out_path) as h:
            p = json.load(h)
        o = p["pv_out"]
        self.assertEqual((o["count"], o["dup_keys"], o["missing_known_at"], o["missing_key"]), (12, 1, 1, 0))
        self.assertEqual(len(o["rows"]), 12)
        self.assertEqual(o["fields"]["close"], {"type": "int", "null_pct": 0})
        self.assertEqual(o["rows"][1]["close"], "inf")
        self.assertGreater(o["fields"]["note"]["null_pct"], 50)
        self.assertEqual(o["fields"]["known_at"]["null_pct"], round(100 / 12, 1), "a missing field counts as null")
        self.assertEqual(o["dq"], [{"issue_type": "odd", "severity": "warn", "security_id": "A", "date": "2026-01-01"}])
        self.assertEqual(p["pv_static"]["count"], 2)


if __name__ == "__main__":
    unittest.main()
