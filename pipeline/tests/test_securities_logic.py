import unittest

from pipeline.layer2 import securities_logic as s


class TestMatch(unittest.TestCase):
    def setUp(self):
        self.existing = [
            {"security_id": "SEC_000001", "cik": "320193", "cusips": {"037833100"}, "tickers": {"AAPL"}, "name": "Apple Inc."},
            {"security_id": "SEC_000002", "cik": "789019", "cusips": {"594918104"}, "tickers": {"MSFT"}, "name": "Microsoft Corp"},
        ]

    def test_cik_takes_precedence(self):
        # ticker reused by a different company, but CIK pins identity
        c = {"ticker": "MSFT", "cik": "320193", "cusip": None, "name": "Totally Different"}
        self.assertEqual(s.match_security(c, self.existing), "SEC_000001")

    def test_cusip_match(self):
        c = {"ticker": "NEW", "cik": None, "cusip": "594918104", "name": "x"}
        self.assertEqual(s.match_security(c, self.existing), "SEC_000002")

    def test_ticker_plus_name(self):
        c = {"ticker": "AAPL", "cik": None, "cusip": None, "name": "Apple Inc"}
        self.assertEqual(s.match_security(c, self.existing), "SEC_000001")

    def test_ticker_without_name_similarity_is_no_match(self):
        c = {"ticker": "AAPL", "cik": None, "cusip": None, "name": "Zzzz Unrelated Holdings"}
        self.assertIsNone(s.match_security(c, self.existing))

    def test_unmatched_is_none(self):
        self.assertIsNone(s.match_security({"ticker": "ZZ", "cik": "1", "cusip": "9", "name": "q"}, self.existing))


class TestIntervals(unittest.TestCase):
    def test_noop_when_same_value(self):
        iv = [{"value": "Tech", "valid_from": "2020-01-01", "valid_to": None}]
        self.assertEqual(s.upsert_interval(iv, "Tech", "2024-01-01"), iv)

    def test_closes_and_opens_on_change(self):
        iv = [{"value": "Tech", "valid_from": "2020-01-01", "valid_to": None}]
        out = s.upsert_interval(iv, "Healthcare", "2024-01-01")
        self.assertEqual(out[0]["valid_to"], "2024-01-01")
        self.assertEqual(out[1], {"value": "Healthcare", "valid_from": "2024-01-01", "valid_to": None})

    def test_ticker_on_and_collision(self):
        from datetime import date

        idents = [
            {"type": "ticker", "value": "FB", "valid_from": date(2012, 1, 1), "valid_to": date(2022, 6, 9)},
            {"type": "ticker", "value": "META", "valid_from": date(2022, 6, 9), "valid_to": None},
        ]
        self.assertEqual(s.ticker_on(idents, date(2015, 1, 1)), "FB")
        self.assertEqual(s.ticker_on(idents, date(2023, 1, 1)), "META")
        a = [{"identifiers": idents}, {"identifiers": [{"type": "ticker", "value": "META", "valid_from": date(2022, 6, 9), "valid_to": None}]}]
        self.assertEqual(s.has_ticker_collision(a, date(2023, 1, 1)), ["META"])


if __name__ == "__main__":
    unittest.main()


class TestBuildSecurities(unittest.TestCase):
    """#98: H4 ISO bounds, H5 sector_is_backfilled, H6 ticker valid_from = first observed date."""

    def build(self, existing=(), today="2026-11-04", profiles=None):
        profiles = profiles or [
            {"symbol": "AAA", "companyName": "Alpha Inc", "cik": "1", "sector": "Tech", "industry": "Software",
             "exchange": "NASDAQ", "ipoDate": "1999-01-04", "isActivelyTrading": True},
        ]
        return s.build_securities_docs(profiles, [], [], list(existing), {"AAA": "2016-01-04"}, today)

    def test_new_security(self):
        [doc] = self.build()
        ticker = next(i for i in doc["identifiers"] if i["type"] == "ticker")
        self.assertEqual(ticker["valid_from"], "2016-01-04", "H6: first observed, not the IPO date")
        self.assertEqual(doc["sector_history"], [{"value": "Tech", "valid_from": "2016-01-04", "valid_to": None, "backfilled": True}])
        self.assertTrue(doc["sector_is_backfilled"])
        self.assertEqual(doc["sector_observed_from"], "2026-11-04")
        for f in ("sector_history", "industry_history", "exchange_history", "identifiers"):
            for iv in doc[f]:
                self.assertIsInstance(iv["valid_from"], str, f"H4: {f}")
                self.assertEqual(len(iv["valid_from"]), 10)

    def test_rerun_is_stable_and_a_change_is_dated_today(self):
        [first] = self.build()
        [same] = self.build([first], today="2026-11-05")
        self.assertEqual(same, first, "a re-run is identical (identifier order included)")
        moved = [{**self.build()[0], "security_id": first["security_id"]}]
        [changed] = s.build_securities_docs(
            [{"symbol": "AAA", "companyName": "Alpha Inc", "cik": "1", "sector": "Energy", "exchange": "NASDAQ"}],
            [], [], moved, {"AAA": "2016-01-04"}, "2026-12-01",
        )
        self.assertEqual([i["value"] for i in changed["sector_history"]], ["Tech", "Energy"])
        self.assertEqual(changed["sector_history"][0]["valid_to"], "2026-12-01")
        self.assertEqual(changed["sector_history"][1]["valid_from"], "2026-12-01")
        self.assertTrue(changed["sector_is_backfilled"], "the earliest interval stays flagged")

    def test_old_docs_are_repaired(self):
        from datetime import datetime, timezone

        old = {
            "security_id": "SEC_000007", "name": "Alpha Inc",
            "identifiers": [
                {"type": "cik", "value": "1", "valid_from": "1999-01-04", "valid_to": None},
                {"type": "ticker", "value": "AAA", "valid_from": "1999-01-04", "valid_to": None},
            ],
            "sector_history": [{"value": "Tech", "valid_from": datetime(2026, 10, 23, 20, 35, tzinfo=timezone.utc), "valid_to": None}],
        }
        [doc] = self.build([old])
        self.assertEqual(doc["security_id"], "SEC_000007", "matched by CIK, id kept")
        self.assertEqual(next(i for i in doc["identifiers"] if i["type"] == "ticker")["valid_from"], "2016-01-04")
        self.assertEqual(doc["sector_history"][0]["valid_from"], "2016-01-04")
        self.assertTrue(doc["sector_is_backfilled"])
        self.assertEqual(doc["sector_observed_from"], "2026-10-23", "H4: the old datetime became a date")


class TestDelistedExchange(unittest.TestCase):
    def test_delisted_names_get_their_exchange(self):
        [doc] = s.build_securities_docs([], [], [{"symbol": "DDD", "companyName": "Delta", "exchange": "NYSE", "delistedDate": "2020-05-01"}], [], {"DDD": "2018-01-02"}, "2026-11-04")
        self.assertEqual(doc["exchange_history"], [{"value": "NYSE", "valid_from": "2018-01-02", "valid_to": None, "backfilled": True}])
        self.assertFalse(doc["is_active"])


class TestExchangeRepair(unittest.TestCase):
    def test_an_exchange_from_the_first_run_is_backfilled(self):
        old = {
            "security_id": "SEC_000009", "name": "Alpha Inc",
            "identifiers": [{"type": "cik", "value": "1", "valid_from": "2016-01-04", "valid_to": None},
                            {"type": "ticker", "value": "AAA", "valid_from": "2016-01-04", "valid_to": None}],
            "exchange_history": [{"value": "NASDAQ", "valid_from": "2026-10-23", "valid_to": None}],
        }
        [doc] = s.build_securities_docs([{"symbol": "AAA", "companyName": "Alpha Inc", "cik": "1", "exchange": "NASDAQ"}], [], [], [old], {"AAA": "2016-01-04"}, "2026-11-05")
        self.assertEqual(doc["exchange_history"], [{"value": "NASDAQ", "valid_from": "2016-01-04", "valid_to": None, "backfilled": True}])
        self.assertTrue(doc["exchange_is_backfilled"])
        self.assertEqual(doc["exchange_observed_from"], "2026-10-23")


class TestConcurrentInstruments(unittest.TestCase):
    """#255: one issuer (CIK) with a common stock and preferreds listed at the same time is several securities."""

    PROFILES = [
        {"symbol": "DTE", "companyName": "DTE Energy Company", "cik": "936340", "cusip": "233331107", "exchange": "NYSE", "isActivelyTrading": True},
        {"symbol": "DTB", "companyName": "DTE Energy Company", "cik": "936340", "cusip": "233331701", "exchange": "NYSE", "isActivelyTrading": True},
        {"symbol": "DTG", "companyName": "DTE Energy Company", "cik": "936340", "cusip": "233331883", "exchange": "NYSE", "isActivelyTrading": True},
    ]
    SEEN = {"DTE": "2016-01-04", "DTB": "2017-03-01", "DTG": "2019-05-01"}

    def test_fresh_build_keeps_them_apart(self):
        docs = s.build_securities_docs(self.PROFILES, [], [], [], self.SEEN, "2026-11-06")
        tickers = sorted(tuple(sorted(i["value"] for i in d["identifiers"] if i["type"] == "ticker")) for d in docs)
        self.assertEqual(tickers, [("DTB",), ("DTE",), ("DTG",)])

    def test_an_existing_merge_is_split_and_the_common_stock_keeps_its_id(self):
        merged = {
            "security_id": "SEC_000606", "name": "DTE Energy Company", "is_active": True,
            "identifiers": [
                {"type": "ticker", "value": "DTE", "valid_from": "2016-01-04", "valid_to": "2017-03-01"},
                {"type": "ticker", "value": "DTB", "valid_from": "2017-03-01", "valid_to": "2019-05-01"},
                {"type": "ticker", "value": "DTG", "valid_from": "2019-05-01", "valid_to": "2020-01-01"},
                {"type": "ticker", "value": "DTE", "valid_from": "2020-01-01", "valid_to": None},
                {"type": "cik", "value": "936340", "valid_from": "2016-01-04", "valid_to": None},
                {"type": "cusip", "value": "233331107", "valid_from": "2016-01-04", "valid_to": None},
                {"type": "cusip", "value": "233331701", "valid_from": "2017-03-01", "valid_to": None},
            ],
        }
        docs = {d["security_id"]: d for d in s.build_securities_docs(self.PROFILES, [], [], [merged], self.SEEN, "2026-11-06")}
        dte = docs["SEC_000606"]
        self.assertEqual([(i["value"], i["valid_from"], i["valid_to"]) for i in dte["identifiers"] if i["type"] == "ticker"],
                         [("DTE", "2016-01-04", None)], "one open interval from the first observation")
        self.assertNotIn("233331701", [i["value"] for i in dte["identifiers"] if i["type"] == "cusip"])
        self.assertEqual(dte["split_tickers"], ["DTB", "DTG"])
        others = [d for k, d in docs.items() if k != "SEC_000606"]
        self.assertEqual(sorted(i["value"] for d in others for i in d["identifiers"] if i["type"] == "ticker"), ["DTB", "DTG"])
        self.assertEqual(len({d["security_id"] for d in others}), 2)
        again = {d["security_id"]: d for d in s.build_securities_docs(self.PROFILES, [], [], list(docs.values()), self.SEEN, "2026-11-07")}
        self.assertEqual(set(again), set(docs), "a re-run keeps the same ids")

    def test_a_rename_still_matches_by_cik(self):
        old = {"security_id": "SEC_000010", "name": "Meta Platforms", "is_active": True, "identifiers": [
            {"type": "ticker", "value": "FB", "valid_from": "2016-01-04", "valid_to": None},
            {"type": "cik", "value": "1326801", "valid_from": "2016-01-04", "valid_to": None}]}
        meta = [{"symbol": "META", "companyName": "Meta Platforms, Inc.", "cik": "1326801", "exchange": "NASDAQ", "isActivelyTrading": True}]
        [doc] = s.build_securities_docs(meta, [], [], [old], {"META": "2022-06-09"}, "2026-11-06")
        self.assertEqual(doc["security_id"], "SEC_000010")
