"""#104: the trusted evaluator core: date walk, book, next-day execution, costs, borrow, delisting, determinism."""
import unittest

from pipeline.strategy import engine, synthetic
from pipeline.strategy.engine import EvaluationError

COSTS = {"commission_bps": 1, "slippage_bps": 5, "borrow_cost_bps_default": 50, "delisting_return": -0.3,
         "execution_lag_days": 1, "sizing": {"gross_limit": 1.0}}

MOMENTUM = '''import numpy as np
META = {"side": "long", "horizon_days": 20, "rebalance": "weekly", "top_n": 5}

def signal(ctx):
    f = ctx.read_df("prices_daily", columns=["security_id", "tr_1d"], lookback_days=60)
    return {s: float(np.prod(1 + g.tr_1d) - 1) for s, g in f.groupby("security_id")}
'''


def constant(side="long", top_n=1, rebalance="weekly"):
    return (f'META = {{"side": "{side}", "horizon_days": 5, "rebalance": "{rebalance}", "top_n": {top_n}}}\n'
            'def signal(ctx):\n    return {"SEC_000000": 2.0, "SEC_000001": 1.0, "SEC_000002": 0.0, "SEC_000003": -1.0}\n')


def run(code, src, start, end, **kw):
    params = {"start": start, "end": end, **kw.pop("params", {})}
    return engine.evaluate(code, source=src, policies=synthetic.POLICIES, params=params, config=COSTS, **kw)


class Engine(unittest.TestCase):
    def test_same_inputs_give_an_identical_record(self):
        src, days = synthetic.market(n_sec=30, n_days=300, seed=3)
        a = run(MOMENTUM, src, days[70], days[-1])
        b = run(MOMENTUM, src, days[70], days[-1])
        self.assertEqual(a, b)
        self.assertTrue(a["record_hash"].startswith("sha256:"))
        self.assertEqual(a["evaluator_version"], "1.0.0")
        self.assertGreater(a["summary"]["rebalances"], 30)
        self.assertEqual(len(a["series"]["dates"]), len(a["series"]["series"]["equity"]))
        c = run(MOMENTUM, src, days[70], days[-1], params={"top_n": 3})
        self.assertNotEqual(a["record_hash"], c["record_hash"])

    def test_executes_at_the_next_close_and_pays_costs(self):
        src, days = synthetic.market(n_sec=4, n_days=30, overrides={("SEC_000000", d): 0.01 for d in synthetic.weekdays("2020-01-01", 30)})
        # 2020-01-01 is a Wednesday: the first weekly rebalance is that day, executed at the close of the 2nd.
        r = run(constant(), src, days[0], days[9])
        s = r["series"]["series"]
        self.assertEqual(r["rebalances"][0], {"date": days[0], "exec_date": days[1], "scored": 4, "eligible": 4, "long": 1, "short": 0})
        self.assertEqual(r["series"]["dates"][0], days[1])
        self.assertAlmostEqual(s["returns"][0], -0.0006, places=12)  # bought at the close: costs only
        self.assertAlmostEqual(s["returns"][1], 0.01, places=12)  # then the held name's return
        self.assertEqual(r["holdings"]["weights"], {"SEC_000000": 1.0})
        # the same name stays held: later rebalances trade nothing
        self.assertEqual(r["summary"]["trades"], 1)

    def test_short_side_pays_borrow(self):
        flat = {(f"SEC_00000{k}", d): 0.0 for k in range(4) for d in synthetic.weekdays("2020-01-01", 30)}
        src, days = synthetic.market(n_sec=4, n_days=30, overrides=flat)
        r = run(constant(side="short"), src, days[0], days[9])
        self.assertEqual(r["holdings"]["weights"], {"SEC_000003": -1.0})
        self.assertAlmostEqual(r["series"]["series"]["returns"][1], -0.005 / 252, places=9)

    def test_long_short_book_is_half_and_half(self):
        src, days = synthetic.market(n_sec=4, n_days=30)
        r = run(constant(side="long_short", top_n=2), src, days[0], days[9])
        self.assertEqual(r["holdings"]["weights"], {"SEC_000000": 0.25, "SEC_000001": 0.25, "SEC_000002": -0.25, "SEC_000003": -0.25})
        self.assertEqual(r["series"]["series"]["gross"][0], 1.0)

    def test_delisting_return_applies_once(self):
        days = synthetic.weekdays("2020-01-01", 30)
        flat = {(f"SEC_00000{k}", d): 0.0 for k in range(4) for d in days}
        src, _ = synthetic.market(n_sec=4, n_days=30, overrides=flat, delist={"SEC_000000": days[3]})
        r = run(constant(), src, days[0], days[9])
        s = r["series"]["series"]["returns"]
        self.assertAlmostEqual(s[2], 0.0)
        self.assertAlmostEqual(s[3], -0.3, places=12)  # the session after the last price
        self.assertEqual(r["summary"]["delisted"], ["SEC_000000"])
        self.assertAlmostEqual(s[4], 0.0)  # in cash afterwards (the next rebalance can't pick a delisted name)

    def test_scope_by_ticker_and_refusals(self):
        src, days = synthetic.market(n_sec=10, n_days=80)
        r = run(MOMENTUM, src, days[65], days[-1], params={"symbols": ["T000001", "T000002", "SEC_000003"]})
        self.assertLessEqual(set(r["holdings"]["weights"]), {"SEC_000001", "SEC_000002", "SEC_000003"})
        with self.assertRaisesRegex(EvaluationError, "readable end"):
            run(MOMENTUM, src, days[10], days[-1], readable_end=days[40])
        with self.assertRaisesRegex(EvaluationError, "must return a dict"):
            run(MOMENTUM.replace("return {s:", "return [s for s, g in f.groupby('security_id')] or {s:"), src, days[10], days[20])
        with self.assertRaisesRegex(EvaluationError, "start and params.end"):
            run(MOMENTUM, src, days[20], days[10])


class ByName(unittest.TestCase):
    """#324: how each name held did."""

    def test_per_name_results_add_up(self):
        src, days = synthetic.market(n_sec=30, n_days=300, seed=3)
        r = run(MOMENTUM, src, days[70], days[-1])
        b = r["by_name"]
        rows = b["rows"]
        self.assertEqual(b["names"], len(rows))
        self.assertEqual(b["truncated"], 0)
        self.assertEqual(b["positive"] + b["negative"] + sum(1 for x in rows if x["contribution"] == 0), len(rows))
        # Contributions are the same daily weight × return as the sector table: they add up to it.
        self.assertAlmostEqual(sum(x["contribution"] for x in rows), sum(x["contribution"] for x in r["by_sector"]), places=6)
        for x in rows:
            self.assertAlmostEqual(sum(x["by_year"].values()), x["contribution"], places=6)
            self.assertEqual(x["days_short"], 0)
            self.assertTrue(x["ticker"])
        self.assertEqual(sum(x["trades"] for x in rows), r["trade_stats"]["count"])
        self.assertEqual([x["contribution"] for x in rows], sorted((x["contribution"] for x in rows), reverse=True))
        # Outside the hash: an evaluation from before #324 still reproduces.
        self.assertEqual(r["record_hash"], engine.record_hash({k: v for k, v in r.items() if k not in ("record_hash", "trial_context", "by_name")}))

    def test_a_short_name_counts_short_days(self):
        flat = {(f"SEC_00000{k}", d): 0.0 for k in range(4) for d in synthetic.weekdays("2020-01-01", 30)}
        src, days = synthetic.market(n_sec=4, n_days=30, overrides=flat)
        rows = run(constant(side="short"), src, days[0], days[9])["by_name"]["rows"]
        self.assertEqual([(x["security_id"], x["days_long"] > 0, x["days_short"] > 0) for x in rows], [("SEC_000003", False, True)])


class FactorReads(unittest.TestCase):
    def test_factor_data_is_read_once_however_often_the_eligible_names_change(self):
        """#350: one features_ranked read per evaluation; a read per changed eligible list ran out of memory."""
        days = synthetic.weekdays("2020-01-01", 300)
        src, days = synthetic.market(n_sec=30, n_days=300, seed=3,
                                     delist={"SEC_000004": days[150], "SEC_000009": days[200]})
        calls = []
        orig = src.find
        src.find = lambda c, q=None, f=None: (calls.append(c), orig(c, q, f))[1]
        r = run(MOMENTUM, src, days[70], days[-1])
        self.assertEqual(calls.count("features_ranked"), 1)
        self.assertIn("momentum", r["factors"]["factors"])


class WalkForward(unittest.TestCase):
    def test_folds_per_calendar_year_and_warnings(self):
        src, days = synthetic.market(n_sec=20, n_days=600, seed=5, start="2021-06-01")
        r = run(MOMENTUM, src, days[70], days[-1])
        folds = r["folds"]
        self.assertEqual([f["fold"] for f in folds], ["2021", "2022", "2023"])
        self.assertEqual(sum(f["days"] for f in folds), r["summary"]["days"])
        total = 1.0
        for f in folds:
            total *= 1 + f["total_return"]
        self.assertAlmostEqual(total - 1, r["summary"]["total_return"], places=6)
        self.assertEqual(r["warnings"], [])
        empty = MOMENTUM.replace("return {s:", 'return {"NOT_A_SECURITY": 1.0} or {s:')
        w = run(empty, src, days[70], days[200])["warnings"]
        self.assertEqual(w[0]["code"], "empty_book")

    def test_extreme_returns_are_flagged(self):
        days = synthetic.weekdays("2020-01-01", 30)
        src, _ = synthetic.market(n_sec=4, n_days=30, overrides={("SEC_000000", days[5]): 9.0})
        w = run(constant(), src, days[0], days[9])["warnings"]
        self.assertEqual(w[0]["code"], "extreme_returns")
        self.assertEqual(w[0]["examples"][0], {"date": days[5], "security_id": "SEC_000000", "return": 9.0})


if __name__ == "__main__":
    unittest.main()


class UniverseTop(unittest.TestCase):
    """#300: universe.top_by_market_cap keeps only the N largest names on each date (an S&P 500 proxy)."""

    def test_top_by_market_cap_on_each_date(self):
        src, days = synthetic.market(n_sec=12, n_days=80, seed=5)
        # Names 0-2 are the largest in the first half, 9-11 in the second: the scope follows the date.
        half = days[40]
        for r in src.collections["universe_daily"]:
            k = int(r["security_id"][-2:])
            r["market_cap"] = (1e12 if k < 3 else 1e9) if r["date"] < half else (1e12 if k >= 9 else 1e9)
        code = constant(top_n=1).replace("return {", "return {s: 1.0 for s in ctx.universe_ids} or {")
        r = run(code, src, days[5], days[-1], params={"universe": {"top_by_market_cap": 3}, "rebalance": "weekly"})
        early = [b for b in r["rebalances"] if b["date"] < half]
        late = [b for b in r["rebalances"] if b["date"] >= half]
        self.assertTrue(early and late)
        self.assertTrue(all(b["eligible"] == 3 for b in r["rebalances"]), [b["eligible"] for b in r["rebalances"]])
        self.assertEqual(r["params"]["universe"], {"top_by_market_cap": 3}, "recorded, so the record says its scope")
        with self.assertRaises(EvaluationError):
            run(code, src, days[5], days[-1], params={"universe": {"top_by_market_cap": 0}})
