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

from . import contract, metrics
from .config import load_config
from .engine import EvaluationError, _round, evaluate, record_hash, trading_days
from .pool_cache import PoolCache

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


def _year_split(days: list[str], frac: float) -> int | None:
    """The index of the first session of a year nearest the pick fraction (a year boundary, so the parent's
    per-name results by year can be used), keeping at least 40 sessions on each side; None when there is none."""
    cut = int(len(days) * frac)
    firsts = [i for i in range(40, len(days) - 40) if days[i][:4] != days[i - 1][:4]]
    return min(firsts, key=lambda i: (abs(i - cut), i)) if firsts else None


def _period_summary(dates: list[str], returns: list, spx: list, start: str, periods: int) -> dict:
    """Summary numbers of a returns series from `start` on (the whole scope's check period, from the parent)."""
    idx = [i for i, d in enumerate(dates) if d >= start]
    ret = [float(returns[i] or 0.0) for i in idx]
    bench = [float(spx[i]) if isinstance(spx[i], (int, float)) else 0.0 for i in idx]
    out = metrics.summary(ret, periods)
    return {k: out.get(k) for k in ("cagr", "sharpe", "max_drawdown", "total_return", "ann_vol")} | {
        "trades": None, "excess_cagr": metrics.excess(ret, bench, periods).get("excess_cagr")}


def find_subset(code: str, *, source, policies: dict, params: dict, select: dict | None = None,
                config: dict | None = None, readable_end: str | None = None, plugin_ref: dict | None = None,
                parent: dict | None = None) -> dict:
    """``parent``: the evaluation's own record (by_name with days_by_year, and its series): the pick and the
    whole scope's check numbers come from it instead of two more runs."""
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
    rows_parent = ((parent or {}).get("by_name") or {}).get("rows") or []
    use_parent = (bool(rows_parent) and all("days_by_year" in r for r in rows_parent)
                  and sel["metric"] == "contribution" and not (parent or {}).get("by_name", {}).get("truncated"))
    cut = _year_split(days, frac) if use_parent else None
    use_parent = use_parent and cut is not None
    cut = cut if use_parent else int(len(days) * frac)
    pick_period = {"start": days[0], "end": days[cut - 1]}
    check_period = {"start": days[cut], "end": days[-1]}
    run = lambda p, src=source: evaluate(code, source=src, policies=policies, params=p,  # noqa: E731
                                         config=config, readable_end=readable_end, plugin_ref=plugin_ref)
    base = {k: v for k, v in params.items() if k not in ("start", "end", "symbols", "trials")}
    whole_scope = {"symbols": params["symbols"]} if params.get("symbols") else {}

    # 1. Pick, on the whole scope: from the parent's results by year, or by running the pick period.
    if use_parent:
        split_year = check_period["start"][:4]
        pick_rows = []
        for r in rows_parent:
            years_ = [y for y in r["by_year"] if y < split_year]
            held_days = sum(r["days_by_year"].get(y, 0) for y in years_)
            if held_days:
                pick_rows.append({**r, "contribution": _round(sum(r["by_year"][y] or 0.0 for y in years_)),
                                  "days_long": held_days, "days_short": 0})
        pick_summary, held_names = None, len(pick_rows)
    else:
        pick = run({**base, **whole_scope, **pick_period})
        pick_rows, pick_summary, held_names = pick["by_name"]["rows"], _summary(pick), pick["by_name"]["names"]
    # Enough evidence: held long enough (a name held all along has a single trade, so days count, not trades).
    pool = [r for r in pick_rows
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

    # 2. Check, out of sample: the subset, the whole scope, random subsets of the same size. The chosen names and
    # every random set come from the names the pick period held, so one cache serves all their reads.
    on = lambda ids: {**base, **check_period, "symbols": ids, "top_n": top_n}  # noqa: E731
    ids = sorted(r["security_id"] for r in pick_rows)
    cached = PoolCache(source, ids)
    check = run({**on([r["security_id"] for r in chosen]), "trials": params.get("trials")}, cached)
    if use_parent:
        ser = parent["series"]
        whole_summary = _period_summary(ser["dates"], ser["series"]["returns"],
                                        ser["series"].get("spx_returns") or [None] * len(ser["dates"]),
                                        check_period["start"], int(load_config(config)["trading_days_per_year"]))
    else:
        whole_summary = _summary(run({**base, **whole_scope, **check_period}))
    seed = int(hashlib.sha256(json.dumps([check["plugin"]["hash"], {k: v for k, v in params.items() if k != "trials"},
                                          sel], sort_keys=True, default=str).encode()).hexdigest()[:12], 16)
    rng = random.Random(seed)
    randoms = []
    for _ in range(n_random if len(ids) > k else 0):
        r = run(on(sorted(rng.sample(ids, k))), cached)
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
        "pool": len(pool), "names_held_in_pick": held_names,
        "picked_from": "the evaluation's results by year" if use_parent else "a run over the pick period",
        "chosen": [{k2: r.get(k2) for k2 in ("security_id", "ticker", "sector", "contribution", "trades", "hit_rate",
                                            "avg_trade_return")} for r in chosen],
        "pick": pick_summary, "check": _summary(check), "whole": whole_summary,
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
