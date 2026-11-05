"""#106: evaluator metrics against reference values (empyrical-reloaded 0.7.2) and the deflated Sharpe paper."""
import math
import random
import unittest

from pipeline.strategy import engine, metrics as m, synthetic

R = [0.012, -0.004, 0.007, -0.021, 0.015, 0.003, -0.009, 0.011, -0.002, 0.006, -0.013, 0.008, 0.004, -0.006, 0.010]
B = [0.008, -0.002, 0.005, -0.015, 0.010, 0.001, -0.006, 0.007, -0.001, 0.004, -0.010, 0.006, 0.003, -0.004, 0.007]
# empyrical.cagr / sharpe_ratio / sortino_ratio / max_drawdown / annual_volatility / calmar_ratio / alpha_beta
EMPYRICAL = {"cagr": 0.4050662550348967, "sharpe": 2.1603635403213715, "sortino": 3.1492971103337677,
             "max_drawdown": -0.020999999999999987, "ann_vol": 0.1633058480275584, "calmar": 19.288869287376045,
             "alpha": 0.04113178160063158, "beta": 1.4308077065579845, "total": 0.020449404097950596}


class Reference(unittest.TestCase):
    def test_matches_empyrical(self):
        self.assertAlmostEqual(m.cagr(R), EMPYRICAL["cagr"], places=12)
        self.assertAlmostEqual(m.sharpe(R), EMPYRICAL["sharpe"], places=12)
        self.assertAlmostEqual(m.sortino(R), EMPYRICAL["sortino"], places=12)
        self.assertAlmostEqual(m.max_drawdown(R), EMPYRICAL["max_drawdown"], places=12)
        self.assertAlmostEqual(m.ann_vol(R), EMPYRICAL["ann_vol"], places=12)
        self.assertAlmostEqual(m.calmar(R), EMPYRICAL["calmar"], places=9)
        self.assertAlmostEqual(m.total_return(R), EMPYRICAL["total"], places=12)
        o = m.ols(R, {"mkt": B})
        self.assertAlmostEqual(o["alpha_annual"], EMPYRICAL["alpha"], places=12)
        self.assertAlmostEqual(o["betas"]["mkt"], EMPYRICAL["beta"], places=12)

    def test_deflated_sharpe_paper_example(self):
        # Bailey & López de Prado (2014), numerical example: annualized SR 2.5 over T = 1250 days (250 a year),
        # skew -3, kurtosis 10, after N = 100 trials whose annualized Sharpe ratios have variance 0.5.
        sr0 = m.expected_max_sharpe(100, 0.5 / 250)
        self.assertAlmostEqual(sr0, 0.1132, places=4)  # ≈ 1.79 annualized
        self.assertAlmostEqual(m.probabilistic_sharpe(2.5 / math.sqrt(250), sr0, 1250, -3, 10), 0.9004, places=4)
        self.assertEqual(m.expected_max_sharpe(1, 0.5), 0.0)  # one trial: plain PSR against zero

    def test_hac_regression_recovers_known_betas(self):
        rnd = random.Random(3)
        x = [rnd.gauss(0, 0.01) for _ in range(800)]
        z = [rnd.gauss(0, 0.01) for _ in range(800)]
        y = [0.0004 + 1.5 * a - 0.5 * b + rnd.gauss(0, 0.002) for a, b in zip(x, z)]
        o = m.ols(y, {"x": x, "z": z})
        self.assertAlmostEqual(o["betas"]["x"], 1.5, delta=0.03)
        self.assertAlmostEqual(o["betas"]["z"], -0.5, delta=0.03)
        self.assertGreater(o["t"]["x"], 50)
        self.assertGreater(o["alpha_t"], 3)
        self.assertGreater(o["r2"], 0.95)

    def test_small_helpers(self):
        self.assertAlmostEqual(m.hit_rate([0.01, -0.01, 0.0, 0.02]), 2 / 3)
        self.assertEqual(m.histogram([-2, -0.04, 0.0, 0.07, 9], [-1, 0, 0.05, 1])["counts"], [2, 1, 2])
        rs = m.rolling_sharpe(R, window=5)
        self.assertEqual(rs[:4], [None] * 4)
        self.assertAlmostEqual(rs[4], m.sharpe(R[:5]))
        ex = m.excess(R, B)
        self.assertAlmostEqual(ex["excess_cagr"], m.cagr(R) - m.cagr(B))


class InTheRecord(unittest.TestCase):
    CODE = '''import numpy as np
META = {"side": "long_short", "horizon_days": 20, "rebalance": "weekly", "top_n": 4}

def signal(ctx):
    f = ctx.read_df("prices_daily", columns=["security_id", "tr_1d"], lookback_days=60)
    return {s: float(np.prod(1 + g.tr_1d) - 1) for s, g in f.groupby("security_id")}
'''

    def evaluate(self, trials=None):
        src, days = synthetic.market(n_sec=24, n_days=420, seed=11)
        params = {"start": days[230], "end": days[-1], **({"trials": trials} if trials else {})}
        return engine.evaluate(self.CODE, source=src, policies=synthetic.POLICIES, params=params)

    def test_record_has_the_full_metric_set(self):
        r = self.evaluate()
        for k in ("sortino", "calmar", "hit_rate", "annual_turnover"):
            self.assertIn(k, r["summary"])
        self.assertEqual(set(r["excess"]), {"spx", "sector"})
        self.assertIsNotNone(r["excess"]["sector"])
        self.assertEqual(set(r["by_regime"]), {"trend", "volatility"})
        self.assertEqual(set(r["by_regime"]["volatility"]), {"high", "normal"})
        self.assertEqual(r["factors"]["factors"], ["low_vol", "market", "momentum", "quality", "value"])
        self.assertIn("alpha_t", r["factors"])
        self.assertEqual({x["sector"] for x in r["by_sector"]}, {"Tech", "Energy"})
        self.assertGreater(r["trade_stats"]["count"], 10)
        self.assertEqual(sum(r["trade_stats"]["histogram"]["counts"]), r["trade_stats"]["count"])
        s = r["series"]["series"]
        self.assertEqual(len(s["drawdown"]), len(s["rolling_sharpe_126"]))
        self.assertAlmostEqual(min(s["drawdown"]), r["summary"]["max_drawdown"], places=8)

    def test_trial_count_changes_the_dsr_but_not_the_record(self):
        one, many = self.evaluate(), self.evaluate({"count": 500, "sharpe_variance": 0.003})
        self.assertEqual(one["record_hash"], many["record_hash"])
        self.assertEqual(one["trial_context"]["trials"], 1)
        self.assertEqual(many["trial_context"]["trials"], 500)
        self.assertLess(many["trial_context"]["dsr"], one["trial_context"]["dsr"])


if __name__ == "__main__":
    unittest.main()
