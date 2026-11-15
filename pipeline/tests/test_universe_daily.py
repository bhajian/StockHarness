"""#101 universe_daily: filters as of each date, delisted names only while listed, counts per date."""
import unittest
from types import SimpleNamespace

from pipeline.layer2 import universe_daily as u


def days(n, start=1):
    return [f"2020-01-{d:02d}" for d in range(start, start + n)]


SEC = [
    {"security_id": "SEC_1", "identifiers": [{"type": "ticker", "value": "AAA", "valid_from": "2016-01-04", "valid_to": None}],
     "exchange_history": [{"value": "NASDAQ", "valid_from": "2016-01-04", "valid_to": None}]},
    {"security_id": "SEC_2", "identifiers": [{"type": "ticker", "value": "DDD", "valid_from": "2016-01-04", "valid_to": None}],
     "exchange_history": [{"value": "NYSE", "valid_from": "2016-01-04", "valid_to": None}]},
]


def reader(prices, caps=(), fund=(), membership=()):
    data = {"securities": SEC, "prices_daily": prices, "historical_market_cap": list(caps), "fundamentals_pit": list(fund),
            "index_membership": list(membership)}

    def read(c, flt=None, cols=None, sort=None):
        rows = [dict(r) for r in data[c]]
        if flt and "security_id" in flt:
            rows = [r for r in rows if r.get("security_id") == flt["security_id"]]
        if flt and "symbol" in flt:
            rows = [r for r in rows if r.get("symbol") in flt["symbol"]["$in"]]
        d = (flt or {}).get("date")
        if d:
            rows = [r for r in rows if d["$gte"] <= r["date"] <= d["$lte"]]
        return sorted(rows, key=lambda r: r["date"]) if sort else rows

    return read


def collect(gen):
    out = {}
    for name, rows in gen:
        out.setdefault(name, []).extend(rows)
    return out


P = {"min_price": 5, "min_adv_20d": 1000, "min_market_cap": 1e6, "adv_days": 5}


class Universe(unittest.TestCase):
    def test_non_equity_never_joins(self):
        """#393: a note or preferred with a price, volume and the issuer's market cap still fails."""
        global SEC
        saved = SEC
        SEC = [dict(saved[0], security_type="note"), dict(saved[1], security_type="ADR")]
        try:
            prices = [{"security_id": sid, "date": d, "close": 25, "dollar_volume": 9000} for sid in ("SEC_1", "SEC_2") for d in days(10)]
            caps = [{"symbol": t, "date": d, "marketCap": 5e9} for t in ("AAA", "DDD") for d in days(10)]
            out = collect(u.compute(reader(prices, caps=caps), None, P))
            last = {r["security_id"]: r for r in out["universe_daily"] if r["date"] == "2020-01-10"}
            self.assertEqual(last["SEC_1"]["fails"], ["security_type"])
            self.assertTrue(last["SEC_2"]["in_universe"], "ADRs are equity")
        finally:
            SEC = saved

    def test_filters_and_delisted(self):
        prices = [{"security_id": "SEC_1", "date": d, "close": 10, "dollar_volume": 5000} for d in days(20)]
        # DDD trades for 10 days, then is delisted (no more prices).
        prices += [{"security_id": "SEC_2", "date": d, "close": 3 if i == 8 else 20, "dollar_volume": 9000} for i, d in enumerate(days(10))]
        fund = [{"security_id": "SEC_1", "as_of_date": "2020-01-03", "version": 1, "shares_basic": 1e6},
                {"security_id": "SEC_2", "as_of_date": "2019-12-01", "version": 1, "shares_basic": 1e6}]
        out = collect(u.compute(reader(prices, fund=fund), None, P))
        a = {r["date"]: r for r in out["universe_daily"] if r["security_id"] == "SEC_1"}
        self.assertEqual(a["2020-01-02"]["fails"], ["liquidity", "market_cap"], "ADV needs 5 days; shares not known yet")
        self.assertTrue(a["2020-01-10"]["in_universe"])
        self.assertEqual(a["2020-01-10"]["market_cap_source"], "estimated")
        d = {r["date"]: r for r in out["universe_daily"] if r["security_id"] == "SEC_2"}
        self.assertEqual(d["2020-01-09"]["fails"], ["price"])
        self.assertNotIn("2020-01-15", d, "no rows after the last price (delisted)")
        counts = {r["date"]: r["members"] for r in out["universe_counts"]}
        self.assertEqual(counts["2020-01-07"], 2)
        self.assertEqual(counts["2020-01-15"], 1)

    def test_reported_cap_wins_and_window_writes_only_the_window(self):
        prices = [{"security_id": "SEC_1", "date": d, "close": 10, "dollar_volume": 5000} for d in days(20)]
        caps = [{"symbol": "AAA", "date": "2020-01-15", "marketCap": 5e9}]
        w = SimpleNamespace(start="2020-01-15", end="2020-01-16", lookback_start="2020-01-05")
        rows = collect(u.compute(reader(prices, caps), w, P))["universe_daily"]
        self.assertEqual([r["date"] for r in rows], ["2020-01-15", "2020-01-16"])
        self.assertEqual((rows[0]["market_cap"], rows[0]["market_cap_source"]), (5e9, "reported"))
        self.assertIsNotNone(rows[0]["adv_20d"], "the lookback fed the ADV")

    def test_index_flags_as_of_each_date(self):
        """#388: in_sp500 from index_membership intervals [valid_from, valid_to); null where an index has no rows."""
        prices = [{"security_id": s, "date": d, "close": 10, "dollar_volume": 5000} for s in ("SEC_1", "SEC_2") for d in days(10)]
        membership = [
            {"security_id": "SEC_1", "index": "sp500", "valid_from": "2020-01-05", "valid_to": None},
            {"security_id": "SEC_2", "index": "sp500", "valid_from": None, "valid_to": "2020-01-04"},
            {"security_id": None, "index": "dji", "valid_from": "2019-01-02", "valid_to": None},  # unresolved ticker
        ]
        rows = collect(u.compute(reader(prices, membership=membership), None, P))["universe_daily"]
        on = {(r["security_id"], r["date"]): r for r in rows}
        self.assertEqual(on[("SEC_1", "2020-01-04")]["in_sp500"], False, "the day before it joined")
        self.assertEqual(on[("SEC_1", "2020-01-05")]["in_sp500"], True, "member from its effective date")
        self.assertEqual(on[("SEC_2", "2020-01-03")]["in_sp500"], True)
        self.assertEqual(on[("SEC_2", "2020-01-04")]["in_sp500"], False, "out from its removal date")
        self.assertEqual(on[("SEC_1", "2020-01-05")]["in_dji"], False, "the Dow has rows, none for this security")
        self.assertIsNone(on[("SEC_1", "2020-01-05")]["in_ndx"], "no Nasdaq-100 membership built: unknown, not false")
        empty = collect(u.compute(reader(prices), None, P))["universe_daily"]
        self.assertTrue(all(r["in_sp500"] is None for r in empty))
