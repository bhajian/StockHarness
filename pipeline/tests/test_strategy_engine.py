"""#104: the trusted evaluator core: date walk, book, next-day execution, costs, borrow, delisting, determinism."""
import unittest

from pipeline.strategy import engine, synthetic
from pipeline.strategy.engine import EvaluationError

COSTS = {"commission_bps": 1, "slippage_bps": 5, "borrow_cost_bps_default": 50, "delisting_return": -0.3,
         "execution_lag_days": 1, "sizing": {"gross_limit": 1.0},
         # The mechanics tests hold one-name books; the caps (#465) have their own tests.
         "evaluation_caps": {"max_weight": None, "sector_cap": None}}

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
    return engine.evaluate(code, source=src, policies=synthetic.POLICIES, params=params, config=kw.pop("config", COSTS),
                           **kw)


class Engine(unittest.TestCase):
    def test_same_inputs_give_an_identical_record(self):
        src, days = synthetic.market(n_sec=30, n_days=300, seed=3)
        a = run(MOMENTUM, src, days[70], days[-1])
        b = run(MOMENTUM, src, days[70], days[-1])
        self.assertEqual(a, b)
        self.assertTrue(a["record_hash"].startswith("sha256:"))
        self.assertEqual(a["evaluator_version"], "1.9.0")
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


class Benchmark(unittest.TestCase):
    """#445: the benchmark is the S&P 500 total return; Sharpe, Sortino, alpha and folds are over the risk-free rate."""

    def test_total_return_benchmark_and_sharpe_over_cash(self):
        src, days = synthetic.market(n_sec=30, n_days=300, seed=3)
        price_only = run(MOMENTUM, src, days[70], days[-1])
        self.assertEqual(price_only["benchmark"]["price_index_days"] > 0, True, "no SPY: falls back to the index")
        self.assertAlmostEqual(price_only["summary"]["sharpe"], price_only["summary"]["sharpe_raw"])
        for m in src.collections["macro_daily"]:
            m["spx_tr_1d"] = m["spx_ret_1d"] + 0.0001  # dividends: ~2.5% a year
            m["rf_1d"] = 0.00016  # ~4% a year
        tr = run(MOMENTUM, src, days[70], days[-1])
        self.assertEqual(tr["benchmark"]["price_index_days"], 0)
        self.assertLess(tr["excess"]["spx"]["excess_cagr"], price_only["excess"]["spx"]["excess_cagr"])
        self.assertLess(tr["summary"]["sharpe"], tr["summary"]["sharpe_raw"])
        self.assertAlmostEqual(tr["summary"]["sharpe_raw"], price_only["summary"]["sharpe_raw"])
        self.assertAlmostEqual(tr["summary"]["rf_cagr"], (1.00016) ** 252 - 1, places=6)
        self.assertLess(tr["summary"]["sortino"], price_only["summary"]["sortino"])
        self.assertLess(tr["factors"]["alpha_annual"], price_only["factors"]["alpha_annual"] + 1e-9)
        self.assertLess(tr["folds"][0]["sharpe"], tr["folds"][0]["sharpe_raw"])


class Delisting(unittest.TestCase):
    """#448: a delisting's return depends on its class (read from its own last prices) and the side held."""

    def test_classify(self):
        from pipeline.strategy import delisting as dl
        self.assertEqual(dl.classify([5.0] * 30, [0.0] * 30), "merger", "pinned at a deal price")
        self.assertEqual(dl.classify([2.0] * 29 + [0.8], [0.01, -0.01] * 15), "distress", "last price under $1")
        falling = [20 * 0.98 ** k for k in range(61)]
        self.assertEqual(dl.classify(falling, [-0.02] * 61), "distress", "down more than half in 60 sessions")
        self.assertEqual(dl.classify([10.0, 10.5, 9.8], [0.0, 0.05, -0.07]), "unknown")
        self.assertEqual(dl.price_return("distress", -1, dl.DEFAULTS), 0.0, "a short never gains")

    def _run(self, side, history_days, overrides_extra=None):
        gone = "SEC_000000" if side == "long" else "SEC_000003"  # the name the constant book holds on that side
        days = synthetic.weekdays("2020-01-01", history_days + 20)
        flat = {(f"SEC_00000{k}", d): 0.0 for k in range(4) for d in days}
        flat.update(overrides_extra or {})
        last = days[history_days]
        src, _ = synthetic.market(n_sec=4, n_days=len(days), overrides=flat, delist={gone: last})
        r = run(constant(side=side), src, days[0], days[history_days + 6])
        i = r["series"]["dates"].index(days[history_days + 1])
        return r, r["series"]["series"]["returns"][i]

    def test_a_short_gets_no_windfall(self):
        r, ret = self._run("short", 3)
        self.assertAlmostEqual(ret, 0.0, places=4)  # was +30% with the flat delisting return (borrow is ~2e-5)
        self.assertEqual(r["delistings"][0]["side"], "short")

    def test_a_pinned_price_is_a_cash_out_at_zero(self):
        r, ret = self._run("long", 25)
        self.assertEqual(r["delistings"][0]["class"], "merger")
        self.assertAlmostEqual(ret, 0.0, places=6)

    def test_a_long_with_little_history_takes_the_unknown_return(self):
        r, ret = self._run("long", 3)
        self.assertEqual(r["delistings"][0]["class"], "unknown")
        self.assertAlmostEqual(ret, -0.3, places=6)


class PointInTime(unittest.TestCase):
    """#454: the sector as of each date, no unfiltered fallback universe, hashed tie-breaks."""

    def test_sector_on(self):
        hist = [{"value": "Technology", "valid_from": "2021-10-14", "valid_to": "2026-11-15"},
                {"value": "Financial Services", "valid_from": "2026-11-15", "valid_to": None}]
        self.assertEqual(engine.sector_on(hist, "2021-10-13"), "Unknown")
        self.assertEqual(engine.sector_on(hist, "2024-01-02"), "Technology")
        self.assertEqual(engine.sector_on(hist, "2026-11-15"), "Financial Services")

    def test_no_universe_rows_means_no_names(self):
        src, days = synthetic.market(n_sec=5, n_days=20)
        src.collections["universe_daily"] = []
        self.assertEqual(engine._universe_on(src, days[10], ["SEC_000000", "SEC_000001"], days), [])

    def test_ties_do_not_follow_id_order(self):
        ids = [f"SEC_{k:06d}" for k in range(40)]
        book = engine.build_book({s: 1.0 for s in ids}, None, "long", 10, 1.0)
        self.assertEqual(len(book), 10)
        self.assertNotEqual(sorted(book), ids[:10])
        self.assertEqual(book, engine.build_book({s: 1.0 for s in ids}, None, "long", 10, 1.0))


class HeldDataQuality(unittest.TestCase):
    """#451: the record warns when a held name's price that day was flagged."""

    def test_flags_on_held_names_are_reported(self):
        days = synthetic.weekdays("2020-01-01", 30)
        src, _ = synthetic.market(n_sec=4, n_days=30)
        for row in src.collections["prices_daily"]:
            if row["security_id"] == "SEC_000000" and row["date"] == days[5]:
                row["dq_flags"] = ["large_move"]
            if row["security_id"] == "SEC_000003" and row["date"] == days[5]:
                row["dq_flags"] = ["bad_print"]  # not held by a long book of one
        r = run(constant(), src, days[0], days[12])
        w = [x for x in r["warnings"] if x["code"] == "data_quality_on_held_names"]
        self.assertEqual(len(w), 1)
        self.assertEqual(w[0]["by_flag"], {"large_move": 1})


class IndexScope(unittest.TestCase):
    """#455: a scope of an index's point-in-time members, and a warning for hand-picked name lists."""

    def test_only_members_on_each_date_are_eligible(self):
        src, days = synthetic.market(n_sec=20, n_days=160, seed=5)
        members = {f"SEC_{k:06d}" for k in range(5)}
        for u in src.collections["universe_daily"]:
            u["in_sp500"] = u["security_id"] in members and u["date"] >= days[60] or (
                u["security_id"] == "SEC_000010" and u["date"] < days[60])
        r = run(MOMENTUM, src, days[30], days[-1], params={"universe": {"index": "sp500"}})
        held = {s for b in r["rebalances"] for s in []} | set(r["holdings"]["weights"])
        self.assertTrue(held <= members, held)
        self.assertTrue(all(x["eligible"] <= 5 for x in r["rebalances"]))
        with self.assertRaises(engine.EvaluationError):
            run(MOMENTUM, src, days[30], days[-1], params={"universe": {"index": "ftse"}})

    def test_a_symbol_list_is_flagged_hindsight(self):
        src, days = synthetic.market(n_sec=10, n_days=120, seed=5)
        r = run(MOMENTUM, src, days[30], days[-1], params={"symbols": [f"T{k:06d}" for k in range(6)]})
        self.assertIn("hindsight_scope", [w["code"] for w in r["warnings"]])


class Costs(unittest.TestCase):
    """#452: square-root impact by ADV at the assumed book size, borrow by size, capacity in the record."""

    def _market(self, adv, mcap):
        src, days = synthetic.market(n_sec=20, n_days=200, seed=7)
        for u in src.collections["universe_daily"]:
            u["adv_20d"], u["market_cap"] = adv, mcap
        return src, days

    def test_illiquid_names_cost_more(self):
        liquid, days = self._market(5e9, 5e10)
        thin, _ = self._market(2e6, 5e10)
        a = run(MOMENTUM, liquid, days[70], days[-1])
        b = run(MOMENTUM, thin, days[70], days[-1])
        self.assertGreater(b["summary"]["impact_paid"], 10 * a["summary"]["impact_paid"])
        self.assertLess(b["summary"]["total_return"], a["summary"]["total_return"])
        self.assertGreater(a["capacity"]["capacity_aum"], b["capacity"]["capacity_aum"])
        self.assertEqual(len(a["series"]["series"]["returns_before_costs"]), len(a["series"]["dates"]))

    def test_unknown_adv_pays_the_flat_rates_only(self):
        src, days = synthetic.market(n_sec=20, n_days=200, seed=7)
        r = run(MOMENTUM, src, days[70], days[-1])
        self.assertEqual(r["summary"]["impact_paid"], 0.0)
        self.assertEqual(r["capacity"], {"trades": 0})

    def test_borrow_by_size(self):
        from pipeline.strategy import costs
        self.assertEqual(costs.borrow_bps(5e10, 50), 25.0)
        self.assertEqual(costs.borrow_bps(1e8, 50), 500.0)
        self.assertEqual(costs.borrow_bps(None, 50), 50)
        small, days = self._market(5e9, 1e8)
        big, _ = self._market(5e9, 5e10)
        short = MOMENTUM.replace('"side": "long"', '"side": "short"')
        self.assertGreater(run(short, small, days[70], days[-1])["summary"]["borrow_paid"],
                           run(short, big, days[70], days[-1])["summary"]["borrow_paid"])


class Churn(unittest.TestCase):
    """#466: the rank buffer keeps held names near the cut, and the record reports how much the book churns."""

    def test_rank_buffer_keeps_names_near_the_cut(self):
        order = [f"S{k}" for k in range(10)]
        held = {"S4": 0.25, "S5": 0.25}  # held names now ranked 5th and 6th; a top-4 book
        self.assertEqual(sorted(engine._with_buffer(order, set(held), 4, 1.5)), ["S0", "S1", "S4", "S5"])
        self.assertEqual(engine._with_buffer(order, set(held), 4, 1.0), ["S0", "S1", "S2", "S3"])

    def test_buffer_lowers_turnover_and_churn_is_reported(self):
        src, days = synthetic.market(n_sec=40, n_days=260, seed=9)
        tight = run(MOMENTUM, src, days[70], days[-1], config={**COSTS, "turnover": {"rank_buffer": 1.0}})
        loose = run(MOMENTUM, src, days[70], days[-1], config={**COSTS, "turnover": {"rank_buffer": 2.0}})
        self.assertLess(loose["summary"]["annual_turnover"], tight["summary"]["annual_turnover"])
        c = loose["summary"]["churn"]
        self.assertGreater(c["avg_holding_days"], tight["summary"]["churn"]["avg_holding_days"])
        self.assertEqual(c["rank_buffer"], 2.0)
        self.assertIsNotNone(c["reentry_rate"])



class Diversification(unittest.TestCase):
    """#465: name and sector caps on every book, and how concentrated the books were."""

    def test_cap_book(self):
        book = {"A": 0.25, "B": 0.25, "C": 0.25, "D": 0.25}
        sector = {"A": "Tech", "B": "Tech", "C": "Tech", "D": "Energy"}.get
        capped = engine.cap_book(book, 0.2, 0.3, sector)
        self.assertAlmostEqual(capped["D"], 0.2)
        self.assertAlmostEqual(sum(capped[s] for s in "ABC"), 0.3)
        self.assertAlmostEqual(engine.cap_book({"A": -0.5}, 0.1, None, sector)["A"], -0.1)

    def test_records_carry_concentration_and_obey_the_caps(self):
        src, days = synthetic.market(n_sec=30, n_days=200, seed=3)
        r = run(MOMENTUM, src, days[70], days[-1], config={**COSTS, "evaluation_caps": {"max_weight": 0.1, "sector_cap": 0.3}})
        c = r["concentration"]
        self.assertLessEqual(c["max_sector"], 1.0)
        self.assertGreater(c["effective_names"], 1)
        self.assertLessEqual(max(r["series"]["series"]["gross"]), 0.6 + 1e-6, "two sectors at 30% each")
