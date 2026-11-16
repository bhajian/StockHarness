"""#468: the placebo and known-answer suite passes on clean data and catches a return-math bug."""
import unittest

from pipeline.strategy import placebo, synthetic

COSTS = {"commission_bps": 1, "slippage_bps": 5, "borrow_cost_bps_default": 50, "execution_lag_days": 1,
         "sizing": {"gross_limit": 1.0}}


class Suite(unittest.TestCase):
    def test_clean_data_passes(self):
        src, days = synthetic.market(n_sec=40, n_days=300, seed=11)
        r = placebo.run_suite(src, synthetic.POLICIES, start=days[30], end=days[-1], config=COSTS, seeds=6,
                              names=["SEC_000000"])
        by = {c["check"]: c for c in r["checks"]}
        self.assertTrue(by["buy_and_hold:SEC_000000"]["passed"], by["buy_and_hold:SEC_000000"])
        self.assertTrue(by["future_peek"]["passed"], by["future_peek"])
        self.assertTrue(by["costs"]["passed"], by["costs"])
        self.assertTrue(by["random_signals"]["passed"], by["random_signals"])
        self.assertIsNone(by["benchmark"]["passed"], "no SPY in the synthetic market")
        self.assertTrue(r["passed"])

    def test_a_dividend_on_the_wrong_basis_is_caught(self):
        """An #443-style bug: tr_1d gains 7% on one day while the price doesn't move."""
        src, days = synthetic.market(n_sec=20, n_days=200, seed=12)
        for row in src.collections["prices_daily"]:
            if row["security_id"] == "SEC_000001" and row["date"] == days[100]:
                row["tr_1d"] = row["ret_1d"] + 0.07
        r = placebo.run_suite(src, synthetic.POLICIES, start=days[30], end=days[-1], config=COSTS, seeds=2,
                              names=["SEC_000001"])
        bh = next(c for c in r["checks"] if c["check"] == "buy_and_hold:SEC_000001")
        self.assertFalse(bh["passed"], bh)
        self.assertFalse(r["passed"])
