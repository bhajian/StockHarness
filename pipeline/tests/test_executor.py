"""#467: the signal tape and the independent executor reconcile with the evaluator on a split, a special dividend, a
delisting and a short, and catch the #443 error (an as-paid dividend on split-adjusted prices)."""
import unittest

from pipeline.strategy import executor, reconcile, synthetic
from pipeline.tests.test_strategy_engine import COSTS, constant, run

START, N = "2020-01-01", 140
DAYS = synthetic.weekdays(START, N)
SPLIT_DAY, PRE_SPLIT_DIV_DAY, SPECIAL_DAY, SHORT_DIV_DAY = DAYS[80], DAYS[50], DAYS[90], DAYS[95]
DELIST_AFTER = DAYS[100]


def fixture(as_paid_on_adjusted: bool = False):
    """Four names: a 4-for-1 split (with a dividend before it), a $5 special dividend, a delisting, a dividend paid by
    a short. Closes are split-adjusted, close_raw as traded; tr_1d is the total return on the adjusted series."""
    src, days = synthetic.market(n_sec=4, n_days=N, seed=11, start=START, delist={"SEC_000002": DELIST_AFTER})
    rows: dict[str, list[dict]] = {}
    for r in src.collections["prices_daily"]:
        rows.setdefault(r["security_id"], []).append(r)
    actions = []

    def rebuild(s, dividends_raw: dict[str, float], split: tuple[str, float] | None):
        """Closes from each day's total return, with the price dropping by the dividend on its ex-date."""
        ex, ratio = split or (None, 1.0)
        factor = lambda d: ratio if ex and d < ex else 1.0  # noqa: E731 (as traded = adjusted × later splits)
        c = 100.0
        for r in sorted(rows[s], key=lambda x: x["date"]):
            d = r["date"]
            div_adj = dividends_raw.get(d, 0.0) / factor(d)
            c_new = c * (1 + r["tr_1d"]) - div_adj
            if as_paid_on_adjusted and d in dividends_raw and factor(d) != 1.0:
                # #443: the dividend as paid added to the split-adjusted close (4x too large before a 4:1 split).
                r["tr_1d"] = (c_new + dividends_raw[d]) / c - 1
                r["ret_1d"] = c_new / c - 1
            c = c_new
            r["close"], r["close_raw"] = c, c * factor(d)
        for d, amount in dividends_raw.items():
            actions.append({"security_id": s, "action_type": "special_dividend" if amount >= 5 else "cash_dividend",
                            "ex_date": d, "dividend_amount": amount})
        if split:
            actions.append({"security_id": s, "action_type": "split", "ex_date": ex, "split_ratio": ratio})

    rebuild("SEC_000000", {PRE_SPLIT_DIV_DAY: 4.0}, (SPLIT_DAY, 4.0))
    rebuild("SEC_000001", {SPECIAL_DAY: 5.0}, None)
    rebuild("SEC_000003", {SHORT_DIV_DAY: 2.0}, None)
    src.collections["corporate_actions"] = actions
    return src, days


class Reconciliation(unittest.TestCase):
    def test_split_special_dividend_and_delisting_reconcile_long(self):
        src, days = fixture()
        r = run(constant("long", 3), src, days[20], days[-1])
        c = r["reconciliation"]
        self.assertEqual(c["status"], "reconciled", c["breaches"][:2])
        self.assertLess(c["max_daily_bps"], 0.01)
        self.assertEqual(c["rules"]["violation_count"], 0)
        self.assertNotIn("reconciliation_breach", [w["code"] for w in r["warnings"]])
        self.assertEqual([x["security_id"] for x in r["delistings"]], ["SEC_000002"], "the delisting was held")
        # Every rebalance holds three names until the delisting, then two.
        self.assertGreater(r["signal_tape"]["rows"], 2 * r["signal_tape"]["rebalances"])

    def test_a_short_pays_the_dividend_and_reconciles(self):
        src, days = fixture()
        r = run(constant("short", 1), src, days[20], days[-1])
        self.assertEqual(r["holdings"]["weights"], {"SEC_000003": -1.0})
        self.assertEqual(r["reconciliation"]["status"], "reconciled", r["reconciliation"]["breaches"][:2])

    def test_the_443_error_breaches_on_the_day_and_names_the_security(self):
        src, days = fixture(as_paid_on_adjusted=True)
        r = run(constant("long", 3), src, days[20], days[-1])
        c = r["reconciliation"]
        self.assertEqual(c["status"], "not_reconciled")
        day = next(b for b in c["breaches"] if b["date"] == PRE_SPLIT_DIV_DAY)
        self.assertEqual(day["names"][0]["security_id"], "SEC_000000")
        self.assertGreater(day["evaluator"], day["executor"], "the evaluator over-counted the dividend")
        self.assertIn("reconciliation_breach", [w["code"] for w in r["warnings"]])

    def test_the_tape_hash_reproduces(self):
        src, days = fixture()
        a = run(constant("long", 3), src, days[20], days[-1])
        b = run(constant("long", 3), src, days[20], days[-1])
        self.assertEqual(a["signal_tape"]["hash"], b["signal_tape"]["hash"])
        self.assertTrue(a["signal_tape"]["hash"].startswith("sha256:"))


class Rules(unittest.TestCase):
    def test_an_ineligible_name_is_a_violation_and_a_fill_without_a_price_is_unfilled(self):
        src, days = fixture()
        tape = {"schema": 1, "lag": 1, "sessions": days[30:40],
                "rebalances": [{"signal_date": days[29], "exec_date": days[30], "eligible": 1, "eligible_hash": "x"}],
                "rows": [{"signal_date": days[29], "exec_date": days[30], "security_id": "SEC_NOPRICE", "weight": 0.5},
                         {"signal_date": days[29], "exec_date": days[30], "security_id": "SEC_000001", "weight": 0.5}]}
        out = executor.run(tape, src, COSTS, {days[30]: {"SEC_NOPRICE"}})
        rules = {v["rule"] for v in out["rules"]["violations"]}
        self.assertEqual(rules, {"eligible_on_signal_date"})
        self.assertEqual(out["rules"]["unfilled"], [{"exec_date": days[30], "security_id": "SEC_NOPRICE"}])

    def test_a_fill_before_its_lag_is_a_violation(self):
        src, days = fixture()
        tape = {"schema": 1, "lag": 2, "sessions": days[30:35],
                "rebalances": [{"signal_date": days[29], "exec_date": days[30], "eligible": 1, "eligible_hash": "x"}],
                "rows": [{"signal_date": days[29], "exec_date": days[30], "security_id": "SEC_000001", "weight": 1.0}]}
        out = executor.run(tape, src, COSTS)
        self.assertEqual([v["rule"] for v in out["rules"]["violations"]], ["lag_sessions"])

    def test_compare_flags_drift_without_a_breach_day(self):
        days = synthetic.weekdays(START, 300)
        ev = [0.001] * 300
        ex = {"dates": days, "returns": [0.001 + 0.00004] * 300, "contributions": {}, "rules": {}}
        c = reconcile.compare(days, ev, ex, {})
        self.assertEqual(c["breach_days"], 0)
        self.assertEqual(c["status"], "not_reconciled", "4 bps a day compounds past 1% a year")


class NoCloses(unittest.TestCase):
    def test_returns_only_data_is_unavailable_not_a_breach(self):
        src, days = synthetic.market(n_sec=6, n_days=120, seed=2)
        for r in src.collections["prices_daily"]:
            r.pop("close", None)
        out = run(constant("long", 2), src, days[20], days[-1])
        self.assertEqual(out["reconciliation"]["status"], "unavailable")
        self.assertNotIn("reconciliation_breach", [w["code"] for w in out["warnings"]])



class DataQuirks(unittest.TestCase):
    """#518 and #481 on real data: a stale duplicate dividend row, and a dividend the bars are already adjusted for."""

    def test_a_repeated_row_within_a_class_counts_once(self):
        src, days = fixture()
        dup = next(a for a in src.collections["corporate_actions"] if a["security_id"] == "SEC_000001")
        src.collections["corporate_actions"].append(dict(dup))
        r = run(constant("long", 3), src, days[20], days[-1])
        self.assertEqual(r["reconciliation"]["status"], "reconciled", r["reconciliation"]["breaches"][:1])
        self.assertEqual(r["reconciliation"]["dividends"]["duplicate_count"], 1)

    def test_a_regular_and_a_special_of_the_same_size_both_count(self):
        """Equinor 2024-08-19: $0.35 ordinary + $0.35 extraordinary on one ex-date; tr_1d carries $0.70."""
        src, days = fixture()
        sid, ex = "SEC_000003", DAYS[60]
        rows = sorted((r for r in src.collections["prices_daily"] if r["security_id"] == sid), key=lambda r: r["date"])
        prev = next(r for r in rows if r["date"] < ex and r is rows[rows.index(next(x for x in rows if x["date"] == ex)) - 1])
        today = next(r for r in rows if r["date"] == ex)
        today["tr_1d"] = (today["close"] + 1.0) / prev["close"] - 1  # the price as is, plus $0.50 + $0.50
        for kind in ("cash_dividend", "special_dividend"):
            src.collections["corporate_actions"].append({"security_id": sid, "action_type": kind, "ex_date": ex, "dividend_amount": 0.5})
        r = run(constant("long", 4), src, days[20], days[-1])
        bad = [b for b in r["reconciliation"]["breaches"] if b.get("date") == ex]
        self.assertEqual(bad, [], "both dividends are credited")

    def test_a_dividend_on_an_implausible_dividend_row_is_skipped(self):
        src, days = fixture()
        # A merger payout the adjusted bars already absorb (KDP 2018-07-10): flagged, not in tr_1d.
        src.collections["corporate_actions"].append(
            {"security_id": "SEC_000001", "action_type": "special_dividend", "ex_date": days[60], "dividend_amount": 90.0})
        for p in src.collections["prices_daily"]:
            if p["security_id"] == "SEC_000001" and p["date"] == days[60]:
                p["dq_flags"] = ["implausible_dividend"]
        r = run(constant("long", 3), src, days[20], days[-1])
        self.assertEqual(r["reconciliation"]["status"], "reconciled", r["reconciliation"]["breaches"][:1])
        self.assertEqual(r["reconciliation"]["dividends"]["implausible_skipped"][0]["ex_date"], days[60])


if __name__ == "__main__":
    unittest.main()
