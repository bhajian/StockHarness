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

    def test_as_paid_dividend_on_split_adjusted_bars(self):
        """#443: AVGO 2023-03-21, close 63.68 split-adjusted (10:1 on 2024-07-15), dividend paid 4.60."""
        bars = [
            {"date": date(2023, 3, 20), "open": 63, "high": 64, "low": 62, "close": 63.20, "volume": 5},
            {"date": date(2023, 3, 21), "open": 63, "high": 64, "low": 63, "close": 63.68, "volume": 5},
            {"date": date(2024, 7, 12), "open": 170, "high": 172, "low": 168, "close": 170.0, "volume": 5},
            {"date": date(2024, 7, 15), "open": 171, "high": 172, "low": 168, "close": 171.0, "volume": 5},
        ]
        rows = p.compute_symbol_rows(bars, {date(2023, 3, 21): 4.60}, {date(2024, 7, 15): 10.0})
        r = rows[1]
        self.assertAlmostEqual(r["dividend"], 0.46)
        self.assertAlmostEqual(r["tr_1d"] - r["ret_1d"], 0.46 / 63.20, places=9)  # 0.73%, not 7.3%
        self.assertLess(r["tr_1d"] - r["ret_1d"], 0.05)
        self.assertAlmostEqual(r["close_raw"], 636.8)
        self.assertAlmostEqual(rows[3]["close_raw"], 171.0)  # on and after the ex-date: as traded already
        self.assertEqual([x["adj_factor"] for x in rows], [1.0] * 4)  # the bars reflect the split: not again

    def test_adjusted_dividend_only_when_the_paid_amount_is_missing(self):
        bars = [
            {"date": date(2023, 3, 20), "open": 63, "high": 64, "low": 62, "close": 63.20, "volume": 5},
            {"date": date(2023, 3, 21), "open": 63, "high": 64, "low": 63, "close": 63.68, "volume": 5},
            {"date": date(2024, 7, 15), "open": 171, "high": 172, "low": 168, "close": 171.0, "volume": 5},
        ]
        rows = p.compute_symbol_rows(bars, {}, {date(2024, 7, 15): 10.0}, {date(2023, 3, 21): 0.46})
        self.assertAlmostEqual(rows[1]["dividend"], 0.46)

    def test_unadjusted_source_keeps_the_dividend_and_close_as_is(self):
        # Bars not adjusted for a later 2:1 split (the split is applied, so close is as traded).
        bars = [
            {"date": date(2024, 1, 2), "open": 100, "high": 100, "low": 100, "close": 100, "volume": 5},
            {"date": date(2024, 1, 3), "open": 101, "high": 101, "low": 101, "close": 101, "volume": 5},
            {"date": date(2024, 2, 1), "open": 50, "high": 51, "low": 50, "close": 50.5, "volume": 5},
        ]
        rows = p.compute_symbol_rows(bars, {date(2024, 1, 3): 1.0}, {date(2024, 2, 1): 2.0})
        self.assertAlmostEqual(rows[1]["dividend"], 1.0)
        self.assertAlmostEqual(rows[1]["tr_1d"], 0.02)
        self.assertAlmostEqual(rows[1]["close_raw"], 101)

    def test_announced_split_does_not_change_the_traded_close(self):
        bars = [
            {"date": date(2024, 1, 2), "open": 50, "high": 50, "low": 50, "close": 50, "volume": 5},
            {"date": date(2024, 1, 3), "open": 51, "high": 51, "low": 51, "close": 51, "volume": 5},
        ]
        rows = p.compute_symbol_rows(bars, {}, {date(2024, 2, 1): 2.0})
        self.assertEqual([r["close_raw"] for r in rows], [50, 51])

    def test_ambiguous_basis_takes_the_plausible_reading(self):
        """#481: NYMT 2020-09-30, a later 1:4 reverse split, no adjDividend, FMP's 0.484 already on today's basis."""
        bars = [
            {"date": date(2020, 9, 29), "open": 10, "high": 10.5, "low": 10, "close": 10.2, "volume": 5},
            {"date": date(2020, 9, 30), "open": 10, "high": 10.3, "low": 9.9, "close": 10.2, "volume": 5},
            {"date": date(2023, 3, 9), "open": 5, "high": 5, "low": 5, "close": 5.0, "volume": 5},
            {"date": date(2023, 3, 10), "open": 5, "high": 5, "low": 5, "close": 5.0, "volume": 5},
        ]
        rows = p.compute_symbol_rows(bars, {date(2020, 9, 30): 0.484}, {date(2023, 3, 9): 0.25})
        self.assertAlmostEqual(rows[1]["close_raw"], 2.55)
        self.assertAlmostEqual(rows[1]["dividend"], 0.484)
        self.assertIn("dividend_basis_uncertain", rows[1]["dq_flags"])
        self.assertLess(rows[1]["tr_1d"] - rows[1]["ret_1d"], 0.05)

    def test_junk_dividend_leaves_the_total_return(self):
        """#481: NSTD 2024-04-15, a 10.71 dividend on a 0.11 close."""
        bars = [
            {"date": date(2024, 4, 12), "open": 0.11, "high": 0.12, "low": 0.11, "close": 0.115, "volume": 5},
            {"date": date(2024, 4, 15), "open": 0.11, "high": 0.12, "low": 0.11, "close": 0.113, "volume": 5},
        ]
        rows = p.compute_symbol_rows(bars, {date(2024, 4, 15): 10.71169}, {})
        self.assertIsNone(rows[1]["dividend"])
        self.assertAlmostEqual(rows[1]["tr_1d"], rows[1]["ret_1d"])
        self.assertIn("implausible_dividend", rows[1]["dq_flags"])

    def test_real_special_dividend_is_kept(self):
        # TRMD-like: 2.40 on a 34.60 close, no split: kept, no flag.
        bars = [
            {"date": date(2026, 9, 9), "open": 37, "high": 37, "low": 36, "close": 37.0, "volume": 5},
            {"date": date(2026, 9, 10), "open": 35, "high": 35, "low": 34, "close": 34.6, "volume": 5},
        ]
        rows = p.compute_symbol_rows(bars, {date(2026, 9, 10): 2.4}, {}, {date(2026, 9, 10): 2.4})
        self.assertAlmostEqual(rows[1]["dividend"], 2.4)
        self.assertEqual([f for f in rows[1]["dq_flags"] if "dividend" in f], [])

    def test_adjusted_amount_disagreeing_takes_the_smaller(self):
        r = p.bar_dividend(4.6, 0.046, 10.0, 63.2)
        self.assertEqual(r, (0.046, ["dividend_basis_uncertain"]))
        div, flags = p.bar_dividend(4.6, 0.46, 10.0, 63.2)
        self.assertAlmostEqual(div, 0.46)
        self.assertEqual(flags, [])

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


class TestJunkAndMergedTickers(unittest.TestCase):
    """#255, from live data: BBLGW's junk 4e-19 closes and DTE Energy's preferreds merged into its series."""

    def bar(self, d, close, sym="X"):
        return {"symbol": sym, "date": d, "open": close, "high": close, "low": close, "close": close, "volume": 1}

    def test_junk_quotes_and_x10_days_carry_no_return(self):
        days = ["2022-03-08", "2022-03-09", "2022-03-10", "2022-03-11", "2022-03-14", "2022-03-15", "2022-03-16"]
        closes = [234.47, 225.45, 207.41, 4.3e-19, 245.29, 5.1e-19, 360.72]
        rows = p.compute_symbol_rows([self.bar(d, c) for d, c in zip(days, closes)], {}, {})
        tr = [r["tr_1d"] for r in rows]
        self.assertIsNone(tr[3], "a junk quote has no return")
        self.assertIn("implausible_price", rows[3]["dq_flags"])
        self.assertAlmostEqual(tr[4], 245.29 / 207.41 - 1, places=12, msg="measured from the last real close")
        self.assertAlmostEqual(tr[6], 360.72 / 245.29 - 1, places=12)
        self.assertTrue(all(t is None or abs(t) < 1 for t in tr), tr)
        spike = p.compute_symbol_rows([self.bar("2023-01-02", 0.2), self.bar("2023-01-03", 300.0)], {}, {})
        self.assertIsNone(spike[1]["tr_1d"])
        self.assertIn("return_suppressed", spike[1]["dq_flags"])
        split = p.compute_symbol_rows(
            [self.bar(date(2020, 8, 28), 400.0), self.bar(date(2020, 8, 31), 10.0)], {}, {date(2020, 8, 31): 40.0}
        )
        self.assertAlmostEqual(split[1]["tr_1d"], 0.0, places=12, msg="a split explains the ÷40")

    def test_one_ticker_per_date_for_a_security_with_several(self):
        tickers = [
            {"value": "DTE", "valid_from": "2016-01-04", "valid_to": None},
            {"value": "DTZ", "valid_from": "2016-01-04", "valid_to": "2019-01-02"},
        ]
        bars = [self.bar("2018-05-01", 80.0, "DTE"), self.bar("2018-05-01", 25.0, "DTZ"),
                self.bar("2018-05-02", 81.0, "DTZ"), self.bar("2018-05-02", 26.0, "DTE")]
        picked = p.pick_bars(bars, tickers)
        self.assertEqual([b["symbol"] for b in picked], ["DTE", "DTE"], "the primary ticker on every date")
        rename = [{"value": "FB", "valid_from": "2012-05-18", "valid_to": "2022-06-09"},
                  {"value": "META", "valid_from": "2022-06-09", "valid_to": None}]
        fb = [self.bar("2021-01-04", 270.0, "FB"), self.bar("2022-06-10", 175.0, "META")]
        self.assertEqual([b["symbol"] for b in p.pick_bars(fb, rename)], ["FB", "META"])
