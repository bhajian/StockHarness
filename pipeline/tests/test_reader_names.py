"""#356: reads that select names (a filter of each date's universe) grow one cache instead of reloading the window."""
import unittest

import pandas as pd

from pipeline.strategy import synthetic
from pipeline.strategy.reader import PitReader


class NameFilters(unittest.TestCase):
    def setUp(self):
        self.src, self.days = synthetic.market(n_sec=20, n_days=120, seed=4)
        self.calls = []
        orig = self.src.find
        self.src.find = lambda c, q=None, f=None: (self.calls.append(c), orig(c, q, f))[1]

    def reader(self):
        return PitReader(self.src, synthetic.POLICIES, end=self.days[-1], start=self.days[30])

    def test_same_rows_as_a_fresh_read_and_one_load_per_new_name(self):
        cached = self.reader()
        sets = [[f"SEC_{k:06d}" for k in r] for r in (range(0, 8), range(4, 12), range(0, 8), range(10, 14))]
        for i, names in enumerate(sets):
            d = self.days[40 + i * 10]
            got = cached.read_df("prices_daily", {"security_id": {"$in": names}}, ["date", "tr_1d"], as_of=d,
                                 lookback_days=20)
            want = self.reader().read_df("prices_daily", {"security_id": {"$in": names}}, ["date", "tr_1d"], as_of=d,
                                        lookback_days=20)
            key = ["as_of_date", "date"]
            pd.testing.assert_frame_equal(got.sort_values(key).reset_index(drop=True),
                                          want.sort_values(key).reset_index(drop=True))
            self.assertEqual(list(got.columns), list(want.columns), "security_id is not added to the columns")
        # 4 reads by the cached reader, but only 3 loads: the third set was all loaded already.
        self.assertEqual(self.calls.count("prices_daily") - 4, 3)

    def test_other_filters_stay_part_of_the_key(self):
        r = self.reader()
        a = r.read_df("prices_daily", {"security_id": {"$in": ["SEC_000001"]}, "tr_1d": {"$gt": 0}}, ["tr_1d"],
                      as_of=self.days[60], lookback_days=30)
        b = r.read_df("prices_daily", {"security_id": {"$in": ["SEC_000001"]}}, ["tr_1d"], as_of=self.days[60],
                      lookback_days=30)
        self.assertTrue((a.tr_1d > 0).all())
        self.assertGreater(len(b), len(a))


if __name__ == "__main__":
    unittest.main()
