"""#100 fundamentals_pit: versions from restatements, Q4 derivation, TTM, point-in-time visibility."""
import unittest
from datetime import date, datetime, timedelta, timezone

from pipeline.layer2 import fundamentals_logic as f
from pipeline.layer2 import fundamentals_pit


def stmt(d, p, accepted, **vals):
    return {"symbol": "AAA", "date": d, "period": p, "acceptedDate": accepted, "fiscalYear": d[:4], "reportedCurrency": "USD", **vals}


Q = [("2025-03-31", "Q1"), ("2025-06-30", "Q2"), ("2025-09-30", "Q3"), ("2025-12-31", "Q4"), ("2026-03-31", "Q1")]


class Versions(unittest.TestCase):
    def test_restatement_gives_two_versions(self):
        inc = [stmt("2025-03-31", "Q1", "2025-05-01 16:05:00", revenue=100, netIncome=10),
               stmt("2025-03-31", "Q1", "2025-08-01 16:05:00", revenue=95, netIncome=9)]
        bal = [stmt("2025-03-31", "Q1", "2025-05-01 16:05:00", totalAssets=500, totalLiabilities=300, totalEquity=200)]
        [vs] = f.versions(inc, bal, []).values()
        self.assertEqual([(v["version"], v["revenue"], v["is_latest"]) for v in vs], [(1, 100.0, False), (2, 95.0, True)])
        self.assertEqual(vs[1]["total_assets"], 500.0, "the balance sheet carries into the restated version")
        self.assertEqual(vs[0]["known_at"], "2025-05-01T20:05:00+00:00", "Eastern acceptance -> UTC")

    def test_date_only_acceptance_is_end_of_day(self):
        self.assertEqual(f.accepted_utc("2024-09-30 00:00:00"), "2024-10-01T03:59:00+00:00")
        self.assertEqual(f.accepted_utc(None, "2024-11-05"), "2024-11-06T04:59:00+00:00")

    def test_q4_derivation(self):
        q = {p: {"revenue": r, "net_income": r / 10, "total_assets": 1} for p, r in (("Q1", 100.0), ("Q2", 110.0), ("Q3", 120.0))}
        q4 = f.derive_q4(q, {"revenue": 460.0, "net_income": 46.0, "total_assets": 9.0})
        self.assertEqual((q4["revenue"], q4["net_income"], q4["total_assets"], q4["derived_q4"]), (130.0, 13.0, 9.0, True))
        self.assertIsNone(f.derive_q4({"Q1": {}, "Q2": {}}, {"revenue": 1}))

    def test_ttm_uses_what_was_known_then(self):
        inc = [stmt(d, p, f"{d[:4]}-{int(d[5:7]) + 1:02d}-15 16:00:00" if d[5:7] != "12" else f"{int(d[:4]) + 1}-01-20 16:00:00", revenue=100 + i, netIncome=10)
               for i, (d, p) in enumerate(Q)]
        inc.append(stmt("2025-06-30", "Q2", "2026-05-01 16:00:00", revenue=50, netIncome=10))  # a late restatement of Q2
        history = [v for vs in f.versions(inc, [], []).values() for v in vs]
        latest_q1_2026 = next(v for v in history if v["period_end"] == "2026-03-31")
        t = f.ttm(history, latest_q1_2026["known_at"])
        self.assertEqual(t["ttm_revenue"], 101 + 102 + 103 + 104, "Q2 as originally reported: the restatement came later")
        t_after = f.ttm(history, "2026-05-02T00:00:00+00:00")
        self.assertEqual(t_after["ttm_revenue"], 50 + 102 + 103 + 104)
        self.assertIsNone(f.ttm(history, "2025-09-01T00:00:00+00:00")["ttm_revenue"], "fewer than four quarters")

    def test_balance_identity(self):
        self.assertIsNone(f.balance_issue({"total_assets": 100, "total_liabilities": 60, "total_equity": 40}))
        self.assertEqual(f.balance_issue({"total_assets": 100, "total_liabilities": 60, "total_equity": 20}), "balance_sheet_identity")


class PointInTime(unittest.TestCase):
    def test_rows_are_visible_only_after_acceptance(self):
        days, d = [], date(2025, 4, 28)
        while len(days) < 10:
            if d.weekday() < 5:
                days.append({"date": datetime(d.year, d.month, d.day, tzinfo=timezone.utc), "open_utc": datetime(d.year, d.month, d.day, 13, 30, tzinfo=timezone.utc)})
            d += timedelta(days=1)
        data = {
            "securities": [{"security_id": "SEC_000001", "identifiers": [{"type": "ticker", "value": "AAA", "valid_from": "2016-01-04", "valid_to": None}]}],
            "trading_calendar": days,
            "income_statement": [stmt("2025-03-31", "Q1", "2025-05-01 16:05:00", revenue=100)],
            "balance_sheet": [], "cash_flow": [],
        }
        read = lambda c, flt=None, cols=None, sort=None: [dict(r) for r in data.get(c, [])]
        [(rows, _)] = list(fundamentals_pit.compute(read))
        [r] = rows
        self.assertEqual(r["known_at"], "2025-05-01T20:05:00+00:00")
        self.assertEqual(r["as_of_date"], "2025-05-02", "accepted after the close: usable from the next session")
