"""#102 features: price/fundamental features, no lookahead, cross-sectional ranks (composite averages 0.5)."""
import random
import unittest
from datetime import date, timedelta
from types import SimpleNamespace

from pipeline.layer2 import features as F


def tdays(n, start="2024-01-01"):
    out, d = [], date.fromisoformat(start)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


DAYS = tdays(320)


def dataset(n_sec=6, seed=7):
    rnd = random.Random(seed)
    sec, prices, uni, fund = [], [], [], []
    for k in range(n_sec):
        sid = f"SEC_{k:06d}"
        sec.append({"security_id": sid, "sector_history": [{"value": "Tech" if k % 2 else "Energy", "valid_from": "2016-01-04", "valid_to": None}]})
        c = 100.0
        for d in DAYS:
            r = rnd.gauss(0.0005, 0.02)
            c *= 1 + r
            prices.append({"security_id": sid, "date": d, "adj_close": c, "ret_1d": r})
            uni.append({"security_id": sid, "date": d, "in_universe": True, "market_cap": 1e9 * (k + 1), "adv_20d": 1e7})
        for q, (end, asof) in enumerate([("2023-12-31", "2024-02-01"), ("2024-03-31", "2024-05-01"), ("2024-06-30", "2024-08-01"), ("2024-12-31", "2025-02-03")]):
            fund.append({"security_id": sid, "period_end": end, "version": 1, "as_of_date": asof, "ttm_revenue": 1e8 * (k + 1) * (1 + q / 10), "ttm_net_income": 1e7 * (k + 1), "ttm_free_cash_flow": 5e6, "ttm_gross_profit": 4e7, "ttm_operating_income": 2e7, "ttm_operating_cash_flow": 1.2e7, "stockholders_equity": 5e8, "total_debt": 1e8 * k, "total_assets": 1e9})
    return {"securities": sec, "prices_daily": prices, "universe_daily": uni, "fundamentals_pit": fund}


def reader(data):
    def read(c, flt=None, cols=None, sort=None):
        rows = [dict(r) for r in data.get(c, [])]
        for k, v in (flt or {}).items():
            if isinstance(v, dict):
                rows = [r for r in rows if ("$gte" not in v or r[k] >= v["$gte"]) and ("$lte" not in v or r[k] <= v["$lte"])]
            else:
                rows = [r for r in rows if r.get(k) == v]
        return sorted(rows, key=lambda r: r.get("date", "")) if sort else rows

    return read


class Features(unittest.TestCase):
    def test_no_lookahead(self):
        """Features on D computed from data truncated to what was known on D equal the stored ones."""
        data = dataset()
        full = {(r["security_id"], r["date"]): r for rows in F.compute_daily(reader(data)) for r in rows}
        for d in (DAYS[100], DAYS[260], DAYS[-1]):
            cut = {
                "securities": data["securities"],
                "prices_daily": [r for r in data["prices_daily"] if r["date"] <= d],
                "universe_daily": [r for r in data["universe_daily"] if r["date"] <= d],
                "fundamentals_pit": [r for r in data["fundamentals_pit"] if r["as_of_date"] <= d],
            }
            for rows in F.compute_daily(reader(cut)):
                for r in rows:
                    if r["date"] == d:
                        self.assertEqual(r, full[(r["security_id"], d)], f"{r['security_id']} on {d}")

    def test_window_with_lookback_equals_full(self):
        data = dataset(2)
        full = {(r["security_id"], r["date"]): r for rows in F.compute_daily(reader(data)) for r in rows}
        w = SimpleNamespace(start=DAYS[300], end=DAYS[300], lookback_start=DAYS[300 - 260])
        rows = [r for rs in F.compute_daily(reader(data), w) for r in rs]
        self.assertEqual(len(rows), 2)
        for r in rows:
            self.assertEqual(r, full[(r["security_id"], r["date"])])
            self.assertIsNotNone(r["mom_12_1"])

    def test_fundamentals_use_the_version_known(self):
        data = dataset(1)
        rows = {r["date"]: r for rs in F.compute_daily(reader(data)) for r in rs}
        self.assertIsNone(rows["2024-01-31"]["earnings_yield"], "nothing filed yet")
        self.assertAlmostEqual(rows["2024-02-01"]["earnings_yield"], 1e7 / 1e9)
        self.assertIsNone(rows["2024-02-01"]["revenue_growth_yoy"], "no year-ago quarter yet")
        self.assertAlmostEqual(rows["2025-02-03"]["revenue_growth_yoy"], 1.3 / 1.0 - 1)
        self.assertEqual(rows["2024-05-06"]["days_since_filing"], 5)

    def test_ranks_and_composite_average(self):
        rnd = random.Random(3)
        for n in (5, 37, 400):
            rows = [{"security_id": f"S{i}", "date": "2025-01-02", "in_universe": True, "sector": "AB"[i % 2], **{f: (None if rnd.random() < 0.1 else rnd.gauss(0, 1)) for f in F.FEATURES}} for i in range(n)]
            rows.append({"security_id": "OUT", "date": "2025-01-02", "in_universe": False, **{f: 9 for f in F.FEATURES}})
            out = F.rank_cross_section(rows)
            self.assertEqual(len(out), n, "only members are ranked")
            comp = [o["composite_pct"] for o in out if o["composite_pct"] is not None]
            self.assertAlmostEqual(sum(comp) / len(comp), 0.5, delta=0.02)
            self.assertTrue(all(o["mom_12_1_z"] is None or -3 <= o["mom_12_1_z"] <= 3 for o in out))
            for s in "AB":
                sp = [o["composite_sector_pct"] for o in out if o["sector"] == s and o["composite_sector_pct"] is not None]
                self.assertAlmostEqual(sum(sp) / len(sp), 0.5, delta=0.02)

    def test_registry_docs_every_output_field(self):
        data = dataset(2)
        daily = next(F.compute_daily(reader(data)))[0]
        docs = F.registry_docs()
        missing = [k for k in daily if k not in docs and k not in ("security_id", "date", "known_at", "as_of_date")]
        self.assertEqual(missing, [])
        ranked = F.rank_cross_section([dict(daily, in_universe=True)])[0]
        rdocs = F.registry_docs(ranked=True)
        self.assertEqual([k for k in ranked if k not in rdocs and k not in ("security_id", "date", "known_at", "as_of_date")], [])
