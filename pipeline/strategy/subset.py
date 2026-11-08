"""Name subsets (#325): find the names of a universe a strategy works for, checked out of sample.

Picking the best names on the same data that scores them always finds something. So the window is split:

1. **Pick**: the strategy runs on its whole scope over the first part (``pick_fraction``, 2/3 by default); names
   are ranked by their results there (``by_name``, #324) and the best ``top_k`` held at least ``min_days`` days
   (and ``min_trades`` trades) with a positive contribution are chosen.
2. **Check**: the strategy runs on only the chosen names over the rest of the window (the same plugin; ``top_n``
   is capped at half the subset so the signal still chooses). It is compared with the whole scope over the same
   period, and with ``n_random`` random subsets of the same size drawn from the names the pick period held.

The check run is the record (its metrics are out of sample); ``subset`` says how it was picked and how it
compares. Random subsets are seeded from the plugin hash and params, so the same inputs give the same record.
"""
from __future__ import annotations

import hashlib
import json
import math
import random

from . import contract
from .engine import EvaluationError, _round, evaluate, record_hash, trading_days

METRICS = ("contribution", "avg_trade_return", "hit_rate")
DEFAULTS = {"top_k": 20, "metric": "contribution", "min_trades": 1, "min_days": 10, "pick_fraction": 2 / 3, "n_random": 40,
            "alpha": 0.05}


def _metric(row: dict, metric: str) -> float:
    v = row.get(metric)
    return float(v) if isinstance(v, (int, float)) else float("-inf")


def _summary(rec: dict) -> dict:
    s = rec["summary"]
    return {k: s.get(k) for k in ("cagr", "sharpe", "max_drawdown", "total_return", "ann_vol", "trades")} | {
        "excess_cagr": (rec.get("excess") or {}).get("spx", {}).get("excess_cagr")}


def find_subset(code: str, *, source, policies: dict, params: dict, select: dict | None = None,
                config: dict | None = None, readable_end: str | None = None, plugin_ref: dict | None = None) -> dict:
    sel = {**DEFAULTS, **{k: v for k, v in (select or {}).items() if v is not None}}
    if sel["metric"] not in METRICS:
        raise EvaluationError(f"select.metric must be one of {', '.join(METRICS)}")
    top_k, n_random = int(sel["top_k"]), int(sel["n_random"])
    if not 2 <= top_k <= 200:
        raise EvaluationError("select.top_k must be between 2 and 200")
    alpha = float(sel["alpha"])
    if not 0 < alpha < 0.5:
        raise EvaluationError("select.alpha must be between 0 and 0.5")
    # With n random subsets the smallest p-value is 1 / (n + 1): fewer than 1/alpha - 1 can never pass.
    if not math.ceil(1 / alpha) - 1 <= n_random <= 200:
        raise EvaluationError(f"select.n_random must be between {math.ceil(1 / alpha) - 1} (for alpha {alpha}) and 200")
    frac = float(sel["pick_fraction"])
    if not 0.3 <= frac <= 0.85:
        raise EvaluationError("select.pick_fraction must be between 0.3 and 0.85")
    start, end = params.get("start"), params.get("end")
    days = trading_days(source, start, end) if start and end and start <= end else []
    if len(days) < 120:
        raise EvaluationError("a subset needs at least 120 trading days (a pick period and a check period)")
    cut = int(len(days) * frac)
    pick_period = {"start": days[0], "end": days[cut - 1]}
    check_period = {"start": days[cut], "end": days[-1]}
    run = lambda p: evaluate(code, source=source, policies=policies, params=p, config=config,  # noqa: E731
                             readable_end=readable_end, plugin_ref=plugin_ref)
    base = {k: v for k, v in params.items() if k not in ("start", "end", "symbols", "trials")}

    # 1. Pick, on the whole scope.
    pick = run({**base, **({"symbols": params["symbols"]} if params.get("symbols") else {}), **pick_period})
    # Enough evidence: held long enough (a name held all along has a single trade, so days count, not trades).
    pool = [r for r in pick["by_name"]["rows"]
            if r["trades"] >= int(sel["min_trades"]) and r["days_long"] + r["days_short"] >= int(sel["min_days"])]
    ranked = sorted(pool, key=lambda r: (-_metric(r, sel["metric"]), r["security_id"]))
    chosen = [r for r in ranked if r["contribution"] > 0][:top_k]
    if len(chosen) < min(top_k, 5):
        raise EvaluationError(
            f"only {len(chosen)} names were held at least {sel['min_days']} days with a positive contribution in the "
            f"pick period ({pick_period['start']} → {pick_period['end']}); a subset needs at least {min(top_k, 5)}")
    k = len(chosen)
    meta_top = int(contract.load(code).META.get("top_n") or k)
    top_n = max(1, min(int(params.get("top_n") or meta_top), k // 2))

    # 2. Check, out of sample: the subset, the whole scope, random subsets of the same size.
    on = lambda ids: {**base, **check_period, "symbols": ids, "top_n": top_n}  # noqa: E731
    check = run({**on([r["security_id"] for r in chosen]), "trials": params.get("trials")})
    whole = run({**base, **({"symbols": params["symbols"]} if params.get("symbols") else {}), **check_period})
    seed = int(hashlib.sha256(json.dumps([check["plugin"]["hash"], {k: v for k, v in params.items() if k != "trials"},
                                          sel], sort_keys=True, default=str).encode()).hexdigest()[:12], 16)
    rng = random.Random(seed)
    ids = sorted(r["security_id"] for r in pick["by_name"]["rows"])
    randoms = []
    for _ in range(n_random if len(ids) > k else 0):
        r = run(on(sorted(rng.sample(ids, k))))
        randoms.append(r["summary"].get("sharpe"))
    got = check["summary"].get("sharpe")
    valid = [x for x in randoms if isinstance(x, (int, float))]
    beaten = sum(1 for x in valid if isinstance(got, (int, float)) and x < got)
    p_value = (1 + sum(1 for x in valid if not isinstance(got, (int, float)) or x >= got)) / (1 + len(valid)) if valid else None
    passed = bool(valid) and p_value <= alpha and isinstance(got, (int, float)) and got > 0

    check["params"] = {**check["params"], "subset_of": {k: v for k, v in params.items() if k != "trials"}}
    check["subset"] = {
        "select": {**sel, "pick_fraction": _round(frac, 6)},
        "pick_period": pick_period, "check_period": check_period, "top_n": top_n,
        "pool": len(pool), "names_held_in_pick": pick["by_name"]["names"],
        "chosen": [{k2: r.get(k2) for k2 in ("security_id", "ticker", "sector", "contribution", "trades", "hit_rate",
                                            "avg_trade_return")} for r in chosen],
        "pick": _summary(pick), "check": _summary(check), "whole": _summary(whole),
        "random": {"n": len(valid), "sharpes": sorted(_round(x, 6) for x in valid),
                   "mean_sharpe": _round(sum(valid) / len(valid), 6) if valid else None,
                   "beaten": beaten, "p_value": _round(p_value, 6) if p_value is not None else None},
        "passed": passed,
        "verdict": ("The chosen names beat random subsets of the same size out of sample" if passed else
                    "Not shown: the chosen names did not beat random subsets clearly enough out of sample"
                    if valid else "No random baseline (the pick period held too few names)"),
    }
    trial_context = check.pop("trial_context", None)
    by_name = check.pop("by_name", None)
    check["record_hash"] = record_hash({k: v for k, v in check.items() if k != "record_hash"})
    check["trial_context"], check["by_name"] = trial_context, by_name
    return check
