"""Placebo and known-answer checks of the evaluator (#468): strategies whose right answer is known, on the real data.

A backtester can show profit from nothing: look-ahead, return math (a dividend on the wrong share basis, #443), a
benchmark or cost mismatch. Each check here has a known outcome; the suite fails loudly when the evaluator disagrees.

- random_signals: random scores (seeded per seed, date and name) earn about the equal-weight universe minus costs.
- buy_and_hold: one name held from start to end. The evaluator's compounded tr_1d must match an independent rebuild
  from the as-traded close, the dividends as paid and split share counts (corporate_actions), within a tolerance.
- benchmark: compounded spx_tr_1d matches SPY's close ratio with its dividends reinvested, rebuilt from eod_index and
  benchmark_dividends.
- future_peek: a plugin asking for rows after its date gets none, and the attempt is counted.
- lag: an edge that vanishes when execution waits one more session is flagged (diagnostic, with a plugin given).
- costs: with costs set to zero the return rises by exactly the costs paid.
"""
from __future__ import annotations

import math
import statistics

from . import engine

RANDOM = '''import random
META = {{"side": "long", "horizon_days": 21, "rebalance": "monthly", "top_n": 30}}

def signal(ctx):
    return {{s: random.Random(f"{seed}:{{ctx.date}}:{{s}}").random() for s in ctx.universe_ids}}
'''
HOLD = '''META = {{"side": "long", "horizon_days": 252, "rebalance": "monthly", "top_n": 1}}

def signal(ctx):
    return {{"{sid}": 1.0}}
'''
PEEK = '''META = {"side": "long", "horizon_days": 5, "rebalance": "weekly", "top_n": 10}

def signal(ctx):
    later = ctx.read_df("prices_daily", filter={"date": {"$gt": str(ctx.date)}}, columns=["security_id", "date", "tr_1d"],
                        lookback_days=10)
    if len(later):
        raise ValueError(f"future rows visible on {ctx.date}: {len(later)}")
    return {s: 1.0 for s in ctx.universe_ids[:10]}
'''


def _evaluate(code, source, policies, params, config, readable_end):
    return engine.evaluate(code, source=source, policies=policies, params=params, config=config,
                           readable_end=readable_end)


def _compound(xs) -> float:
    g = 1.0
    for x in xs:
        if isinstance(x, (int, float)) and math.isfinite(x):
            g *= 1 + x
    return g - 1


def independent_total_return(source, sid: str, start: str, end: str) -> float | None:
    """Buy one share at the first as-traded close, apply splits to the share count and reinvest dividends as paid."""
    bars = sorted(source.find("prices_daily", {"security_id": sid, "date": {"$gte": start, "$lte": end}},
                              ["date", "close", "close_raw"]), key=lambda r: r["date"])
    bars = [b for b in bars if (b.get("close_raw") or b.get("close"))]
    if len(bars) < 2:
        return None
    acts = source.find("corporate_actions", {"security_id": sid}, ["action_type", "ex_date", "split_ratio",
                                                                     "dividend_amount", "adj_dividend_amount"])
    splits = {a["ex_date"]: float(a["split_ratio"]) for a in acts if a.get("action_type") == "split" and a.get("split_ratio")}
    divs = {a["ex_date"]: float(a["dividend_amount"]) for a in acts
            if a.get("action_type") in ("cash_dividend", "special_dividend") and a.get("dividend_amount")}
    price = lambda b: float(b.get("close_raw") or b.get("close"))  # noqa: E731
    shares, first = 1.0, price(bars[0])
    for b in bars[1:]:
        d = b["date"]
        if d in splits:
            shares *= splits[d]
        if d in divs:
            shares += shares * divs[d] / price(b)  # reinvested at that close
    return shares * price(bars[-1]) / first - 1


def benchmark_check(source, start: str, end: str) -> dict:
    macro = sorted(source.find("macro_daily", {"date": {"$gt": start, "$lte": end}}, ["date", "spx_tr_1d"]),
                   key=lambda r: r["date"])
    ours = _compound([m.get("spx_tr_1d") for m in macro])
    spy = sorted(source.find("eod_index", {"symbol": "SPY", "date": {"$gte": start, "$lte": end}}, ["date", "close"]),
                 key=lambda r: str(r["date"]))
    divs = {str(r["date"])[:10]: float(r["dividend"]) for r in source.find("benchmark_dividends", {"symbol": "SPY"},
                                                                         ["date", "dividend"]) if r.get("dividend")}
    if len(spy) < 2:
        return {"check": "benchmark", "passed": None, "detail": "no SPY prices"}
    shares = 1.0
    for r in spy[1:]:
        d = str(r["date"])[:10]
        if d in divs:
            shares += shares * divs[d] / float(r["close"])
    independent = shares * float(spy[-1]["close"]) / float(spy[0]["close"]) - 1
    gap = abs(ours - independent)
    return {"check": "benchmark", "passed": gap < 0.005 * (1 + abs(independent)), "ours": ours,
            "independent": independent, "gap": gap}


def parts(seeds: int = 10, names: list[str] | None = None, lag_code: str | None = None) -> list[str]:
    """The suite as independent parts (#514): each runs in its own job, so no job holds more than one check."""
    return ([f"random:{k}" for k in range(seeds)] + [f"hold:{sid}" for sid in names or []]
            + ["benchmark", "future_peek", "costs"] + (["lag"] if lag_code else []))


def run_part(part: str, source, policies: dict, *, start: str, end: str, readable_end: str | None = None,
             config: dict | None = None, universe: dict | None = None, lag_code: str | None = None,
             symbols: list[str] | None = None) -> list[dict]:
    """One part's check entries (a random seed gives its raw excess; `summarize` turns the seeds into one check)."""
    base = {"start": start, "end": end, **({"universe": universe} if universe else {}),
            **({"symbols": symbols} if symbols else {})}
    kind, _, arg = part.partition(":")
    if kind == "random":  # random signals: excess over the equal-weight eligible universe should be ~0 minus costs
        rec = _evaluate(RANDOM.format(seed=int(arg)), source, policies, base, config, readable_end)
        sec = (rec.get("excess") or {}).get("sector") or {}
        return [{"check": "random_seed", "seed": int(arg),
                 "excess": float(sec["excess_cagr"]) if sec.get("excess_cagr") is not None else None}]
    if kind == "hold":  # buy and hold: the evaluator's return of one name against an independent rebuild
        free = {**(config or {}), "commission_bps": 0, "slippage_bps": 0, "impact": {"coef": 0.0},
                "evaluation_caps": {"max_weight": None, "sector_cap": None}}
        rec = _evaluate(HOLD.format(sid=arg), source, policies, {"start": start, "end": end}, free, readable_end)
        ours = (rec.get("summary") or {}).get("total_return")
        first = (rec.get("period") or {}).get("first_trade") or start
        indep = independent_total_return(source, arg, first, end)
        gap = abs(ours - indep) if ours is not None and indep is not None else None
        return [{"check": f"buy_and_hold:{arg}", "passed": None if gap is None else gap < 0.01 * (1 + abs(indep)),
                 "ours": ours, "independent": indep, "gap": gap, "from": first}]
    if kind == "benchmark":
        return [benchmark_check(source, start, end)]
    if kind == "future_peek":  # the plugin raises if it ever sees a row after its date
        try:
            rec = _evaluate(PEEK, source, policies, base, config, readable_end)
            attempts = (rec.get("reader") or {}).get("lookahead_attempts", 0)
            return [{"check": "future_peek", "passed": attempts > 0, "lookahead_attempts": attempts}]
        except Exception as exc:  # noqa: BLE001 - a visible future row is the failure being tested for
            return [{"check": "future_peek", "passed": False, "error": str(exc)[:300]}]
    if kind == "costs":  # zero costs raise the return by the costs paid (to first order)
        rec = _evaluate(RANDOM.format(seed=0), source, policies, base, config, readable_end)
        free = _evaluate(RANDOM.format(seed=0), source, policies, base,
                         {**(config or {}), "commission_bps": 0, "slippage_bps": 0, "impact": {"coef": 0.0}}, readable_end)
        paid = (rec.get("summary") or {}).get("costs_paid") or 0.0
        lift = _compound((free.get("series") or {}).get("series", {}).get("returns", [])) - _compound(
            (rec.get("series") or {}).get("series", {}).get("returns", []))
        return [{"check": "costs", "passed": paid > 0 and lift > 0 and abs(lift - paid) < 0.5 * paid + 0.002,
                 "costs_paid": paid, "return_lift": lift}]
    if kind == "lag" and lag_code:  # diagnostic: the edge at lag 1, 2 and 5
        lags = {}
        for lag in (1, 2, 5):
            r = _evaluate(lag_code, source, policies, base, {**(config or {}), "execution_lag_days": lag}, readable_end)
            lags[lag] = (r.get("summary") or {}).get("sharpe")
        return [{"check": "lag", "passed": None, "sharpe_by_lag": lags,
                 "flag": bool(lags.get(1) and lags.get(2) is not None and lags[2] < 0.5 * lags[1])}]
    raise ValueError(f"unknown placebo part {part}")


def summarize(entries: list[dict], *, start: str, end: str, universe: dict | None = None) -> dict:
    """The suite's result from its parts' entries: the random seeds become one check, then pass if every decided
    check passes."""
    xs = [e["excess"] for e in entries if e.get("check") == "random_seed" and e.get("excess") is not None]
    seeds = [e for e in entries if e.get("check") == "random_seed"]
    out: list[dict] = []
    if len(xs) >= 2:
        mean, sd = statistics.fmean(xs), statistics.stdev(xs)
        t = mean / (sd / math.sqrt(len(xs))) if sd > 0 else 0.0
        out.append({"check": "random_signals", "passed": mean < 0.01 and t < 2.5, "seeds": len(xs),
                    "mean_excess": mean, "sd": sd, "t": t, "values": xs})
    elif seeds:
        out.append({"check": "random_signals", "passed": None, "detail": "no sector benchmark (scope over 600 names?)"})
    out += [e for e in entries if e.get("check") != "random_seed"]
    decided = [c for c in out if c.get("passed") is not None]
    return {"passed": all(c["passed"] for c in decided) if decided else None, "checks": out,
            "window": {"start": start, "end": end}, "universe": universe}


def run_suite(source, policies: dict, *, start: str, end: str, readable_end: str | None = None,
              config: dict | None = None, universe: dict | None = None, seeds: int = 10,
              names: list[str] | None = None, lag_code: str | None = None, symbols: list[str] | None = None) -> dict:
    """Every check in one process; `universe` is the research scope ({"top_by_market_cap": 500}), `names` the
    buy-and-hold names. The live suite runs the same parts one job each (`parts`, `run_part`, `summarize`)."""
    entries: list[dict] = []
    for part in parts(seeds, names, lag_code):
        entries += run_part(part, source, policies, start=start, end=end, readable_end=readable_end, config=config,
                            universe=universe, lag_code=lag_code, symbols=symbols)
    return summarize(entries, start=start, end=end, universe=universe)
