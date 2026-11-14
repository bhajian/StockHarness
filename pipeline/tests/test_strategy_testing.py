"""#153: test_strategy returns clear errors with the plugin's line numbers, or a sanity summary (no metrics)."""
import unittest

from pipeline.strategy import job, synthetic

GOOD = '''import numpy as np
META = {"side": "long", "horizon_days": 20, "rebalance": "weekly", "top_n": 5}

def signal(ctx):
    f = ctx.read_df("prices_daily", columns=["security_id", "tr_1d"], lookback_days=60)
    return {s: float(np.prod(1 + g.tr_1d) - 1) for s, g in f.groupby("security_id")}
'''
TYPO = GOOD.replace("float(np.prod(1 + g.tr_1d) - 1)", 'float(g["tr_1dd"].sum())')  # line 6
WRONG_DATE = GOOD.replace('columns=["security_id", "tr_1d"], lookback_days=60',
                          'filter={"date": {"$gt": ctx.date}}, columns=["security_id", "tr_1d"]')
SYNTAX = GOOD.replace("def signal(ctx):", "def signal(ctx)")  # line 4
METRIC_WORDS = ("sharpe", "cagr", "return", "drawdown", "alpha", "equity")


def run(code):
    src, days = synthetic.market(n_sec=30, n_days=300, seed=2)
    return job.run({"action": "test", "code": code, "policies": synthetic.POLICIES, "readable_end": days[-1]}, src), days


def keys(obj, out=None):
    out = set() if out is None else out
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.add(str(k).lower())
            keys(v, out)
    elif isinstance(obj, list):
        for v in obj:
            keys(v, out)
    return out


class TestStrategy(unittest.TestCase):
    def test_a_good_plugin_passes_with_a_summary_and_no_metrics(self):
        r, days = run(GOOD)
        self.assertTrue(r["ok"] and r["test"]["ok"], r)
        t = r["test"]
        self.assertEqual(len(t["dates"]), 4)
        self.assertEqual(t["dates"][-1]["date"], days[-1])
        self.assertTrue(all(d["usable"] == 20 for d in t["dates"]))
        self.assertEqual(t["symbols"], 20)
        self.assertFalse([k for k in keys(t) if any(w in k for w in METRIC_WORDS)])

    def test_typo_in_a_column_names_its_line_and_the_real_columns(self):
        r, _ = run(TYPO)
        e = r["error"]
        self.assertFalse(r["ok"])
        self.assertEqual(e["type"], "KeyError")
        self.assertEqual(e["frames"][-1]["line"], 6)
        self.assertIn('g["tr_1dd"]', e["frames"][-1]["code"])
        self.assertEqual(e["columns"]["prices_daily"], ["as_of_date", "security_id", "tr_1d"])

    def test_wrong_date_field_is_an_empty_signal_and_a_blocked_lookahead(self):
        r, _ = run(WRONG_DATE)
        t = r["test"]
        self.assertFalse(t["ok"])
        self.assertEqual({w["code"] for w in t["warnings"]}, {"empty_signal", "lookahead_blocked"})

    def test_a_missing_requested_column_is_named(self):
        r, _ = run(GOOD.replace('"tr_1d"]', '"tr_1dd"]').replace("g.tr_1d", "g.tr_1dd"))
        t = r["test"]
        self.assertFalse(t["ok"])
        w = next(w for w in t["warnings"] if w["code"] == "missing_columns")
        self.assertEqual(w["columns"], {"prices_daily": ["tr_1dd"]})
        self.assertIn("tr_1d", t["columns_seen"]["prices_daily"])

    def test_syntax_error_names_its_line(self):
        r, _ = run(SYNTAX)
        e = r["error"]
        self.assertEqual(e["type"], "PluginError")
        self.assertEqual(e["problems"], ["line 4: syntax error: expected ':'"])


if __name__ == "__main__":
    unittest.main()


def run_checked(code, checks):
    src, days = synthetic.market(n_sec=30, n_days=300, seed=2)
    return job.run({"action": "test", "code": code, "policies": synthetic.POLICIES, "readable_end": days[-1],
                    "params": {"checks": checks}}, src)


class BookChecks(unittest.TestCase):
    """#377: a book the evaluation would fail on holdings or empty dates fails the test, before a trial."""

    CHECKS = {"min_holdings": 10, "scope_size": 500}

    def codes(self, r):
        return [w["code"] for w in r["test"]["warnings"]]

    def test_a_broad_book_passes(self):
        r = run_checked(GOOD.replace('"top_n": 5', '"top_n": 12'), self.CHECKS)
        self.assertTrue(r["test"]["ok"], r["test"]["warnings"])

    def test_top_n_below_the_holdings_gate_fails(self):
        r = run_checked(GOOD, self.CHECKS)  # top_n 5 < 10
        self.assertFalse(r["test"]["ok"])
        self.assertIn("book_below_holdings_gate", self.codes(r))
        both = run_checked(GOOD.replace('"side": "long"', '"side": "long_short"'), self.CHECKS)
        self.assertNotIn("book_below_holdings_gate", self.codes(both), "long/short holds 2 × top_n")

    def test_a_signal_that_scores_too_few_names_fails(self):
        # One name of the sample scores: about 25 of the scope's 500, not enough for a 30-name book.
        thin = GOOD.replace('"top_n": 5', '"top_n": 30').replace(
            "for s, g in f.groupby(\"security_id\")}", "for s, g in f.groupby(\"security_id\") if s == \"SEC_000000\"}")
        r = run_checked(thin, self.CHECKS)
        codes = self.codes(r)
        self.assertFalse(r["test"]["ok"], codes)
        self.assertTrue("thin_signal" in codes or "empty_on_some_dates" in codes, codes)

    def test_an_empty_date_now_fails(self):
        gated = GOOD.replace('"top_n": 5', '"top_n": 12').replace(
            "    f = ctx.read_df", "    if ctx.date.endswith(\"5\"):\n        return {}\n    f = ctx.read_df")
        r = run_checked(gated, self.CHECKS)
        if any(d["usable"] == 0 for d in r["test"]["dates"]):
            self.assertFalse(r["test"]["ok"])
            self.assertIn("empty_on_some_dates", self.codes(r))

    def test_a_tiny_scope_is_not_held_to_the_holdings_gate(self):
        r = run_checked(GOOD, {"min_holdings": 10, "scope_size": 8})
        self.assertNotIn("book_below_holdings_gate", self.codes(r))

    def test_the_scope_is_sized_from_the_data(self):
        # Top 500 of a 30-name market is 30 names; symbols this database does not have count for nothing.
        top = run_checked(GOOD, {"min_holdings": 10, "scope": {"top": 500}})
        self.assertIn("book_below_holdings_gate", self.codes(top))
        none = run_checked(GOOD, {"min_holdings": 10, "scope": {"symbols": ["AAPL", "MSFT"]}})
        self.assertTrue(none["test"]["ok"], none["test"]["warnings"])

    def test_without_checks_the_old_rules_apply(self):
        r = run(GOOD)[0]
        self.assertTrue(r["test"]["ok"])
