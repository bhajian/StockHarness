"""#325: name subsets, picked on one period and checked on the next against random subsets."""
import random
import unittest

from pipeline.strategy import synthetic
from pipeline.strategy.engine import EvaluationError
from pipeline.strategy import engine
from pipeline.strategy.pool_cache import PoolCache
from pipeline.strategy.subset import find_subset

COSTS = {"commission_bps": 1, "slippage_bps": 5, "borrow_cost_bps_default": 50, "delisting_return": -0.3,
         "execution_lag_days": 1, "sizing": {"gross_limit": 1.0}}
# A daily one-day reversal: it works only on names whose returns revert (here 6 of 80); elsewhere it is noise.
REVERSAL = '''META = {"side": "long", "horizon_days": 1, "rebalance": "daily", "top_n": 5}

def signal(ctx):
    f = ctx.read_df("prices_daily", columns=["security_id", "tr_1d", "date"], lookback_days=5)
    last = f.sort_values("date").groupby("security_id").tail(1)
    return dict(zip(last.security_id, -last.tr_1d))
'''
WINNERS = [f"SEC_{k:06d}" for k in range(6)]


def market_with_winners(seed=5):
    """The 6 WINNERS revert at a two-day lag (a trade on day d's close earns day d+2's return)."""
    rnd = random.Random(seed * 13)
    days = synthetic.weekdays("2020-01-01", 420)
    over = {}
    for s in WINNERS:
        hist = [0.0, 0.0]
        for d in days:
            hist.append(-0.6 * hist[-2] + rnd.gauss(0.0, 0.02))
            over[(s, d)] = hist[-1]
    return synthetic.market(n_sec=80, n_days=420, seed=seed, sigma=0.02, overrides=over)


def subset(src, days, **select):
    return find_subset(REVERSAL, source=src, policies=synthetic.POLICIES, config=COSTS,
                       params={"start": days[70], "end": days[-1]},
                       select={"top_k": 6, "n_random": 19, **select})


class Subsets(unittest.TestCase):
    def test_the_pool_cache_gives_identical_records(self):
        src, days = market_with_winners()
        pool = [f"SEC_{k:06d}" for k in range(0, 80, 3)]
        cached = PoolCache(src, pool)
        for names in (pool[:6], pool[5:11], pool[:6]):
            params = {"start": days[200], "end": days[-1], "symbols": names, "top_n": 3}
            a = engine.evaluate(REVERSAL, source=src, policies=synthetic.POLICIES, config=COSTS, params=params)
            b = engine.evaluate(REVERSAL, source=cached, policies=synthetic.POLICIES, config=COSTS, params=params)
            self.assertEqual(a["record_hash"], b["record_hash"])
            self.assertEqual(a["by_name"], b["by_name"])
        self.assertGreater(cached.stats["hits"], 0, "the second and third runs read from the cache")

    def test_picks_from_the_parent_evaluation_when_it_has_results_by_year(self):
        src, days = market_with_winners()
        params = {"start": days[70], "end": days[-1]}
        parent = engine.evaluate(REVERSAL, source=src, policies=synthetic.POLICIES, config=COSTS, params=params)
        r = find_subset(REVERSAL, source=src, policies=synthetic.POLICIES, config=COSTS, params=params,
                        select={"top_k": 6, "n_random": 19}, parent=parent)
        s = r["subset"]
        self.assertEqual(s["picked_from"], "the evaluation's results by year")
        self.assertEqual(s["check_period"]["start"][:4], "2021", "split at a year boundary")
        self.assertEqual(s["pick_period"]["end"][:4], "2020")
        self.assertEqual(sorted(c["security_id"] for c in s["chosen"]), WINNERS)
        self.assertTrue(s["passed"], s["random"])
        self.assertIsNone(s["pick"])
        self.assertIsNotNone(s["whole"]["sharpe"])

    def test_finds_the_names_that_work_and_checks_them_out_of_sample(self):
        src, days = market_with_winners()
        r = subset(src, days)
        s = r["subset"]
        chosen = [c["security_id"] for c in s["chosen"]]
        self.assertEqual(sorted(chosen), WINNERS)
        # The record is the check run: only the chosen names, only after the pick period.
        self.assertEqual(r["period"]["start"], s["check_period"]["start"])
        self.assertGreater(s["check_period"]["start"], s["pick_period"]["end"])
        self.assertEqual(sorted(r["params"]["symbols"]), sorted(chosen))
        self.assertEqual(s["top_n"], 3, "the signal still chooses: half the subset")
        self.assertTrue(set(r["holdings"]["weights"]) <= set(chosen))
        self.assertEqual(s["random"]["n"], 19)
        self.assertTrue(s["passed"], s)
        self.assertLessEqual(s["random"]["p_value"], 0.05 + 1e-9)
        self.assertGreater(s["check"]["sharpe"], s["random"]["mean_sharpe"])
        self.assertGreater(s["check"]["sharpe"], s["whole"]["sharpe"], "better than the whole universe")

    def test_same_inputs_give_the_same_record(self):
        src, days = market_with_winners()
        a, b = subset(src, days), subset(src, days)
        self.assertEqual(a["record_hash"], b["record_hash"])
        self.assertEqual(a["subset"]["random"], b["subset"]["random"])

    def test_noise_is_not_a_subset(self):
        src, days = synthetic.market(n_sec=80, n_days=420, seed=11)
        s = subset(src, days)["subset"]
        self.assertFalse(s["passed"], s["random"])

    def test_refusals(self):
        src, days = market_with_winners()
        with self.assertRaisesRegex(EvaluationError, "120 trading days"):
            find_subset(REVERSAL, source=src, policies=synthetic.POLICIES, config=COSTS,
                        params={"start": days[70], "end": days[150]})
        with self.assertRaisesRegex(EvaluationError, "metric"):
            subset(src, days, metric="luck")
        with self.assertRaisesRegex(EvaluationError, "n_random must be between 19"):
            subset(src, days, n_random=10)
        with self.assertRaisesRegex(EvaluationError, "at least 5"):
            subset(src, days, min_days=10_000)


if __name__ == "__main__":
    unittest.main()
