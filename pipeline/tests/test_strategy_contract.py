"""#103: plugin contract, known-at parity with knownAt.ts, and the as_of-enforced reader."""
import json
import unittest
from pathlib import Path

from pipeline.strategy import contract, known_at
from pipeline.strategy.context import StrategyContext
from pipeline.strategy.reader import DataAccessError, PitReader
from pipeline.strategy.sources import MemorySource

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "known_at_vectors.json").read_text())
PIT = {"mode": "pit", "rule": {"type": "asOf", "field": "as_of_date"}}
DAYS = ["2024-03-04", "2024-03-05", "2024-03-06", "2024-03-07", "2024-03-08", "2024-03-11"]


def prices():
    return [
        {"security_id": s, "date": d, "as_of_date": d, "ret_1d": 0.01 * (i + 1), "close": 100 + i}
        for s in ("SEC_A", "SEC_B") for i, d in enumerate(DAYS)
    ]


POLICIES = {
    "prices_daily": PIT,
    "insider_trades": {"mode": "pit", "rule": {"type": "timestamp", "field": "filingDate"}},
    "trading_calendar": {"mode": "static"},
    "company_profiles": {"mode": "refuse", "reason": "it holds current values only (no history)"},
}


def reader(**kw):
    src = MemorySource({
        "prices_daily": prices(),
        "insider_trades": [
            {"symbol": "AAA", "filingDate": "2024-03-05 18:00:00", "shares": 10},
            {"symbol": "AAA", "filingDate": "2024-03-08 08:00:00", "shares": 20},
        ],
        "trading_calendar": [{"date": d} for d in DAYS],
        "company_profiles": [{"symbol": "AAA"}],
    })
    return PitReader(src, POLICIES, end=kw.pop("end", "2024-03-11"), start="2024-03-04", **kw)


class KnownAtParity(unittest.TestCase):
    def test_same_as_of_dates_as_knownAt_ts(self):
        for c in VECTORS:
            with self.subTest(rule=c["rule"]["type"], row=c["row"]):
                self.assertEqual(known_at.as_of_date(c["rule"], c["row"]), c["as_of_date"])

    def test_coarse_filter_never_drops_a_visible_row(self):
        for c in VECTORS:
            if c["as_of_date"] is None:
                continue
            src = MemorySource({"x": [dict(c["row"])]})
            for d in (c["as_of_date"], known_at.add_days(c["as_of_date"], 3)):
                with self.subTest(rule=c["rule"], d=d):
                    self.assertEqual(len(src.find("x", known_at.coarse_filter(c["rule"], d))), 1)


class Reader(unittest.TestCase):
    def test_a_plugin_that_reads_tomorrow_gets_nothing_past_ctx_date(self):
        r = reader()
        ctx = StrategyContext("2024-03-06", r)
        tomorrow = ctx.read_df("prices_daily", {"date": {"$gt": "2024-03-06"}})
        self.assertEqual(len(tomorrow), 0)
        everything = ctx.read_df("prices_daily")
        self.assertEqual(everything["as_of_date"].max(), "2024-03-06")
        self.assertEqual(len(everything), 6)
        self.assertEqual(r.stats["lookahead_attempts"], 1)

    def test_layer1_rule_applies_directly(self):
        ctx = StrategyContext("2024-03-06", reader())
        rows = ctx.read_df("insider_trades")  # filed after the close on the 5th: usable on the 6th
        self.assertEqual(rows["shares"].tolist(), [10])
        self.assertEqual(rows["as_of_date"].tolist(), ["2024-03-06"])
        # filed before the open on the 8th: usable that day, not before
        self.assertEqual(len(StrategyContext("2024-03-07", reader()).read_df("insider_trades")), 1)
        self.assertEqual(len(StrategyContext("2024-03-08", reader()).read_df("insider_trades")), 2)

    def test_lookback_columns_and_static(self):
        ctx = StrategyContext("2024-03-08", reader())
        f = ctx.read_df("prices_daily", columns=["security_id", "ret_1d"], lookback_days=2)
        self.assertEqual(list(f.columns), ["security_id", "ret_1d", "as_of_date"])
        self.assertEqual(sorted(set(f["as_of_date"])), ["2024-03-06", "2024-03-07", "2024-03-08"])
        self.assertEqual(len(ctx.read_df("trading_calendar")), 6)  # static: uncut

    def test_refusals(self):
        r = reader(end="2024-03-07")
        with self.assertRaisesRegex(DataAccessError, "current values only"):
            r.read_df("company_profiles", as_of="2024-03-06")
        with self.assertRaisesRegex(DataAccessError, "not in the Schema Catalog"):
            r.read_df("eod_prices", as_of="2024-03-06")
        with self.assertRaisesRegex(DataAccessError, "after the readable end"):
            r.read_df("prices_daily", as_of="2024-03-08")
        with self.assertRaisesRegex(DataAccessError, r"\$where"):
            r.read_df("prices_daily", {"$where": "1"}, as_of="2024-03-06")
        # rows past the end never even load
        self.assertEqual(r.read_df("prices_daily", as_of="2024-03-07")["as_of_date"].max(), "2024-03-07")

    def test_date_helpers(self):
        ctx = StrategyContext("2024-03-08", reader())
        self.assertEqual(ctx.days_ago(3), "2024-03-05")
        self.assertEqual(ctx.trading_days_ago(2), "2024-03-06")
        self.assertEqual(ctx.trading_days_ago(4), "2024-03-04")
        self.assertEqual(contract.validate(GOOD.replace("lookback_days=10)", "lookback_days=10, filter={\"date\": {\"$gte\": ctx.days_ago(30)}})")), [])

    def test_scope_limits_rows(self):
        r = reader(scope_ids=["SEC_B"])
        self.assertEqual(set(r.read_df("prices_daily", as_of="2024-03-11")["security_id"]), {"SEC_B"})


GOOD = '''import numpy as np
META = {"side": "long", "horizon_days": 20, "rebalance": "weekly", "top_n": 1}

def signal(ctx):
    f = ctx.read_df("prices_daily", columns=["security_id", "ret_1d"], lookback_days=10)
    return {s: float(np.mean(g.ret_1d)) for s, g in f.groupby("security_id")}
'''


class Contract(unittest.TestCase):
    def test_valid_plugin_loads_and_runs(self):
        self.assertEqual(contract.validate(GOOD), [])
        p = contract.load(GOOD)
        self.assertEqual(p.META["top_n"], 1)
        self.assertTrue(p.hash.startswith("sha256:") and len(p.hash) == 71)
        scores = p.signal(StrategyContext("2024-03-08", reader()))
        self.assertEqual(sorted(scores), ["SEC_A", "SEC_B"])

    def test_problems_name_their_lines(self):
        bad = (
            "import os\nimport pymongo\nfrom oh import read\n"
            'META = {"side": "up", "horizon_days": 0, "rebalance": "weekly", "top_n": 3, "x": 1}\n'
            "def signal(ctx):\n    open('/etc/passwd')\n    ctx._reader.source.find('x')\n"
            "    df = ctx.read_df('p'); df.to_csv('f'); ctx.read_csv\n    return eval('1')\n"
        )
        problems = "\n".join(contract.validate(bad))
        for needle in ("line 1: import os", "line 2: import pymongo", "line 3: from oh", "META.side",
                       "META.horizon_days", "unknown keys: x", "line 6: open", "line 7: ._reader", "line 8: .to_csv",
                       "line 8: .read_csv", "line 9: eval"):
            self.assertIn(needle, problems)

    def test_missing_pieces_and_syntax(self):
        self.assertIn("must define signal(ctx)", " ".join(contract.validate('META = {"side": "long", "horizon_days": 1, "rebalance": "daily", "top_n": 1}')))
        self.assertIn("must define META", " ".join(contract.validate("def signal(ctx):\n    return {}\n")))
        self.assertEqual(contract.validate("def signal(ctx)\n  return {}"), ["line 1: syntax error: expected ':'"])
        with self.assertRaises(contract.PluginError):
            contract.load("import os\n")

    def test_runtime_import_guard(self):
        sneaky = GOOD.replace("import numpy as np", "import numpy as np\nimport importlib")
        self.assertTrue(any("importlib" in p for p in contract.validate(sneaky)))
        with self.assertRaises(ImportError):
            contract._guarded_import("socket")


if __name__ == "__main__":
    unittest.main()
