"""The trusted evaluator core (#104): a fixed, versioned engine that runs a strategy plugin.

1. Walk the rebalance dates (META.rebalance) and call the plugin with a point-in-time ctx (reader.py).
2. Build the target book from the scores: top_n (long), bottom_n (short) or both, equal weight, gross from
   backtest.yaml `sizing.gross_limit` (long_short: half long, half short).
3. Execute at the close `execution_lag_days` sessions later (the next day's close by default), paying
   commission + slippage on the traded weight.
4. Hold with drifting weights on daily total returns (prices_daily.tr_1d); shorts pay the annual borrow cost;
   a held security whose prices stop and that is no longer active takes `delisting_return` once.

The result is a structured record (numbers and series, never free text). The same inputs always give the same
record (`record_hash` covers everything but timing).
"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, timedelta

from . import EVALUATOR_MAJOR, EVALUATOR_VERSION, contract, metrics
from .config import load_config
from .context import StrategyContext
from .reader import PitReader


class EvaluationError(ValueError):
    """Inputs the evaluator refuses (bad dates, empty data, an incompatible plugin)."""


def _iso(v) -> str | None:
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    return v[:10] if isinstance(v, str) and len(v) >= 10 else None


def trading_days(source, start: str, end: str) -> list[str]:
    """Sessions in [start, end] from trading_calendar (or, without one, the dates prices_daily has)."""
    days = sorted({d for d in (_iso(r.get("date")) for r in source.find("trading_calendar", {"is_trading_day": True}, ["date"])) if d})
    if not days:
        days = sorted({r["date"] for r in source.find("prices_daily", {"date": {"$gte": start, "$lte": end}}, ["date"])})
    return [d for d in days if start <= d <= end]


def rebalance_dates(days: list[str], every: str) -> list[str]:
    """daily: every session; weekly: first session of each ISO week; monthly: first session of each month."""
    if every == "daily":
        return list(days)
    key = (lambda d: date.fromisoformat(d).isocalendar()[:2]) if every == "weekly" else (lambda d: d[:7])
    out, seen = [], set()
    for d in days:
        k = key(d)
        if k not in seen:
            seen.add(k)
            out.append(d)
    return out


def resolve_scope(source, symbols: list[str] | None) -> tuple[list[str] | None, list[str] | None]:
    """Tickers or security_ids -> (security_ids, tickers). None means the whole universe."""
    if not symbols:
        return None, None
    ids = sorted({s for s in symbols if s.startswith("SEC_")})
    tickers = sorted({s for s in symbols if not s.startswith("SEC_")})
    if tickers:
        for r in source.find("securities", {"identifiers.value": {"$in": tickers}}, ["security_id", "identifiers"]):
            if any(i.get("type") == "ticker" and i.get("value") in tickers for i in r.get("identifiers") or []):
                ids.append(r["security_id"])
    for r in source.find("securities", {"security_id": {"$in": ids}}, ["identifiers"]) if ids else []:
        tickers += [i["value"] for i in r.get("identifiers") or [] if i.get("type") == "ticker"]
    return sorted(set(ids)), sorted(set(tickers))


def _universe_on(source, d: str, scope: list[str] | None, days: list[str]) -> list[str]:
    """In-universe security_ids on `d` (universe_daily for that session, else the latest of the 5 before)."""
    i = days.index(d)
    for back in days[max(0, i - 5): i + 1][::-1]:
        flt = {"date": back, "in_universe": True, **({"security_id": {"$in": scope}} if scope else {})}
        ids = [r["security_id"] for r in source.find("universe_daily", flt, ["security_id"])]
        if ids:
            return sorted(set(ids))
    return sorted(scope) if scope else []


def build_book(scores: dict, eligible: set[str] | None, side: str, top_n: int, gross: float) -> dict[str, float]:
    """Equal-weight target weights; ties break on security_id so the book is deterministic."""
    ranked = sorted(
        ((s, float(v)) for s, v in (scores or {}).items()
         if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
         and (eligible is None or s in eligible)),
        key=lambda x: (-x[1], x[0]),
    )
    book: dict[str, float] = {}
    if not ranked:
        return book
    n = min(top_n, len(ranked) // (2 if side == "long_short" else 1))
    if n < 1:
        return book
    long_w, short_w = (gross / 2, gross / 2) if side == "long_short" else (gross, gross)
    if side in ("long", "long_short"):
        for s, _ in ranked[:n]:
            book[s] = long_w / n
    if side in ("short", "long_short"):
        for s, _ in ranked[-n:]:
            book[s] = book.get(s, 0.0) - short_w / n
    return book


def _round(x, nd=10):
    return None if x is None or not math.isfinite(x) else round(float(x), nd)


def evaluate(code: str, *, source, policies: dict, params: dict, config: dict | None = None,
             readable_end: str | None = None, plugin_ref: dict | None = None) -> dict:
    """Run a plugin over params.start..params.end and return the evaluation record.

    readable_end caps what the plugin may read (the holdout start - 1 in exploration, #105).
    """
    cfg = load_config(config)
    plugin = contract.load(code)
    meta = {**plugin.META, **{k: params[k] for k in ("side", "top_n", "rebalance") if params.get(k) is not None}}
    contract_problems = contract.validate_meta({k: v for k, v in meta.items() if k in contract.META_KEYS})
    if contract_problems:
        raise EvaluationError("; ".join(contract_problems))
    start, end = params.get("start"), params.get("end")
    if not (start and end and start <= end):
        raise EvaluationError("params.start and params.end (YYYY-MM-DD, start <= end) are required")
    if readable_end and end > readable_end:
        raise EvaluationError(f"end {end} is past the readable end {readable_end} (holdout)")
    days = trading_days(source, start, end)
    if len(days) < 3:
        raise EvaluationError(f"fewer than 3 trading days between {start} and {end}")
    scope, tickers = resolve_scope(source, params.get("symbols"))
    if params.get("symbols") and not scope:
        raise EvaluationError("none of params.symbols is a known security")
    reader = PitReader(source, policies, end=readable_end or end, start=start, scope_ids=scope, scope_tickers=tickers)
    lag = int(cfg["execution_lag_days"])
    gross = float(cfg["sizing"].get("gross_limit", 1.0))
    plugin_params = {**plugin.params, **(params.get("plugin_params") or {})}

    # Pass 1: signals on rebalance dates -> target books, executed `lag` sessions later.
    targets: dict[str, dict] = {}
    rebalances = []
    for d in rebalance_dates(days, meta["rebalance"]):
        i = days.index(d)
        if i + lag >= len(days):
            break
        uni = _universe_on(source, d, scope, days)
        ctx = StrategyContext(d, reader, plugin_params, uni)
        chosen = plugin.universe(ctx) if plugin.universe else uni
        eligible = set(chosen) & set(uni) if plugin.universe and uni else set(chosen)
        scores = plugin.signal(ctx)
        if not isinstance(scores, dict):
            raise EvaluationError(f"signal(ctx) returned {type(scores).__name__} on {d}; it must return a dict")
        book = build_book(scores, eligible, meta["side"], int(meta["top_n"]), gross)
        exec_day = days[i + lag]
        targets[exec_day] = book
        rebalances.append({"date": d, "exec_date": exec_day, "scored": len(scores), "eligible": len(eligible),
                           "long": sum(1 for w in book.values() if w > 0), "short": sum(1 for w in book.values() if w < 0)})
    if not rebalances:
        raise EvaluationError("no rebalance date leaves room to execute before the end date")

    # Pass 2: daily total returns of every security the book ever holds.
    held = sorted({s for b in targets.values() for s in b})
    first_exec = min(targets)
    rets: dict[str, dict[str, float]] = {}
    last_price: dict[str, str] = {}
    for r in source.find("prices_daily", {"security_id": {"$in": held}, "date": {"$gte": first_exec}},
                         ["security_id", "date", "tr_1d", "ret_1d"]) if held else []:
        v = r.get("tr_1d") if r.get("tr_1d") is not None else r.get("ret_1d")
        s, d = r["security_id"], r["date"]
        last_price[s] = max(last_price.get(s, d), d)
        if isinstance(v, (int, float)) and math.isfinite(v):
            rets.setdefault(d, {})[s] = float(v)
    inactive = {r["security_id"] for r in source.find("securities", {"security_id": {"$in": held}}, ["security_id", "is_active"])
                if r.get("is_active") is False} if held else set()
    spx = {r["date"]: r.get("spx_ret_1d") for r in source.find("macro_daily", {"date": {"$gte": first_exec, "$lte": end}}, ["date", "spx_ret_1d"])}

    comm = (float(cfg["commission_bps"]) + float(cfg["slippage_bps"])) / 1e4
    borrow_daily = float(cfg["borrow_cost_bps_default"]) / 1e4 / int(cfg["trading_days_per_year"])
    delist_ret = float(cfg["delisting_return"])
    w: dict[str, float] = {}
    delisted: set[str] = set()
    out_dates, out_ret, out_spx, out_gross, out_turn = [], [], [], [], []
    costs_paid = borrow_paid = 0.0
    trades = 0
    for d in days[days.index(first_exec):]:
        day = rets.get(d, {})
        port = 0.0
        moved = {}
        for s, wt in w.items():
            r = day.get(s)
            if r is None and s in inactive and s not in delisted and last_price.get(s, d) < d:
                r = delist_ret  # prices stopped and the company is gone: take the delisting return once
                delisted.add(s)
            moved[s] = wt * (1 + (r or 0.0))
            port += wt * (r or 0.0)
        borrow = sum(-wt for wt in w.values() if wt < 0) * borrow_daily
        w = {s: v / (1 + port) for s, v in moved.items() if s not in delisted} if 1 + port > 0 else {}
        ret = port - borrow
        turnover = 0.0
        if d in targets:
            # Only names with a price at this close can be traded (a delisted or halted name stays out).
            tgt = {s: v for s, v in targets[d].items() if s in day and s not in delisted}
            names = set(tgt) | set(w)
            turnover = sum(abs(tgt.get(s, 0.0) - w.get(s, 0.0)) for s in names)
            trades += sum(1 for s in names if abs(tgt.get(s, 0.0) - w.get(s, 0.0)) > 1e-12)
            ret = (1 + ret) * (1 - turnover * comm) - 1
            costs_paid += turnover * comm
            w = dict(tgt)
        borrow_paid += borrow
        out_dates.append(d)
        out_ret.append(ret)
        out_spx.append(spx.get(d))
        out_gross.append(sum(abs(v) for v in w.values()))
        out_turn.append(turnover)

    summary = metrics.summary(out_ret, int(cfg["trading_days_per_year"]))
    spx_clean = [x if isinstance(x, (int, float)) else 0.0 for x in out_spx]
    nav = 1.0
    nav_s = []
    for r in out_ret:
        nav *= 1 + r
        nav_s.append(_round(nav))
    bnav = 1.0
    bnav_s = []
    for r in spx_clean:
        bnav *= 1 + r
        bnav_s.append(_round(bnav))
    record = {
        "evaluator_version": EVALUATOR_VERSION,
        "plugin": {**(plugin_ref or {}), "hash": plugin.hash, "evaluator_major": EVALUATOR_MAJOR, "meta": meta},
        "params": {k: params[k] for k in sorted(params) if k != "code"},
        "costs": {k: cfg[k] for k in ("execution_lag_days", "commission_bps", "slippage_bps", "borrow_cost_bps_default", "delisting_return")}
        | {"gross_limit": gross},
        "period": {"start": start, "end": end, "first_trade": first_exec, "days": len(out_dates),
                   "readable_end": readable_end or end},
        "data_snapshot": _snapshot(source, end),
        "summary": {k: _round(v) if isinstance(v, float) else v for k, v in summary.items()}
        | {"spx_total_return": _round(metrics.total_return(spx_clean)), "trades": trades,
           "avg_turnover": _round(sum(out_turn) / max(1, len(rebalances))), "costs_paid": _round(costs_paid),
           "borrow_paid": _round(borrow_paid), "delisted": sorted(delisted), "rebalances": len(rebalances)},
        "series": {"dates": out_dates, "series": {
            "returns": [_round(x) for x in out_ret], "equity": nav_s, "spx_equity": bnav_s,
            "spx_returns": [_round(x) if isinstance(x, (int, float)) else None for x in out_spx],
            "gross": [_round(x, 6) for x in out_gross], "turnover": [_round(x, 6) for x in out_turn]}},
        "rebalances": rebalances,
        "holdings": {"date": max(targets), "weights": {s: _round(v, 8) for s, v in sorted(targets[max(targets)].items())}},
        "reader": dict(reader.stats),
    }
    record["record_hash"] = record_hash(record)
    return record


def _snapshot(source, end: str) -> dict:
    """What the data looked like: the latest prices_daily as_of_date on or before the end."""
    rows = source.find("prices_daily", {"as_of_date": {"$lte": end, "$gte": (date.fromisoformat(end) - timedelta(days=10)).isoformat()}}, ["as_of_date"])
    return {"prices_as_of": max((r["as_of_date"] for r in rows), default=None)}


def record_hash(record: dict) -> str:
    body = {k: v for k, v in record.items() if k not in ("record_hash", "timing")}
    return "sha256:" + hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()
