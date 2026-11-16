"""#457: event features, each point in time by its source's rule."""
import unittest

from pipeline.layer2 import events_logic as ev


class Events(unittest.TestCase):
    def setUp(self):
        self.e = ev.build(
            earnings=[{"date": "2024-05-02", "epsActual": 1.5, "epsEstimated": 1.2, "revenueActual": 90, "revenueEstimated": 100}],
            grades=[{"date": "2024-03-01", "action": "upgrade"}, {"date": "2024-05-01", "action": "upgrade"},
                    {"date": "2024-05-10", "action": "downgrade"}, {"date": "2024-05-11", "action": "maintain"}],
            targets=[{"publishedDate": "2024-05-03T10:00:00Z", "priceTarget": 120, "priceWhenPosted": 100},
                     {"publishedDate": "2024-05-20T10:00:00Z", "priceTarget": 90, "priceWhenPosted": 100}],
            insiders=[{"filingDate": "2024-05-06", "transactionType": "P-Purchase", "securitiesTransacted": 1000, "price": 50},
                      {"filingDate": "2024-05-07", "transactionType": "S-Sale", "securitiesTransacted": 200, "price": 50},
                      {"filingDate": "2024-05-08", "transactionType": "A-Award", "securitiesTransacted": 9999, "price": 50}],
            index_changes=[{"index": "sp500", "date": "2023-06-20", "addedTicker": "AAA"},
                           {"index": "ndx", "date": "2023-07-01", "addedTicker": "AAA"}],
            tickers=["AAA"])

    def test_earnings_wait_for_the_next_session(self):
        self.assertIsNone(ev.event_features(self.e, "2024-05-02")["eps_surprise"], "the report day itself")
        f = ev.event_features(self.e, "2024-05-03")
        self.assertAlmostEqual(f["eps_surprise"], 0.25)
        self.assertAlmostEqual(f["revenue_surprise"], -0.1)
        self.assertEqual(f["days_since_earnings"], 1)

    def test_windows_and_signs(self):
        f = ev.event_features(self.e, "2024-05-15", market_cap=1e6)
        self.assertEqual(f["grade_net_90d"], 1, "two upgrades, one downgrade; 'maintain' isn't a revision")
        self.assertAlmostEqual(f["target_upside_90d"], 0.2, msg="only targets published by that day")
        self.assertAlmostEqual(f["insider_net_buy_90d"], (50000 - 10000) / 1e6, msg="awards aren't open-market trades")
        self.assertEqual(f["days_since_sp500_add"], 330, "the S&P 500 addition, not the Nasdaq-100 one")
        self.assertIsNone(f["days_since_sp500_removal"])
        later = ev.event_features(self.e, "2024-09-01", market_cap=1e6)
        self.assertEqual(later["grade_net_90d"], 0, "the revisions are older than 90 days")
        self.assertIsNone(later["target_upside_90d"])

    def test_shares_change(self):
        self.assertAlmostEqual(ev.event_features(self.e, "2024-05-15", shares_now=95, shares_year_ago=100)["shares_change_yoy"], -0.05)
        self.assertIsNone(ev.event_features(ev.build(), "2024-05-15")["eps_surprise"])
