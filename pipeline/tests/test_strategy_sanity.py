"""#107: the evaluator sanity suite (the M3 exit gate). The 2022 momentum check runs on real data (see
docs/strategies.md); here its logic is checked on records."""
import unittest

from pipeline.strategy import sanity


class Sanity(unittest.TestCase):
    def test_random_signal_has_a_sharpe_of_about_zero(self):
        r = sanity.random_signal()
        self.assertTrue(r["ok"], r)

    def test_lookahead_canary_is_blocked_and_has_teeth(self):
        r = sanity.lookahead_canary()
        self.assertTrue(r["ok"], r)
        self.assertGreater(r["sharpe_without_cut"], 5)

    def test_rerun_is_identical(self):
        self.assertTrue(sanity.reproducibility()["ok"])

    def test_momentum_2022_check(self):
        crash = {"folds": [{"fold": "2021", "total_return": 0.2, "max_drawdown": -0.05},
                           {"fold": "2022", "total_return": -0.18, "max_drawdown": -0.27}]}
        self.assertTrue(sanity.momentum_2022(crash)["ok"])
        calm = {"folds": [{"fold": "2022", "total_return": 0.04, "max_drawdown": -0.06}]}
        self.assertFalse(sanity.momentum_2022(calm)["ok"])
        self.assertFalse(sanity.momentum_2022({"folds": []})["ok"])


if __name__ == "__main__":
    unittest.main()
