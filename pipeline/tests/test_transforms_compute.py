"""#99: the Transform entry points with a fake reader (stdlib only)."""
import unittest
from datetime import date, timedelta
from types import SimpleNamespace

from pipeline.layer2 import corporate_actions, macro_daily, prices_daily


def weekdays(start, n):
    out, d = [], date.fromisoformat(start)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


DAYS = weekdays("2026-01-05", 40)
BARS = [{"_id": f"b{i}", "symbol": "AAA", "date": d, "open": 10 + i, "high": 11 + i, "low": 9 + i, "close": 10 + i + (i % 3) * 0.5, "volume": 100} for i, d in enumerate(DAYS)]
SECURITIES = [{"security_id": "SEC_000001", "identifiers": [{"type": "ticker", "value": "AAA", "valid_from": "2016-01-04", "valid_to": None}]}]


def reader(data):
    def read(collection, flt=None, columns=None, sort=None):
        rows = [dict(r) for r in data.get(collection, [])]
        f = (flt or {}).get("date")
        if f:
            rows = [r for r in rows if ("$gte" not in f or r["date"] >= f["$gte"]) and ("$lte" not in f or r["date"] <= f["$lte"])]
        return sorted(rows, key=lambda r: r.get("date", "")) if sort else rows

    return read


class PricesDaily(unittest.TestCase):
    def rows(self, window, actions=(), bars=BARS):
        read = reader({"securities": SECURITIES, "eod_prices": bars, "corporate_actions": list(actions)})
        return [d for rows, _ in prices_daily.compute(read, window) for d in rows]

    def test_daily_incremental_equals_full_rebuild(self):
        full = {r["date"]: r for r in self.rows(None)}
        for i in range(20, 40):
            day = DAYS[i]
            w = SimpleNamespace(start=day, end=day, lookback_start=DAYS[i - 15])
            [r] = self.rows(w)
            self.assertEqual(r["date"], day, "only the window is written")
            for k in ("ret_1d", "tr_1d", "adj_close", "dq_flags"):
                self.assertEqual(r[k], full[day][k], f"{k} on {day}")
        self.assertIsNotNone(full[DAYS[20]]["ret_1d"])

    def test_a_split_in_the_window_rewrites_history(self):
        w = SimpleNamespace(start=DAYS[30], end=DAYS[30], lookback_start=DAYS[20])
        split = {"security_id": "SEC_000001", "action_type": "split", "ex_date": DAYS[30], "split_ratio": 2.0}
        # An unadjusted source: the close halves on the ex-date, so earlier bars get factor 0.5.
        unadjusted = [{**b, "close": b["close"] * (2 if b["date"] < DAYS[30] else 1)} for b in BARS]
        rows = self.rows(w, [split], unadjusted)
        self.assertEqual(len(rows), 31, "every bar up to the window end")
        self.assertEqual(rows[0]["adj_factor"], 0.5)
        # Already-adjusted bars (FMP, #240): the same split leaves the factors at 1.
        self.assertEqual({r["adj_factor"] for r in self.rows(w, [split])}, {1.0})

    def test_bars_on_non_trading_days_are_dropped(self):
        """#437: FMP sometimes returns a weekend bar; prices_daily keeps trading sessions only."""
        from datetime import datetime
        bars = [{"_id": f"b{i}", "symbol": "AAA", "date": d, "open": 10.0, "high": 11.0, "low": 9.0, "close": 10.5,
                 "volume": 1000} for i, d in enumerate(["2025-11-06", "2025-11-07", "2025-11-08", "2025-11-10"])]
        cal = [{"date": datetime(2025, 11, d), "is_trading_day": True} for d in (6, 7, 10)]
        read = reader({"securities": SECURITIES, "eod_prices": bars, "corporate_actions": [], "trading_calendar": cal})
        dates = [r["date"] for rows, _ in prices_daily.compute(read) for r in rows]
        self.assertEqual(dates, ["2025-11-06", "2025-11-07", "2025-11-10"])

    def test_non_equity_instruments_get_no_prices(self):
        """#393: a note's bars produce no rows and no DQ issues (its open issues resolve on the next full run)."""
        bars = [{"_id": f"b{i}", "symbol": "AAA", "date": f"2020-01-{i + 2:02d}", "open": 0.0, "high": 0.0, "low": 0.0,
                 "close": 0.0, "volume": 0} for i in range(5)]
        read = reader({"securities": [dict(SECURITIES[0], security_type="note")], "eod_prices": bars, "corporate_actions": []})
        self.assertEqual(list(prices_daily.compute(read)), [])

    def test_dq_flags_become_issues(self):
        bars = [dict(b) for b in BARS[:8]]
        bars[5]["close"] = 0
        read = reader({"securities": SECURITIES, "eod_prices": bars, "corporate_actions": []})
        issues = [i for _, iss in prices_daily.compute(read) for i in iss]
        self.assertIn({"issue_type": "zero_or_negative_price", "severity": "error", "security_id": "SEC_000001", "date": DAYS[5]}, issues)


class CorporateActions(unittest.TestCase):
    def test_union_dedupe_and_stable_rows(self):
        data = {
            "securities": SECURITIES,
            "dividends_calendar": [{"_id": "d1", "symbol": "AAA", "date": "2026-02-02", "dividend": 0.5, "declarationDate": "2026-01-20"}],
            "dividends_history": [{"_id": "d2", "symbol": "AAA", "date": "2026-02-02", "dividend": 0.5}, {"_id": "d3", "symbol": "AAA", "date": "2026-05-04", "dividend": 5.0}],
            "splits_calendar": [],
            "splits_history": [{"_id": "s1", "symbol": "AAA", "date": "2026-03-02", "numerator": 4, "denominator": 1}],
        }
        a = corporate_actions.compute(reader(data))
        self.assertEqual(a, corporate_actions.compute(reader(data)), "identical on a re-run (no processed_at)")
        kinds = sorted((r["action_type"], r["ex_date"]) for r in a)
        self.assertEqual(kinds, [("cash_dividend", "2026-02-02"), ("special_dividend", "2026-05-04"), ("split", "2026-03-02")])
        self.assertEqual(next(r for r in a if r["action_type"] == "split")["split_ratio"], 4.0)


class MacroDaily(unittest.TestCase):
    def test_curve_and_spx_returns(self):
        data = {
            "treasury_rates": [{"date": "2026-01-05", "year10": 4.0, "year2": 3.5, "month3": 4.2, "year30": 4.5}],
            "eod_index": [{"symbol": "^GSPC", "date": "2026-01-05", "close": 100}, {"symbol": "^GSPC", "date": "2026-01-06", "close": 101}],
            "sector_performance": [],
        }
        rows = macro_daily.compute(reader(data))
        self.assertEqual([r["date"] for r in rows], ["2026-01-05", "2026-01-06"])
        self.assertAlmostEqual(rows[0]["curve_10y_2y"], 0.5)
        self.assertAlmostEqual(rows[1]["spx_ret_1d"], 0.01)
        self.assertEqual(rows[1]["ust_10y"], 4.0, "nearest prior treasury within 3 days")

    def test_spy_total_return_and_risk_free(self):
        """#445: spx_tr_1d = SPY close plus its dividend on the ex-date over the previous close; rf_1d from the 3m bill."""
        data = {
            "treasury_rates": [{"date": "2026-01-05", "year10": 4.0, "year2": 3.5, "month3": 5.0, "year30": 4.5}],
            "eod_index": [
                {"symbol": "^GSPC", "date": "2026-01-05", "close": 100}, {"symbol": "^GSPC", "date": "2026-01-06", "close": 99},
                {"symbol": "SPY", "date": "2026-01-05", "close": 500.0}, {"symbol": "SPY", "date": "2026-01-06", "close": 495.0},
            ],
            "benchmark_dividends": [{"symbol": "SPY", "date": "2026-01-06", "dividend": 2.0}],
            "sector_performance": [],
        }
        rows = macro_daily.compute(reader(data))
        self.assertAlmostEqual(rows[1]["spx_ret_1d"], -0.01)
        self.assertAlmostEqual(rows[1]["spx_tr_1d"], (495.0 + 2.0) / 500.0 - 1)
        self.assertIsNone(rows[0]["spx_tr_1d"])
        self.assertAlmostEqual(rows[0]["rf_1d"], 1.05 ** (1 / 252) - 1)
        self.assertAlmostEqual(rows[1]["rf_1d"], rows[0]["rf_1d"], msg="the bill carries to the next day")

    def test_without_spy_the_total_return_is_empty(self):
        data = {"treasury_rates": [], "eod_index": [{"symbol": "^GSPC", "date": "2026-01-05", "close": 100}], "sector_performance": []}
        self.assertIsNone(macro_daily.compute(reader(data))[0]["spx_tr_1d"])

    def test_full_history_carry_limit_and_no_future_values(self):
        """#388: every day with inputs gets the curve; holidays carry the last print up to 5 days, never a later one."""
        data = {
            "treasury_rates": [
                {"date": "2016-01-04", "year10": 2.2, "year2": 1.0, "month3": 0.2, "year30": 3.0},
                {"date": "2016-01-11", "year10": 2.1, "year2": 0.9, "month3": 0.2, "year30": 2.9},
            ],
            "eod_index": [{"symbol": "^GSPC", "date": d, "close": 2000 + i} for i, d in enumerate(
                ["2016-01-01", "2016-01-04", "2016-01-08", "2016-01-10", "2016-01-11"])],
            "sector_performance": [
                {"date": "2016-01-04", "sector": "Technology", "exchange": "NYSE", "averageChange": 9.9},
                {"date": "2016-01-04", "sector": "Technology", "exchange": "NASDAQ", "averageChange": 0.5},
                {"date": "2016-01-08", "sector": "Energy", "exchange": "NYSE", "averageChange": -1.0},
            ],
        }
        rows = {r["date"]: r for r in macro_daily.compute(reader(data))}
        self.assertIsNone(rows["2016-01-01"]["ust_10y"], "before the first print: nothing, never a future value")
        self.assertEqual(rows["2016-01-08"]["ust_10y"], 2.2, "4 days old: carried")
        self.assertIsNone(rows["2016-01-10"]["ust_10y"], "6 days old: too stale to carry")
        self.assertEqual(rows["2016-01-11"]["curve_10y_2y"], 2.1 - 0.9)
        self.assertEqual(rows["2016-01-04"]["sector_returns"], {"Technology": 0.5}, "the NASDAQ series when present")
        self.assertEqual(rows["2016-01-08"]["sector_returns"], {"Energy": -1.0}, "else the one exchange there is")


class SameDayDividends(unittest.TestCase):
    """#518: FMP lists a regular and a special dividend on one ex-date as two rows; both are paid (BEN 2018-03-28
    $0.23 + $3.00, in Franklin's 10-Q). corporate_actions keeps one row of each kind, prices_daily adds them up."""

    def test_two_rows_of_one_day_become_a_cash_and_a_special_row(self):
        hist = [
            {"_id": "q", "symbol": "AAA", "date": DAYS[10], "dividend": 0.23, "adjDividend": 0.23, "frequency": "Quarterly"},
            {"_id": "s", "symbol": "AAA", "date": DAYS[10], "dividend": 3.0, "adjDividend": 3.0, "frequency": "Special"},
            {"_id": "q2", "symbol": "AAA", "date": DAYS[30], "dividend": 0.23, "adjDividend": 0.23, "frequency": "Quarterly"},
        ]
        cal = [{"_id": "c", "symbol": "AAA", "date": DAYS[10], "dividend": 0.23, "adjDividend": 0.23, "frequency": "Quarterly"}]
        acts = corporate_actions.compute(reader({"securities": SECURITIES, "dividends_history": hist,
                                                 "dividends_calendar": cal}))
        day = sorted((a["action_type"], a["dividend_amount"]) for a in acts if a["ex_date"] == DAYS[10])
        self.assertEqual(day, [("cash_dividend", 0.23), ("special_dividend", 3.0)], "the calendar copy counts once")
        self.assertEqual([a["action_type"] for a in acts if a["ex_date"] == DAYS[30]], ["cash_dividend"])
        rows = {r["date"]: r for rows, _ in prices_daily.compute(
            reader({"securities": SECURITIES, "eod_prices": BARS, "corporate_actions": acts}), None) for r in rows}
        self.assertAlmostEqual(rows[DAYS[10]]["dividend"], 3.23)

    def test_unlabelled_rows_keep_the_size_rule(self):
        hist = [{"_id": "a", "symbol": "AAA", "date": DAYS[5], "dividend": 0.5},
                {"_id": "b", "symbol": "AAA", "date": DAYS[25], "dividend": 5.0}]
        acts = corporate_actions.compute(reader({"securities": SECURITIES, "dividends_history": hist}))
        self.assertEqual(sorted((a["ex_date"], a["action_type"]) for a in acts),
                         [(DAYS[5], "cash_dividend"), (DAYS[25], "special_dividend")])
