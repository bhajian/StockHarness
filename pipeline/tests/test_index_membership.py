"""#388 index_membership: point-in-time index intervals rebuilt backwards from the current list (stdlib only)."""
import random
import unittest
from datetime import date, timedelta

from pipeline.layer2 import index_membership
from pipeline.layer2.index_membership_logic import added_ticker, build_intervals, member_on, strict_resolver

TODAY = "2026-11-15"


def add(d, t, name=None):
    return {"date": d, "symbol": t, "addedTicker": t, "removedTicker": "", "addedSecurity": name or t, "changeType": "addition"}


def remove(d, t, name=None):
    # FMP puts the removed ticker in `symbol` on removal rows, with an empty addedTicker.
    return {"date": d, "symbol": t, "addedTicker": "", "removedTicker": t, "removedSecurity": name or t, "changeType": "removal"}


def replace(d, a, r):
    return {"date": d, "symbol": a, "addedTicker": a, "removedTicker": r, "addedSecurity": a, "removedSecurity": r, "changeType": "replacement"}


def cur(*tickers, first=None):
    return [{"symbol": t, "name": t, "dateFirstAdded": (first or {}).get(t)} for t in tickers]


def members(ivs, day):
    by = {}
    for iv in ivs:
        by.setdefault(iv["ticker"], []).append(iv)
    return {t for t, xs in by.items() if member_on(xs, day)}


class Reconstruction(unittest.TestCase):
    def test_current_list_and_changes_give_past_membership(self):
        changes = [
            add("2010-01-04", "AAA"), add("2010-01-04", "DDD"), add("2010-01-04", "EEE"),
            remove("2017-03-01", "EEE"),
            add("2018-05-01", "BBB"),
            replace("2020-01-10", "CCC", "DDD"),
        ]
        ivs, issues = build_intervals("sp500", cur("AAA", "BBB", "CCC"), changes, TODAY)
        span = {iv["ticker"]: (iv["valid_from"], iv["valid_to"]) for iv in ivs}
        self.assertEqual(span, {
            "AAA": ("2010-01-04", None), "BBB": ("2018-05-01", None), "CCC": ("2020-01-10", None),
            "DDD": ("2010-01-04", "2020-01-10"), "EEE": ("2010-01-04", "2017-03-01"),
        })
        self.assertEqual(members(ivs, "2016-06-01"), {"AAA", "DDD", "EEE"})
        self.assertEqual(members(ivs, "2019-01-02"), {"AAA", "BBB", "DDD"})
        self.assertEqual(members(ivs, TODAY), {"AAA", "BBB", "CCC"})
        self.assertEqual(issues, [])
        self.assertTrue(all(iv["source"] == "change" for iv in ivs))

    def test_effective_date_boundaries(self):
        ivs, _ = build_intervals("sp500", cur("NEW"), [add("2001-01-02", "OLD"), replace("2020-03-02", "NEW", "OLD")], TODAY)
        self.assertEqual(members(ivs, "2020-02-28"), {"OLD"}, "the day before: the change has not happened")
        self.assertEqual(members(ivs, "2020-03-02"), {"NEW"}, "effective on its date: added in, removed out")

    def test_removal_rows_are_not_additions(self):
        self.assertEqual(added_ticker(remove("2024-06-24", "CMA")), "")
        self.assertEqual(added_ticker({"date": "2020-01-02", "symbol": "XYZ", "changeType": "addition"}), "XYZ")
        ivs, issues = build_intervals("sp500", cur("AAA"), [add("2010-01-04", "AAA"), add("2010-01-04", "CMA"), remove("2024-06-24", "CMA")], TODAY)
        self.assertEqual({iv["ticker"]: iv["valid_to"] for iv in ivs}, {"AAA": None, "CMA": "2024-06-24"})
        self.assertEqual(issues, [])


class NoLookahead(unittest.TestCase):
    def test_membership_on_day_d_matches_a_forward_replay_of_changes_up_to_d(self):
        """Random histories: the backward rebuild equals replaying only the changes dated <= D (no lookahead)."""
        rng = random.Random(388)
        for trial in range(25):
            tickers = [f"T{i:03d}" for i in range(60)]
            start = date(2012, 1, 3)
            members_now = set(rng.sample(tickers, 20))
            changes = [add(start.isoformat(), t) for t in sorted(members_now)]
            d = start
            for _ in range(40):
                d += timedelta(days=rng.randint(1, 120))
                outside = [t for t in tickers if t not in members_now]
                kind = rng.choice(["replacement", "addition", "removal"])
                if kind != "removal" and outside:
                    a = rng.choice(outside)
                else:
                    a = ""
                r = rng.choice(sorted(members_now)) if kind != "addition" and members_now else ""
                if not a and not r:
                    continue
                changes.append(replace(d.isoformat(), a, r) if a and r else add(d.isoformat(), a) if a else remove(d.isoformat(), r))
                members_now.discard(r)
                if a:
                    members_now.add(a)
            ivs, issues = build_intervals("sp500", cur(*sorted(members_now)), changes, TODAY)
            self.assertEqual(issues, [], trial)
            day = start
            while day.isoformat() < d.isoformat():
                iso = day.isoformat()
                truth = set()
                for c in sorted((c for c in changes if c["date"] <= iso), key=lambda c: c["date"]):
                    truth.discard(c["removedTicker"])
                    if c["addedTicker"]:
                        truth.add(c["addedTicker"])
                self.assertEqual(members(ivs, iso), truth, f"trial {trial} on {iso}")
                day += timedelta(days=17)


class Renames(unittest.TestCase):
    def test_a_renamed_member_is_paired_with_its_addition_by_date_first_added(self):
        # EchoStar joined as SATS on 2026-03-23 and trades as ECHO now; FMP lists the addition under SATS.
        changes = [add("2010-01-04", "AAA"), add("2010-01-04", "ZZZ"), replace("2026-03-23", "SATS", "ZZZ")]
        ivs, issues = build_intervals("sp500", cur("AAA", "ECHO", first={"ECHO": "2026-03-23"}), changes, TODAY)
        echo = next(iv for iv in ivs if iv["ticker"] == "ECHO")
        self.assertEqual((echo["tickers"], echo["valid_from"], echo["source"]), (["SATS", "ECHO"], "2026-03-23", "rename"))
        self.assertEqual(members(ivs, "2026-03-20"), {"AAA", "ZZZ"}, "not a member before it joined")
        self.assertEqual(issues, [])

    def test_a_renamed_former_member_is_paired_by_name(self):
        changes = [add("2010-01-04", "AAA"), add("2018-02-01", "OLD", "Fiserv, Inc."), remove("2024-05-01", "NEW", "Fiserv Inc")]
        ivs, issues = build_intervals("sp500", cur("AAA"), changes, TODAY)
        new = next(iv for iv in ivs if iv["ticker"] == "NEW")
        self.assertEqual((new["valid_from"], new["valid_to"], new["tickers"]), ("2018-02-01", "2024-05-01", ["OLD", "NEW"]))
        self.assertNotIn("NEW", members(ivs, "2017-06-01"))

    def test_current_member_without_its_addition_starts_at_date_first_added(self):
        ivs, issues = build_intervals("sp500", cur("AAA", first={"AAA": "2019-09-23"}), [], TODAY)
        self.assertEqual((ivs[0]["valid_from"], ivs[0]["source"]), ("2019-09-23", "first_added"))
        self.assertEqual(issues, [])

    def test_unknown_starts_are_flagged_only_when_they_matter(self):
        ivs, issues = build_intervals("sp500", cur("AAA"), [remove("2019-01-17", "PCG"), remove("2001-01-02", "OLD")], TODAY)
        self.assertEqual({iv["ticker"]: iv["source"] for iv in ivs}, {"AAA": "unknown", "PCG": "unknown", "OLD": "unknown"})
        self.assertEqual(sorted((i["issue_type"], i["ticker"]) for i in issues), [("start_unknown", "AAA"), ("start_unknown", "PCG")])


SECURITIES = [
    {"security_id": "SEC_1", "identifiers": [{"type": "ticker", "value": "AAA", "valid_from": "2016-01-04", "valid_to": None}]},
    {"security_id": "SEC_2", "identifiers": [{"type": "ticker", "value": "BBB", "valid_from": "2016-01-04", "valid_to": None}]},
    # A ticker reused by another company after 2021.
    {"security_id": "SEC_3", "identifiers": [{"type": "ticker", "value": "CCC", "valid_from": "2016-01-04", "valid_to": "2021-06-01"}]},
    {"security_id": "SEC_4", "identifiers": [{"type": "ticker", "value": "CCC", "valid_from": "2021-06-01", "valid_to": None}]},
]


class Resolution(unittest.TestCase):
    def test_tickers_resolve_to_securities_as_of_the_change(self):
        resolve = strict_resolver(SECURITIES)
        self.assertEqual(resolve("AAA", "2001-05-01"), "SEC_1", "before our identifiers start: the earliest holder")
        self.assertEqual(resolve("CCC", "2019-01-02"), "SEC_3")
        self.assertEqual(resolve("CCC", "2022-01-03"), "SEC_4")
        self.assertIsNone(resolve("ZZZ", "2022-01-03"))
        changes = [add("2010-01-04", "AAA"), add("2010-01-04", "CCC"), remove("2020-01-02", "CCC"), add("2023-01-03", "CCC"), add("2023-01-03", "QQQ")]
        ivs, issues = build_intervals("sp500", cur("AAA", "CCC", "QQQ"), changes, TODAY, resolve)
        got = sorted((iv["ticker"], iv["security_id"], iv["valid_from"], iv["valid_to"]) for iv in ivs)
        self.assertEqual(got, [
            ("AAA", "SEC_1", "2010-01-04", None),
            ("CCC", "SEC_3", "2010-01-04", "2020-01-02"),
            ("CCC", "SEC_4", "2023-01-03", None),
            ("QQQ", None, "2023-01-03", None),
        ])
        self.assertEqual([(i["issue_type"], i["ticker"]) for i in issues], [("unresolved_ticker", "QQQ")])


def reader(data):
    def read(c, flt=None, cols=None, sort=None):
        return [dict(r) for r in data.get(c, [])]

    return read


class Transform(unittest.TestCase):
    def test_compute_rows_are_point_in_time_and_keyed(self):
        data = {
            "securities": SECURITIES,
            "index_constituents": [{**r, "index": "sp500"} for r in cur("AAA", "BBB")] + [{**r, "index": "dji"} for r in cur("AAA")],
            "index_changes": [{**c, "index": "sp500"} for c in (add("2010-01-04", "AAA"), add("2010-01-04", "DDD"), replace("2020-01-10", "BBB", "DDD"))]
            + [{**add("2015-03-19", "AAA"), "index": "dji"}],
        }
        rows, issues = index_membership.compute(reader(data), today=TODAY)
        by = {(r["index"], r["ticker"]): r for r in rows}
        self.assertEqual(set(by), {("sp500", "AAA"), ("sp500", "BBB"), ("sp500", "DDD"), ("dji", "AAA")})
        bbb = by[("sp500", "BBB")]
        self.assertEqual((bbb["security_id"], bbb["valid_from"], bbb["as_of_date"], bbb["membership_id"]), ("SEC_2", "2020-01-10", "2020-01-10", "sp500:SEC_2:2020-01-10"))
        self.assertTrue(bbb["known_at"].startswith("2020-01-10"))
        self.assertEqual(len({r["membership_id"] for r in rows}), len(rows), "unique keys")
        self.assertEqual([(i["issue_type"], i["ticker"], i["index"]) for i in issues], [("unresolved_ticker", "DDD", "sp500")])
        # No current list for an index: nothing is produced for it.
        self.assertFalse(any(r["index"] == "ndx" for r in rows))


if __name__ == "__main__":
    unittest.main()
