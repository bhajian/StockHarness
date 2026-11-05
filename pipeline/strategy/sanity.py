"""The evaluator sanity suite (#107), the M3 exit gate.

1. A random long-short signal has a Sharpe of about 0 (bounded over seeds).
2. 12-1 momentum shows the 2022 drawdown (real data: `momentum_2022(record)` checks an evaluation record).
3. A lookahead canary that tries to read tomorrow's return scores about 0, because the reader blocks it; the
   same canary with the cut switched off scores far above any real strategy, so the check has teeth.
4. Re-running gives an identical record.

    python3 -m pipeline.strategy.sanity       # synthetic checks 1, 3, 4; exit status 1 on a failure
"""
from __future__ import annotations

import json
import statistics
import sys

from . import engine, synthetic

RANDOM = '''import random
META = {"side": "long_short", "horizon_days": 5, "rebalance": "weekly", "top_n": 10}

def signal(ctx):
    rnd = random.Random(f"{ctx.date}|{ctx.params.get('seed', 0)}")
    return {s: rnd.random() for s in sorted(ctx.universe_ids)}
'''

MOMENTUM_12_1 = '''META = {"side": "long", "horizon_days": 21, "rebalance": "monthly", "top_n": 10,
        "description": "12-1 momentum: the strongest names over the last year, skipping the last month"}

def signal(ctx):
    f = ctx.read_df("features_ranked", columns=["security_id", "mom_12_1_pct"], lookback_days=7)
    last = f.dropna().sort_values("as_of_date").groupby("security_id").tail(1)
    return dict(zip(last.security_id, last.mom_12_1_pct))
'''

CANARY = '''META = {"side": "long_short", "horizon_days": 1, "rebalance": "daily", "top_n": 5}

def signal(ctx):
    # Tries to score each name by its next-day return: perfect foresight if the reader let it through.
    f = ctx.read_df("prices_daily", {"date": {"$gt": ctx.date}}, ["security_id", "date", "tr_1d"])
    if f.empty:
        return {}
    nxt = f.sort_values("date").groupby("security_id").head(2).groupby("security_id").tail(1)
    return dict(zip(nxt.security_id, nxt.tr_1d))
'''


def _eval(code, src, days, policies=None, **params):
    return engine.evaluate(code, source=src, policies=policies or synthetic.POLICIES,
                           params={"start": days[60], "end": days[-1], **params},
                           config={"commission_bps": 0, "slippage_bps": 0})


def random_signal(seeds: int = 20, bound_mean: float = 0.5, bound_each: float = 2.5) -> dict:
    src, days = synthetic.market(n_sec=40, n_days=560, seed=21, mu=0.0004)
    sharpes = [_eval(RANDOM, src, days, plugin_params={"seed": k})["summary"]["sharpe"] for k in range(seeds)]
    mean = statistics.fmean(sharpes)
    return {"check": "random_signal", "ok": abs(mean) < bound_mean and max(map(abs, sharpes)) < bound_each,
            "mean_sharpe": round(mean, 4), "max_abs_sharpe": round(max(map(abs, sharpes)), 4), "seeds": seeds}


def lookahead_canary() -> dict:
    src, days = synthetic.market(n_sec=30, n_days=300, seed=4)
    blocked = _eval(CANARY, src, days)
    unsafe = _eval(CANARY, src, days, policies={**synthetic.POLICIES, "prices_daily": {"mode": "static"}})
    s_blocked, s_unsafe = blocked["summary"]["sharpe"], unsafe["summary"]["sharpe"]
    return {"check": "lookahead_canary",
            "ok": abs(s_blocked) < 0.5 and s_unsafe > 5 and blocked["reader"]["lookahead_attempts"] > 0,
            "sharpe_blocked": round(s_blocked, 4), "sharpe_without_cut": round(s_unsafe, 4),
            "lookahead_attempts": blocked["reader"]["lookahead_attempts"]}


def reproducibility() -> dict:
    src, days = synthetic.market(n_sec=30, n_days=300, seed=9)
    a = _eval(MOMENTUM_12_1, src, days)
    b = _eval(MOMENTUM_12_1, src, days)
    return {"check": "reproducibility", "ok": a == b and a["record_hash"] == b["record_hash"],
            "record_hash": a["record_hash"]}


def momentum_2022(record: dict, max_2022_return: float = 0.0, max_2022_drawdown: float = -0.10) -> dict:
    """On real data, 12-1 momentum over 2021–2023 should lose money in 2022 with a drawdown of 10% or more."""
    fold = next((f for f in record.get("folds", []) if f["fold"] == "2022"), None)
    ok = bool(fold) and fold["total_return"] < max_2022_return and fold["max_drawdown"] <= max_2022_drawdown
    return {"check": "momentum_2022", "ok": ok, "fold_2022": fold}


def run_synthetic() -> list[dict]:
    return [random_signal(), lookahead_canary(), reproducibility()]


if __name__ == "__main__":
    results = run_synthetic()
    print(json.dumps(results, indent=1))
    sys.exit(0 if all(r["ok"] for r in results) else 1)
