import unittest
from datetime import date, datetime, timezone

from pipeline.core import pit

UTC = timezone.utc


class TestPit(unittest.TestCase):
    def test_eod_known_at_is_1600_et_utc(self):
        ka = pit.eod_known_at(date(2024, 6, 3))
        self.assertEqual(ka.tzinfo, UTC)
        self.assertEqual(ka, datetime(2024, 6, 3, 16, 0, tzinfo=pit.ET).astimezone(UTC))

    def test_earnings_bmo_before_amc(self):
        self.assertLess(pit.earnings_known_at(date(2024, 6, 3), "bmo"), pit.earnings_known_at(date(2024, 6, 3), "amc"))

    def test_as_of_same_day_for_eod(self):
        sessions = [
            (date(2024, 6, 3), datetime(2024, 6, 3, 13, 30, tzinfo=UTC)),
            (date(2024, 6, 4), datetime(2024, 6, 4, 13, 30, tzinfo=UTC)),
        ]
        ka = datetime(2024, 6, 3, 20, 0, tzinfo=UTC)
        self.assertEqual(pit.as_of_from_known_at(ka, sessions, same_day=True), date(2024, 6, 3))

    def test_as_of_next_session_after_close(self):
        sessions = [
            (date(2024, 6, 3), datetime(2024, 6, 3, 13, 30, tzinfo=UTC)),
            (date(2024, 6, 4), datetime(2024, 6, 4, 13, 30, tzinfo=UTC)),
        ]
        # known_at after 6/3 open -> can't act until 6/4 open
        self.assertEqual(pit.as_of_from_known_at(datetime(2024, 6, 3, 21, 0, tzinfo=UTC), sessions), date(2024, 6, 4))
        # known_at before 6/3 open -> acts 6/3
        self.assertEqual(pit.as_of_from_known_at(datetime(2024, 6, 3, 10, 0, tzinfo=UTC), sessions), date(2024, 6, 3))


if __name__ == "__main__":
    unittest.main()


class AsOfMasking(unittest.TestCase):
    """#449: static and interval data read as of the date, and simulation ledgers refused."""

    def setUp(self):
        from pipeline.strategy.sources import MemorySource
        from pipeline.strategy.reader import PitReader
        sec = [
            {"security_id": "A", "is_active": False, "delisted_date": "2022-06-01",
             "sector_history": [{"value": "Tech", "valid_from": "2016-01-04", "valid_to": "2021-01-01"},
                                {"value": "Energy", "valid_from": "2021-01-01", "valid_to": None}],
             "identifiers": [{"type": "ticker", "value": "AAA", "valid_from": "2016-01-04", "valid_to": "2022-06-01"}]},
            {"security_id": "B", "is_active": True, "delisted_date": None, "sector_history": [], "identifiers": []},
        ]
        im = [{"security_id": "A", "index": "sp500", "valid_from": "2017-03-01", "valid_to": "2020-09-21",
               "as_of_date": "2017-03-01"}]
        src = MemorySource({"securities": sec, "index_membership": im, "sim_trades": [{"x": 1}], "dq_issues": []})
        pol = {"securities": {"mode": "static"}, "sim_trades": {"mode": "static"}, "dq_issues": {"mode": "static"},
               "index_membership": {"mode": "pit", "rule": {"type": "asOf", "field": "as_of_date"}}}
        self.r = PitReader(src, pol, end="2025-01-01")

    def test_securities_as_of(self):
        f = self.r.read_df("securities", columns=["security_id", "is_active", "sector_history", "identifiers"],
                           as_of="2019-05-01")
        a = f[f.security_id == "A"].iloc[0]
        self.assertTrue(bool(a.is_active), "not yet delisted in 2019")
        self.assertNotIn("delisted_date", f.columns)
        self.assertEqual([h["value"] for h in a.sector_history], ["Tech"])
        self.assertIsNone(a.sector_history[0]["valid_to"], "the 2021 change is in the future")
        self.assertIsNone(a.identifiers[0]["valid_to"])
        later = self.r.read_df("securities", columns=["security_id", "is_active"], as_of="2023-01-03")
        self.assertFalse(bool(later[later.security_id == "A"].iloc[0].is_active))

    def test_index_membership_end_is_hidden_until_it_happens(self):
        f = self.r.read_df("index_membership", columns=["security_id", "valid_from", "valid_to"], as_of="2018-01-02")
        self.assertIsNone(f.iloc[0].valid_to)
        g = self.r.read_df("index_membership", columns=["security_id", "valid_to"], as_of="2021-01-04")
        self.assertEqual(str(g.iloc[0].valid_to), "2020-09-21")

    def test_simulation_ledgers_and_dq_issues_are_refused(self):
        from pipeline.strategy.reader import DataAccessError
        for c in ("sim_trades", "dq_issues"):
            with self.assertRaises(DataAccessError):
                self.r.read_df(c, as_of="2020-01-02")
