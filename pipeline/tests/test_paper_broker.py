"""#124: the paper broker and simulations. The ledger reconciles every day, a one-idea simulation with the
default settings reproduces the evaluator, the same config gives the same ledger, and every exit records why."""
import unittest

from pipeline.strategy import engine, synthetic
from pipeline.strategy.simulate import ListSink, simulate

COSTS = {"commission_bps": 1, "slippage_bps": 5, "borrow_cost_bps_default": 50, "delisting_return": -0.3,
         "execution_lag_days": 1, "sizing": {"gross_limit": 1.0}}

MOMENTUM = '''import numpy as np
META = {"side": "long", "horizon_days": 20, "rebalance": "weekly", "top_n": 5}

def signal(ctx):
    f = ctx.read_df("prices_daily", columns=["security_id", "tr_1d"], lookback_days=60)
    return {s: float(np.prod(1 + g.tr_1d) - 1) for s, g in f.groupby("security_id")}
'''
REVERSAL = MOMENTUM.replace("return {s: float(", "return {s: -float(").replace('"top_n": 5', '"top_n": 4')


def sim(ideas, src, start, end, **params):
    sink = ListSink()
    res = simulate([{"id": f"idea-{k}", "ref": f"T-{k + 1}", "code": c} for k, c in enumerate(ideas)],
                   source=src, policies=synthetic.POLICIES, params={"start": start, "end": end, **params},
                   config=COSTS, sink=sink)
    return res, sink.rows


class Parity(unittest.TestCase):
    def check(self, code, src, start, end, tol):
        ev = engine.evaluate(code, source=src, policies=synthetic.POLICIES, params={"start": start, "end": end},
                             config=COSTS)
        res, _ = sim([code], src, start, end)
        self.assertEqual(ev["series"]["dates"], res["series"]["dates"])
        worst = max(abs(a - b) for a, b in zip(ev["series"]["series"]["equity"], res["series"]["series"]["equity"]))
        self.assertLess(worst, tol, f"equity differs by {worst}")
        return ev, res

    def test_one_idea_reproduces_the_evaluator_long(self):
        src, days = synthetic.market(n_sec=30, n_days=300, seed=3, momentum=1.0)
        ev, res = self.check(MOMENTUM, src, days[70], days[-1], 1e-9)
        self.assertGreater(res["summary"]["trades"], 10)
        self.assertAlmostEqual(res["summary"]["sharpe"], ev["summary"]["sharpe"], places=6)

    def test_long_short_and_delisting(self):
        src, days = synthetic.market(n_sec=20, n_days=260, seed=5, delist={"SEC_000003": "2020-06-01"})
        code = MOMENTUM.replace('"side": "long"', '"side": "long_short"').replace('"top_n": 5', '"top_n": 3')
        # Shorts differ only by the evaluator's weight normalisation before borrow (second order).
        _, res = self.check(code, src, days[70], days[-1], 1e-4)
        self.assertGreater(res["summary"]["borrow_paid"], 0)


class Ledger(unittest.TestCase):
    def setUp(self):
        src, self.days = synthetic.market(n_sec=12, n_days=200, seed=7)
        prices = src.collections["prices_daily"]
        rows = sorted((r for r in prices if r["security_id"] == "SEC_000000"), key=lambda r: r["date"])
        # A 2-for-1 split on day 120 (the close halves, the return does not) and a 2% dividend on day 140.
        split_day, div_day = self.days[120], self.days[140]
        for r in rows:
            if r["date"] >= split_day:
                r["close"] /= 2
        for r in rows:
            if r["date"] == div_day:
                r["tr_1d"] = r["ret_1d"] + 0.02
        self.split_day, self.div_day = split_day, div_day
        # Always hold SEC_000000 (and four others) so the corporate actions hit a position.
        self.code = MOMENTUM.replace(
            "return {s: float(np.prod(1 + g.tr_1d) - 1) for s, g in f.groupby(\"security_id\")}",
            "out = {s: float(np.prod(1 + g.tr_1d) - 1) for s, g in f.groupby(\"security_id\")}\n"
            "    out[\"SEC_000000\"] = 99.0\n    return out")
        self.src = src

    def test_nav_reconciles_every_day_through_a_split_and_a_dividend(self):
        res, rows = sim([self.code], self.src, self.days[70], self.days[-1], capital=100000.0)
        self.assertLess(res["reconciliation"]["max_nav_error"], 1e-6)
        self.assertLess(res["reconciliation"]["max_pnl_error"], 1e-6)
        self.assertGreater(res["summary"]["dividends"], 0)
        div_row = next(r for r in rows["sim_portfolio_daily"] if r["date"] == self.div_day)
        self.assertGreater(div_row["dividends"], 0)
        before = next(p for p in rows["sim_positions"] if p["date"] == self.days[119] and p["security_id"] == "SEC_000000")
        after = next(p for p in rows["sim_positions"] if p["date"] == self.split_day and p["security_id"] == "SEC_000000")
        self.assertAlmostEqual(after["shares"] / before["shares"], 2.0, delta=0.25, msg="the split doubled the shares")
        # Trade P&L + dividends - costs (+ the open lots' unrealized P&L) = the change in NAV.
        total = sum(t["pnl"] for t in rows["sim_trades"])
        self.assertAlmostEqual(total, res["summary"]["final_nav"] - 100000.0, delta=0.05)
        # Reinvested (the default), the dividend buys more of the stock at that close, as the evaluator's tr_1d
        # assumes: the equity curves match exactly, and the reinvestment is a fill of its own.
        ev = engine.evaluate(self.code, source=self.src, policies=synthetic.POLICIES,
                             params={"start": self.days[70], "end": self.days[-1]}, config=COSTS)
        gaps = [abs(a - b) for a, b in zip(ev["series"]["series"]["equity"], res["series"]["series"]["equity"])]
        self.assertLess(max(gaps), 1e-9)
        drip = [o for o in rows["sim_orders"] if o["reason"] == "dividend"]
        self.assertTrue(drip and all(o["fill_date"] == self.div_day and o["cost"] == 0 for o in drip))
        # Kept in cash, it misses the stock's moves until the next rebalance: a small gap, and still reconciled.
        cash, _ = sim([self.code], self.src, self.days[70], self.days[-1], capital=100000.0, dividends="cash")
        gap = abs(ev["series"]["series"]["equity"][-1] - cash["series"]["series"]["equity"][-1])
        self.assertTrue(0 < gap < 2e-4, gap)
        self.assertLess(cash["reconciliation"]["max_pnl_error"], 1e-6)

    def test_same_config_same_ledger(self):
        a, ra = sim([self.code], self.src, self.days[70], self.days[-1], seed=42)
        b, rb = sim([self.code], self.src, self.days[70], self.days[-1], seed=42)
        self.assertEqual(a["ledger_hash"], b["ledger_hash"])
        self.assertEqual(ra, rb)
        c, _ = sim([self.code], self.src, self.days[70], self.days[-1], seed=42, costs={"slippage_bps": 10})
        self.assertNotEqual(a["ledger_hash"], c["ledger_hash"])

    def test_orders_link_to_the_idea_and_its_signal(self):
        _, rows = sim([self.code], self.src, self.days[70], self.days[-1])
        o = rows["sim_orders"][0]
        self.assertEqual(o["idea_id"], "idea-0")
        self.assertEqual(o["reason"], "entry")
        self.assertEqual(set(o["signal"]), {"date", "score", "rank", "of"})
        self.assertLess(o["signal"]["date"], o["fill_date"], "decided at a close, filled at the next")
        self.assertTrue(all(t["exit_reason"] in ("replaced", "open", "rebalance") for t in rows["sim_trades"]))


class Exits(unittest.TestCase):
    def test_stop_fills_the_session_after_it_triggers(self):
        days = synthetic.weekdays("2020-01-01", 160)
        crash = {("SEC_000000", days[100]): -0.4}
        src, _ = synthetic.market(n_sec=10, n_days=160, seed=2, overrides=crash)
        code = MOMENTUM.replace(
            "return {s: float(np.prod(1 + g.tr_1d) - 1) for s, g in f.groupby(\"security_id\")}",
            "out = {s: float(np.prod(1 + g.tr_1d) - 1) for s, g in f.groupby(\"security_id\")}\n"
            "    out[\"SEC_000000\"] = 99.0\n    return out")
        _, rows = sim([code], src, days[70], days[-1], exits={"stop": 0.15})
        stops = [t for t in rows["sim_trades"] if t["exit_reason"] == "stop"]
        self.assertTrue(stops, [t["exit_reason"] for t in rows["sim_trades"]])
        self.assertEqual(stops[0]["security_id"], "SEC_000000")
        self.assertEqual(stops[0]["exit_date"], days[101])
        # Not re-bought until a signal after the stop: no SEC_000000 entry filled on the rebalance that same week.
        reentry = [o for o in rows["sim_orders"] if o["security_id"] == "SEC_000000" and o["reason"] == "entry"
                   and o["fill_date"] > days[101]]
        self.assertTrue(all(o["signal"]["date"] > days[100] for o in reentry))

    def test_horizon_and_review_exits(self):
        src, days = synthetic.market(n_sec=10, n_days=200, seed=4)
        monthly = MOMENTUM.replace('"rebalance": "weekly"', '"rebalance": "monthly"').replace('"horizon_days": 20', '"horizon_days": 5')
        _, rows = sim([monthly], src, days[70], days[-1], exits={"horizon": True})
        self.assertIn("horizon", {t["exit_reason"] for t in rows["sim_trades"]})
        reviewed = monthly + '\ndef review(ctx, held):\n    return {s: "invalidation" for s in held if s == sorted(held)[0]}\n'
        _, rows = sim([reviewed], src, days[70], days[-1])
        self.assertIn("invalidation", {t["exit_reason"] for t in rows["sim_trades"]})

    def test_take_profit_fixed(self):
        src, days = synthetic.market(n_sec=10, n_days=200, seed=8, sigma=0.03)
        _, rows = sim([MOMENTUM], src, days[70], days[-1], exits={"take_profit": 0.05})
        tps = [t for t in rows["sim_trades"] if t["exit_reason"] == "take_profit"]
        self.assertTrue(tps)
        # Decided at a close at +5% or more, filled at the next close: on average still well up.
        self.assertGreater(sum(t["return"] for t in tps) / len(tps), 0.03)
        self.assertTrue(all(t["days_held"] >= 1 for t in tps))


class Sizing(unittest.TestCase):
    def test_quarter_kelly_with_position_and_gross_caps(self):
        src, days = synthetic.market(n_sec=30, n_days=320, seed=3, momentum=1.0)
        res, rows = sim([MOMENTUM], src, days[70], days[-1], sizing={"mode": "quarter_kelly", "min_history": 20},
                        constraints={"position_cap": 0.05, "gross": 1.0})
        self.assertTrue(all(abs(p["weight"]) <= 0.05 + 0.02 for p in rows["sim_positions"]), "capped (plus drift)")
        self.assertTrue(all((r["gross"] or 0) <= 1.0 + 1e-6 for r in rows["sim_portfolio_daily"]))
        self.assertLess(res["summary"]["avg_gross"], 0.3)

    def test_several_ideas_one_book_and_attribution(self):
        src, days = synthetic.market(n_sec=30, n_days=260, seed=9, momentum=1.0)
        res, rows = sim([MOMENTUM, REVERSAL], src, days[70], days[-1], allocation={"mode": "equal"})
        ideas = {p["idea_id"] for p in rows["sim_positions"]}
        self.assertEqual(ideas, {"idea-0", "idea-1"})
        by_idea = sum(g["pnl"] for g in res["attribution"]["by_idea"])
        self.assertAlmostEqual(by_idea, res["summary"]["final_nav"] - res["summary"]["capital"], delta=1.0)
        self.assertLess(res["reconciliation"]["max_pnl_error"], 1e-6)
        self.assertTrue(all((r["gross"] or 0) <= 1.0 + 1e-6 for r in rows["sim_portfolio_daily"]))
        rp, _ = sim([MOMENTUM, REVERSAL], src, days[70], days[-1], allocation={"mode": "risk_parity"})
        self.assertNotEqual(rp["ledger_hash"], res["ledger_hash"])

    def test_hard_to_borrow_names_are_not_shorted(self):
        src, days = synthetic.market(n_sec=10, n_days=160, seed=6)
        short = MOMENTUM.replace('"side": "long"', '"side": "short"').replace('"top_n": 5', '"top_n": 2')
        _, rows = sim([short], src, days[70], days[-1])
        shorted = {o["security_id"] for o in rows["sim_orders"] if o["side"] == "short"}
        self.assertTrue(shorted)
        victim = sorted(shorted)[0]
        _, rows = sim([short], src, days[70], days[-1], hard_to_borrow=[victim])
        self.assertNotIn(victim, {o["security_id"] for o in rows["sim_orders"] if o["side"] == "short"})


class Job(unittest.TestCase):
    def test_simulate_action_and_errors_name_the_idea(self):
        from pipeline.strategy.job import run

        src, days = synthetic.market(n_sec=10, n_days=120, seed=1)
        base = {"action": "simulate", "policies": synthetic.POLICIES, "simulation_id": "s1", "config": COSTS,
                "params": {"start": days[70], "end": days[-1]}}
        ok = run({**base, "ideas": [{"id": "a", "code": MOMENTUM}]}, src)
        self.assertTrue(ok["ok"], ok)
        self.assertEqual(ok["simulation"]["ideas"][0]["id"], "a")
        broken = MOMENTUM.replace("return {s:", "x = 1 / 0\n    return {s:")
        bad = run({**base, "ideas": [{"id": "a", "code": MOMENTUM}, {"id": "b", "code": broken}]}, src)
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["error"]["idea_id"], "b")
        self.assertEqual(bad["error"]["type"], "ZeroDivisionError")
        self.assertEqual(bad["error"]["frames"][-1]["code"], "x = 1 / 0")


if __name__ == "__main__":
    unittest.main()
