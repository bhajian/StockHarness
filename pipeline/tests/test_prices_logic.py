import unittest
from datetime import date

from pipeline.layer2 import prices_logic as p


class TestSplitFactors(unittest.TestCase):
    def test_backward_cumulative_4for1(self):
        dates = [date(2020, 8, 28), date(2020, 8, 31)]  # split ex on 8/31, ratio 4
        f = p.split_adjustment_factors(dates, [(date(2020, 8, 31), 4.0)])
        self.assertAlmostEqual(f[date(2020, 8, 28)], 0.25)  # pre-split scaled to new basis
        self.assertAlmostEqual(f[date(2020, 8, 31)], 1.0)


class TestSymbolRows(unittest.TestCase):
    def test_clean_split_zero_return_and_continuous_adj(self):
        bars = [
            {"date": date(2020, 8, 28), "open": 400, "high": 405, "low": 395, "close": 400, "volume": 10},
            {"date": date(2020, 8, 31), "open": 100, "high": 101, "low": 99, "close": 100, "volume": 40},
        ]
        rows = p.compute_symbol_rows(bars, {}, {date(2020, 8, 31): 4.0})
        self.assertAlmostEqual(rows[1]["ret_1d"], 0.0)  # (100*4)/400 - 1
        self.assertAlmostEqual(rows[0]["adj_close"], 100.0)  # 400 * 0.25
        self.assertAlmostEqual(rows[1]["adj_close"], 100.0)

    def test_already_adjusted_bars_are_not_adjusted_again(self):
        # #240: FMP closes are split-adjusted (NVDA 10:1 on 2024-06-10: 120.89 -> 121.79, not 1208.9 -> 121.79).
        bars = [
            {"date": date(2024, 6, 7), "open": 121, "high": 122, "low": 120, "close": 120.89, "volume": 10},
            {"date": date(2024, 6, 10), "open": 120, "high": 123, "low": 117, "close": 121.79, "volume": 10},
        ]
        rows = p.compute_symbol_rows(bars, {}, {date(2024, 6, 10): 10.0})
        self.assertAlmostEqual(rows[1]["ret_1d"], 121.79 / 120.89 - 1)
        self.assertEqual([r["adj_factor"] for r in rows], [1.0, 1.0])
        self.assertNotIn("jump_no_action", rows[1]["dq_flags"])

    def test_future_or_unmatched_splits_are_ignored(self):
        bars = [
            {"date": date(2024, 1, 2), "open": 50, "high": 50, "low": 50, "close": 50, "volume": 5},
            {"date": date(2024, 1, 3), "open": 51, "high": 51, "low": 51, "close": 51, "volume": 5},
        ]
        rows = p.compute_symbol_rows(bars, {}, {date(2024, 2, 1): 2.0})  # announced, not yet effective
        self.assertEqual([r["adj_factor"] for r in rows], [1.0, 1.0])
        self.assertEqual(p.effective_splits(bars, {date(2024, 2, 1): 2.0}), {})

    def test_reverse_split_unadjusted_source(self):
        bars = [
            {"date": date(2024, 1, 2), "open": 1, "high": 1, "low": 1, "close": 1.0, "volume": 5},
            {"date": date(2024, 1, 3), "open": 10, "high": 10, "low": 10, "close": 10.2, "volume": 5},
        ]
        rows = p.compute_symbol_rows(bars, {}, {date(2024, 1, 3): 0.1})  # 1-for-10
        self.assertAlmostEqual(rows[1]["ret_1d"], 0.02)
        self.assertAlmostEqual(rows[0]["adj_close"], 10.0)

    def test_total_return_includes_dividend(self):
        bars = [
            {"date": date(2024, 1, 2), "open": 100, "high": 100, "low": 100, "close": 100, "volume": 5},
            {"date": date(2024, 1, 3), "open": 101, "high": 101, "low": 101, "close": 101, "volume": 5},
        ]
        rows = p.compute_symbol_rows(bars, {date(2024, 1, 3): 1.0}, {})
        self.assertAlmostEqual(rows[1]["ret_1d"], 0.01)
        self.assertAlmostEqual(rows[1]["tr_1d"], 0.02)  # (101 + 1)/100 - 1

    def test_dq_flags(self):
        bars = [
            {"date": date(2024, 1, 2), "open": 10, "high": 5, "low": 10, "close": 8, "volume": 0},  # high<low, zero_vol
            {"date": date(2024, 1, 3), "open": 8, "high": 210, "low": 8, "close": 200, "volume": 100},  # +2400% jump
        ]
        rows = p.compute_symbol_rows(bars, {}, {})
        self.assertIn("high_lt_low", rows[0]["dq_flags"])
        self.assertIn("zero_volume", rows[0]["dq_flags"])
        self.assertIn("jump_no_action", rows[1]["dq_flags"])


if __name__ == "__main__":
    unittest.main()
