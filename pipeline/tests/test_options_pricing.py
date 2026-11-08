"""#327: the options pricing library."""
import math
import unittest
from datetime import date

from pipeline.strategy import options as o


class Pricing(unittest.TestCase):
    def test_textbook_values(self):
        # Hull, Options, Futures and Other Derivatives: S=42, K=40, r=10%, T=0.5, sigma=20% -> c=4.76, p=0.81.
        self.assertAlmostEqual(o.price(o.CALL, 42, 40, 0.5, 0.10, 0.0, 0.20), 4.76, places=2)
        self.assertAlmostEqual(o.price(o.PUT, 42, 40, 0.5, 0.10, 0.0, 0.20), 0.81, places=2)

    def test_put_call_parity_with_dividends(self):
        for s, k, t, r, q, v in [(100, 95, 0.25, 0.04, 0.02, 0.3), (50, 60, 1.0, 0.05, 0.0, 0.5), (200, 200, 0.1, 0.0, 0.03, 0.15)]:
            c, p = o.price(o.CALL, s, k, t, r, q, v), o.price(o.PUT, s, k, t, r, q, v)
            self.assertAlmostEqual(c - p, s * math.exp(-q * t) - k * math.exp(-r * t), places=10)

    def test_greeks_match_finite_differences(self):
        s, k, t, r, q, v, h = 100.0, 105.0, 0.4, 0.03, 0.01, 0.25, 1e-4
        for kind in (o.CALL, o.PUT):
            g = o.greeks(kind, s, k, t, r, q, v)
            f = lambda **kw: o.price(kind, kw.get("s", s), k, kw.get("t", t), r, q, kw.get("v", v))  # noqa: E731
            self.assertAlmostEqual(g.delta, (f(s=s + h) - f(s=s - h)) / (2 * h), places=5)
            self.assertAlmostEqual(g.gamma, (f(s=s + h) - 2 * f() + f(s=s - h)) / h ** 2, places=3)
            self.assertAlmostEqual(g.vega, (f(v=v + h) - f(v=v - h)) / (2 * h), places=4)
            self.assertAlmostEqual(g.theta, -(f(t=t + h) - f(t=t - h)) / (2 * h), places=3)

    def test_expiry_and_no_vol_are_intrinsic(self):
        self.assertEqual(o.price(o.CALL, 110, 100, 0, 0.05, 0, 0.3), 10)
        self.assertEqual(o.price(o.PUT, 110, 100, 0, 0.05, 0, 0.3), 0)
        self.assertEqual(o.greeks(o.PUT, 90, 100, 0, 0.05, 0, 0.3).delta, -1.0)
        with self.assertRaises(ValueError):
            o.price("straddle", 1, 1, 1, 0, 0, 0.2)

    def test_implied_vol_round_trip(self):
        for kind in (o.CALL, o.PUT):
            value = o.price(kind, 100, 90, 0.3, 0.02, 0.01, 0.37)
            self.assertAlmostEqual(o.implied_vol(kind, value, 100, 90, 0.3, 0.02, 0.01), 0.37, places=6)
        self.assertIsNone(o.implied_vol(o.CALL, 5.0, 100, 90, 0.3, 0.02, 0.0), "below intrinsic")


class Contracts(unittest.TestCase):
    def test_third_fridays(self):
        self.assertEqual(o.third_friday(2024, 3), date(2024, 3, 15))
        self.assertEqual(o.third_friday(2025, 8), date(2025, 8, 15))
        self.assertEqual(o.third_friday(2026, 11), date(2026, 11, 20))
        exp = o.monthly_expiries(date(2024, 3, 15), months=3)
        self.assertEqual(exp, [date(2024, 4, 19), date(2024, 5, 17), date(2024, 6, 21)], "strictly after")

    def test_pick_expiry_near_the_target(self):
        on = date(2024, 3, 1)
        self.assertEqual(o.pick_expiry(on, 30), date(2024, 3, 15), "14 days is nearer 30 than 49")
        self.assertEqual(o.pick_expiry(on, 45), date(2024, 4, 19))
        self.assertEqual(o.pick_expiry(date(2024, 3, 12), 5), date(2024, 4, 19), "at least a week out")

    def test_strike_grid_and_moneyness(self):
        self.assertEqual(o.strike_step(20), 1.0)
        self.assertEqual(o.strike_step(80), 2.5)
        self.assertEqual(o.strike_step(150), 5.0)
        self.assertEqual(o.strike_step(450), 10.0)
        grid = o.strike_grid(100)
        self.assertTrue(all(abs(k / 2.5 - round(k / 2.5)) < 1e-9 for k in grid))
        self.assertEqual(o.strike_by_moneyness(o.CALL, 100, 0.05), 105.0)
        self.assertEqual(o.strike_by_moneyness(o.PUT, 100, 0.05), 95.0)
        self.assertEqual(o.strike_by_moneyness(o.CALL, 451, 0.10), 500.0)


class Quotes(unittest.TestCase):
    def test_put_skew_and_spread(self):
        m = o.QuoteModel()
        self.assertGreater(o.skewed_iv(0.3, 100, 90, m), 0.3, "puts below the money are richer")
        self.assertLess(o.skewed_iv(0.3, 100, 110, m), 0.3)
        self.assertEqual(o.skewed_iv(0.3, 100, 100, m), 0.3)
        q = o.quote(o.CALL, 100, 105, 30 / 365, 0.04, 0.0, 0.3)
        self.assertLess(q.bid, q.mid)
        self.assertGreater(q.ask, q.mid)
        self.assertAlmostEqual(q.ask - q.bid, max(0.05, q.mid * 0.04), places=3)
        cheap = o.quote(o.CALL, 100, 140, 30 / 365, 0.04, 0.0, 0.3)
        self.assertGreaterEqual(cheap.bid, 0.0)

    def test_strike_by_delta(self):
        t = 30 / 365
        k = o.strike_by_delta(o.CALL, 100, t, 0.04, 0.0, 0.3, 0.30)
        self.assertGreater(k, 100)
        d = abs(o.quote(o.CALL, 100, k, t, 0.04, 0.0, 0.3).delta)
        self.assertLess(abs(d - 0.30), 0.06)
        kp = o.strike_by_delta(o.PUT, 100, t, 0.04, 0.0, 0.3, 0.25)
        self.assertLess(kp, 100)

    def test_early_assignment_before_a_dividend(self):
        # Deep in the money with a day to go and a $1 dividend: time value is tiny, so it is called away.
        self.assertTrue(o.early_assignment(o.CALL, 120, 100, 1 / 365, 0.04, 0.0, 0.3, dividend=1.0))
        self.assertFalse(o.early_assignment(o.CALL, 101, 100, 30 / 365, 0.04, 0.0, 0.3, dividend=0.2))
        self.assertFalse(o.early_assignment(o.PUT, 80, 100, 1 / 365, 0.04, 0.0, 0.3, dividend=1.0))


if __name__ == "__main__":
    unittest.main()
