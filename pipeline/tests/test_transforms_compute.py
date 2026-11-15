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
