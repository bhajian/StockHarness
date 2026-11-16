"""#456: macro regime columns, point in time (market regime from earlier rows, the economy by release lag)."""
import unittest
from datetime import date, timedelta

from pipeline.layer2.macro_regime_logic import add_regimes, econ_series


def rows(n, spx=lambda k: 100 + k, vix=lambda k: 15.0, start="2020-01-01"):
    d0 = date.fromisoformat(start)
    return [{"date": (d0 + timedelta(days=k)).isoformat(), "spx_close": spx(k), "vix": vix(k), "ust_10y": 2.0 + k / 100,
             "curve_10y_2y": 0.5 - k / 200} for k in range(n)]


class Market(unittest.TestCase):
    def test_trend_vol_curve(self):
        r = add_regimes(rows(300, vix=lambda k: 30.0 if k == 299 else 15.0))
        self.assertIsNone(r[150]["spx_above_200d"], "needs 200 sessions")
        self.assertTrue(r[250]["spx_above_200d"])
        self.assertEqual(r[250]["regime"], "bull_calm")
        self.assertEqual(r[299]["regime"], "bull_volatile")
        self.assertEqual(r[299]["vix_pct_252d"], 1.0)
        self.assertAlmostEqual(r[250]["spx_ret_63d"], 350 / 287 - 1)
        self.assertTrue(r[150]["curve_inverted"])
        self.assertFalse(r[50]["curve_inverted"])
        falling = add_regimes(rows(260, spx=lambda k: 400 - k))
        self.assertEqual(falling[-1]["regime"], "bear_calm")
        self.assertLess(falling[-1]["spx_drawdown_252d"], 0)


class Economy(unittest.TestCase):
    def test_cpi_yoy_waits_for_its_release(self):
        cpi = [{"name": "CPI", "date": f"{y}-{m:02d}-01", "value": 100 * (1.02 if y == 2021 else 1.0)}
               for y in (2020, 2021) for m in range(1, 13)]
        econ = econ_series(cpi)
        r = add_regimes([{"date": "2021-02-10"}, {"date": "2021-02-20"}, {"date": "2022-02-20"}], econ)
        self.assertIsNone(r[0]["cpi_yoy"], "January 2021 is known only 45 days later (2021-02-15)")
        self.assertAlmostEqual(r[1]["cpi_yoy"], 0.02)
        self.assertAlmostEqual(r[2]["cpi_yoy"], 0.02, msg="the last known month is December 2021")
        self.assertAlmostEqual(r[2]["cpi_yoy_chg_3m"], 0.0)

    def test_sahm_gap(self):
        un = [{"name": "unemploymentRate", "date": f"{2019 + (k // 12)}-{k % 12 + 1:02d}-01",
               "value": 3.5 if k < 15 else 4.5} for k in range(18)]
        r = add_regimes([{"date": "2020-09-01"}], econ_series(un))
        self.assertAlmostEqual(r[0]["unemployment"], 4.5)
        self.assertGreaterEqual(r[0]["sahm_gap"], 0.5)
