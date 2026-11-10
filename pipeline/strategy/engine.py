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


def _universe_on(source, d: str, scope: list[str] | None, days: list[str], top: int | None = None) -> list[str]:
    """In-universe security_ids on `d` (universe_daily for that session, else the latest of the 5 before).

    `top` (#300): only the `top` largest by that session's market cap, e.g. 500 as an S&P 500 proxy. Point in time and
    survivorship-free: the ranking uses universe_daily on that date, delisted names included.
    """
    i = days.index(d)
    for back in days[max(0, i - 5): i + 1][::-1]:
        flt = {"date": back, "in_universe": True, **({"security_id": {"$in": scope}} if scope else {})}
        rows = source.find("universe_daily", flt, ["security_id", "market_cap"] if top else ["security_id"])
        if rows:
            if top:
                rows = sorted(rows, key=lambda r: (-(r.get("market_cap") or 0), r["security_id"]))[: int(top)]
            return sorted({r["security_id"] for r in rows})
    return sorted(scope) if scope else []


def universe_top(params: dict) -> int | None:
    """params.universe.top_by_market_cap (#300), validated."""
    top = (params.get("universe") or {}).get("top_by_market_cap")
    if top is None:
        return None
    if not isinstance(top, int) or isinstance(top, bool) or top < 1:
        raise EvaluationError("universe.top_by_market_cap must be a positive integer")
    return top


def top_scope(source, days: list[str], every: str, scope, top: int | None, lag: int):
    """The securities that are ever in the top N on a rebalance date (#300 memory): reads are narrowed to them,
    so a top-500 run does not load every security's rows. Each date's eligible list is unchanged (point in time):
    this only stops loading names that are never in scope. Returns (security_ids, tickers) or (scope, None)."""
    if not top:
        return scope, None
    names: set[str] = set()
    for d in rebalance_dates(days, every):
        if days.index(d) + lag >= len(days):
            break
        names |= set(_universe_on(source, d, scope, days, top))
    ids = sorted(names)
    tickers = sorted({
        i["value"]
        for r in (source.find("securities", {"security_id": {"$in": ids}}, ["identifiers"]) if ids else [])
        for i in r.get("identifiers") or []
        if i.get("type") == "ticker"
    })
    return ids or scope, tickers or None


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


def plan_books(plugin, meta: dict, *, source, reader, days: list[str], scope, lag: int, gross: float,
               plugin_params: dict, top: int | None = None) -> dict:
    """Pass 1 of the evaluator, shared with the paper broker (#124): signals on the rebalance dates -> target
    books, each executed `lag` sessions later. Returns targets {exec day: book}, eligible_at {exec day: (signal
    day, eligible names)}, rebalances (the record's list) and signals {exec day: {security: (score, rank, of)}}
    for the names in the book (what an order links back to)."""
    targets: dict[str, dict] = {}
    eligible_at: dict[str, tuple[str, list[str]]] = {}
    signals: dict[str, dict[str, tuple[float, int, int]]] = {}
    rebalances = []
    for d in rebalance_dates(days, meta["rebalance"]):
        i = days.index(d)
        if i + lag >= len(days):
            break
        uni = _universe_on(source, d, scope, days, top)
        ctx = StrategyContext(d, reader, plugin_params, uni)
        chosen = plugin.universe(ctx) if plugin.universe else uni
        eligible = set(chosen) & set(uni) if plugin.universe and uni else set(chosen)
        scores = plugin.signal(ctx)
        if not isinstance(scores, dict):
            raise EvaluationError(f"signal(ctx) returned {type(scores).__name__} on {d}; it must return a dict")
        book = build_book(scores, eligible, meta["side"], int(meta["top_n"]), gross)
        exec_day = days[i + lag]
        targets[exec_day] = book
        eligible_at[exec_day] = (d, sorted(eligible))
        if book:
            ranked = sorted(((s, float(v)) for s, v in scores.items() if s in eligible and isinstance(v, (int, float))
                             and not isinstance(v, bool) and math.isfinite(v)), key=lambda x: (-x[1], x[0]))
            pos = {s: k + 1 for k, (s, _) in enumerate(ranked)}
            signals[exec_day] = {s: (float(scores[s]), pos.get(s, 0), len(ranked)) for s in book}
        rebalances.append({"date": d, "exec_date": exec_day, "scored": len(scores), "eligible": len(eligible),
                           "long": sum(1 for w in book.values() if w > 0), "short": sum(1 for w in book.values() if w < 0)})
    if not rebalances:
        raise EvaluationError("no rebalance date leaves room to execute before the end date")
    return {"targets": targets, "eligible_at": eligible_at, "rebalances": rebalances, "signals": signals}


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
    lag = int(cfg["execution_lag_days"])
    top = universe_top(params)
    read_ids, read_tickers = top_scope(source, days, meta["rebalance"], scope, top, lag)
    reader = PitReader(source, policies, end=readable_end or end, start=start, scope_ids=read_ids,
                       scope_tickers=read_tickers if top else tickers)
    gross = float(cfg["sizing"].get("gross_limit", 1.0))
    plan = plan_books(plugin, meta, source=source, reader=reader, days=days, scope=scope, lag=lag, gross=gross,
                      plugin_params={**plugin.params, **(params.get("plugin_params") or {})}, top=top)
    targets, eligible_at, rebalances = plan["targets"], plan["eligible_at"], plan["rebalances"]

    # Pass 2: daily total returns of every name held (and, at small scale, of the whole eligible universe, for
    # the sector benchmark and the factor returns).
    held = sorted({s for b in targets.values() for s in b})
    universe_all = sorted({s for _, names in eligible_at.values() for s in names} | set(held))
    benchmarks = len(universe_all) <= int(cfg.get("benchmark_max_names", 600))
    load = universe_all if benchmarks else held
    first_exec = min(targets)
    rets: dict[str, dict[str, float]] = {}
    last_price: dict[str, str] = {}
    for r in source.find("prices_daily", {"security_id": {"$in": load}, "date": {"$gte": first_exec, "$lte": end}},
                         ["security_id", "date", "tr_1d", "ret_1d"]) if load else []:
        v = r.get("tr_1d") if r.get("tr_1d") is not None else r.get("ret_1d")
        s, d = r["security_id"], r["date"]
        last_price[s] = max(last_price.get(s, d), d)
        if isinstance(v, (int, float)) and math.isfinite(v):
            rets.setdefault(d, {})[s] = float(v)
    sec_rows = source.find("securities", {"security_id": {"$in": load}},
                           ["security_id", "is_active", "sector_history", "identifiers"]) if load else []
    inactive = {r["security_id"] for r in sec_rows if r.get("is_active") is False}
    sector = {r["security_id"]: _current(r.get("sector_history")) or "Unknown" for r in sec_rows}
    ticker = {r["security_id"]: _ticker(r) for r in sec_rows}
    macro = {r["date"]: r for r in source.find(
        "macro_daily", {"date": {"$gte": (date.fromisoformat(first_exec) - timedelta(days=420)).isoformat(), "$lte": end}},
        ["date", "spx_ret_1d", "spx_close", "vix"])}

    comm = (float(cfg["commission_bps"]) + float(cfg["slippage_bps"])) / 1e4
    periods = int(cfg["trading_days_per_year"])
    borrow_daily = float(cfg["borrow_cost_bps_default"]) / 1e4 / periods
    delist_ret = float(cfg["delisting_return"])
    w: dict[str, float] = {}
    delisted: set[str] = set()
    out_dates, out_ret, out_spx, out_gross, out_turn, out_sector_bench = [], [], [], [], [], []
    costs_paid = borrow_paid = 0.0
    trades = 0
    extreme = []  # held names with a daily return beyond ±50% (data problems or real events worth a look)
    contrib: dict[str, float] = {}  # sector -> summed daily contribution
    exposure: dict[str, float] = {}  # sector -> summed |weight| (for the average)
    open_trades: dict[str, list] = {}  # security -> [side, growth]
    trade_returns: list[float] = []
    names_acc: dict[str, dict] = {}  # security -> per-name results (#324)

    def name_acc(s):
        return names_acc.setdefault(s, {"contribution": 0.0, "days_long": 0, "days_short": 0, "abs_weight": 0.0,
                                        "trades": [], "by_year": {}, "days_by_year": {}})

    def close_trade(s, side, growth):
        trade_returns.append(side * (growth - 1))
        name_acc(s)["trades"].append(side * (growth - 1))

    for d in days[days.index(first_exec):]:
        day = rets.get(d, {})
        extreme += [(d, s, day[s]) for s in w if s in day and abs(day[s]) > 0.5]
        sector_ew = _sector_means(day, sector, universe_all) if benchmarks else {}
        port = bench = 0.0
        moved = {}
        for s, wt in w.items():
            r = day.get(s)
            if r is None and s in inactive and s not in delisted and last_price.get(s, d) < d:
                r = delist_ret  # prices stopped and the company is gone: take the delisting return once
                delisted.add(s)
            r = r or 0.0
            moved[s] = wt * (1 + r)
            port += wt * r
            sec = sector.get(s, "Unknown")
            contrib[sec] = contrib.get(sec, 0.0) + wt * r
            exposure[sec] = exposure.get(sec, 0.0) + abs(wt)
            a = name_acc(s)
            a["contribution"] += wt * r
            a["abs_weight"] += abs(wt)
            a["days_long" if wt > 0 else "days_short"] += 1
            a["by_year"][d[:4]] = a["by_year"].get(d[:4], 0.0) + wt * r
            a["days_by_year"][d[:4]] = a["days_by_year"].get(d[:4], 0) + 1
            bench += wt * sector_ew.get(sec, r)
            if s in open_trades:
                open_trades[s][1] *= 1 + r
        borrow = sum(-wt for wt in w.values() if wt < 0) * borrow_daily
        w = {s: v / (1 + port) for s, v in moved.items() if s not in delisted} if 1 + port > 0 else {}
        for s in [s for s in open_trades if s in delisted]:
            close_trade(s, *open_trades.pop(s))
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
            for s in names:  # a trade is a holding from entry to exit (or a side flip)
                old_side = (open_trades.get(s) or [0])[0]
                new_side = (tgt.get(s, 0.0) > 0) - (tgt.get(s, 0.0) < 0)
                if old_side and old_side != new_side:
                    close_trade(s, *open_trades.pop(s))
                if new_side and s not in open_trades:
                    open_trades[s] = [new_side, 1.0]
            w = dict(tgt)
        borrow_paid += borrow
        out_dates.append(d)
        out_ret.append(ret)
        out_spx.append((macro.get(d) or {}).get("spx_ret_1d"))
        out_sector_bench.append(bench - borrow if benchmarks else None)
        out_gross.append(sum(abs(v) for v in w.values()))
        out_turn.append(turnover)
    open_at_end = len(open_trades)
    for s, (side, growth) in list(open_trades.items()):  # marked to market
        close_trade(s, side, growth)

    summary = metrics.summary(out_ret, periods)
    spx_clean = [x if isinstance(x, (int, float)) else 0.0 for x in out_spx]
    factor_rets = _factor_returns(source, policies, cfg, targets, eligible_at, rets, out_dates, readable_end or end,
                                  start) if benchmarks else None
    regressors = {"market": spx_clean, **(factor_rets or {})}
    n_days = max(1, len(out_dates))
    record = {
        "evaluator_version": EVALUATOR_VERSION,
        "plugin": {**(plugin_ref or {}), "hash": plugin.hash, "evaluator_major": EVALUATOR_MAJOR, "meta": meta},
        "params": {k: params[k] for k in sorted(params) if k not in ("code", "trials")},
        "costs": {k: cfg[k] for k in ("execution_lag_days", "commission_bps", "slippage_bps", "borrow_cost_bps_default", "delisting_return")}
        | {"gross_limit": gross},
        "period": {"start": start, "end": end, "first_trade": first_exec, "days": len(out_dates),
                   "readable_end": readable_end or end},
        "data_snapshot": _snapshot(source, end),
        "summary": _rounded({**summary, "sortino": metrics.sortino(out_ret, periods),
                             "calmar": metrics.calmar(out_ret, periods), "hit_rate": metrics.hit_rate(out_ret)})
        | {"spx_total_return": _round(metrics.total_return(spx_clean)), "trades": trades,
           "avg_turnover": _round(sum(out_turn) / max(1, len(rebalances))),
           "annual_turnover": _round(sum(out_turn) / n_days * periods), "costs_paid": _round(costs_paid),
           "borrow_paid": _round(borrow_paid), "delisted": sorted(delisted), "rebalances": len(rebalances)},
        "excess": {
            "spx": _rounded(metrics.excess(out_ret, spx_clean, periods)),
            "sector": _rounded(metrics.excess(out_ret, out_sector_bench, periods)) if benchmarks else None,
        },
        "by_regime": _by_regime(out_dates, out_ret, macro, periods),
        "factors": {**_rounded(metrics.ols(out_ret, regressors, periods=periods)),
                    "factors": sorted(regressors), "note": None if factor_rets else "market only (no features_ranked or a large universe)"},
        "by_sector": [{"sector": k, "contribution": _round(contrib[k]), "avg_weight": _round(exposure[k] / n_days, 6)}
                      for k in sorted(contrib, key=lambda k: (-abs(contrib[k]), k))],
        "trade_stats": _trade_stats(trade_returns, open_at_end),
        "series": {"dates": out_dates, "series": {
            "returns": [_round(x) for x in out_ret], "equity": _equity(out_ret), "spx_equity": _equity(spx_clean),
            "drawdown": [_round(x) for x in metrics.drawdown_series(out_ret)],
            "rolling_sharpe_126": [_round(x, 6) if x is not None else None for x in metrics.rolling_sharpe(out_ret, 126, periods)],
            "spx_returns": [_round(x) if isinstance(x, (int, float)) else None for x in out_spx],
            "gross": [_round(x, 6) for x in out_gross], "turnover": [_round(x, 6) for x in out_turn]}},
        "folds": [_rounded(f) for f in metrics.folds(out_dates, out_ret, int(cfg["walk_forward"].get("min_days", 20)), periods)],
        "warnings": _warnings(rebalances, extreme),
        "rebalances": rebalances,
        "holdings": {"date": max(targets), "weights": {s: _round(v, 8) for s, v in sorted(targets[max(targets)].items())}},
        "reader": dict(reader.stats),
    }
    record["record_hash"] = record_hash(record)
    # Per-name results (#324) are derived from the same inputs; they sit outside the hash so evaluations made
    # before they existed still reproduce.
    record["by_name"] = _by_name(names_acc, ticker, sector, n_days)
    # The deflated Sharpe depends on how many trials the whole swarm has run, so it lives outside the hash.
    trials = params.get("trials") or {}
    record["trial_context"] = _rounded(metrics.deflated_sharpe(out_ret, int(trials.get("count") or 1), trials.get("sharpe_variance")))
    return record


def _rounded(d: dict) -> dict:
    return {k: (_round(v) if isinstance(v, float) else _rounded(v) if isinstance(v, dict) else v) for k, v in d.items()}


def _equity(returns) -> list:
    nav, out = 1.0, []
    for r in returns:
        nav *= 1 + r
        out.append(_round(nav))
    return out


def _current(history) -> str | None:
    """The open interval's value of a *_history list (else the latest)."""
    if not history:
        return None
    for h in history:
        if h.get("valid_to") is None:
            return h.get("value")
    return sorted(history, key=lambda h: h.get("valid_from") or "")[-1].get("value")


def _sector_means(day: dict, sector: dict, names: list[str]) -> dict:
    sums: dict[str, list[float]] = {}
    for s in names:
        if s in day:
            sums.setdefault(sector.get(s, "Unknown"), []).append(day[s])
    return {k: sum(v) / len(v) for k, v in sums.items()}


def _by_regime(dates, returns, macro, periods) -> dict:
    """Returns split by market trend (S&P 500 above / below its 200-day average) and by VIX (>= 25 = high)."""
    closes = sorted((d, r["spx_close"]) for d, r in macro.items() if isinstance(r.get("spx_close"), (int, float)))
    sma, window = {}, []
    for d, c in closes:
        window.append(c)
        if len(window) > 200:
            window.pop(0)
        if len(window) == 200:
            sma[d] = (c, sum(window) / 200)
    groups: dict[str, dict[str, list[float]]] = {"trend": {}, "volatility": {}}
    for d, r in zip(dates, returns):
        if d in sma:
            groups["trend"].setdefault("up" if sma[d][0] >= sma[d][1] else "down", []).append(r)
        vix = (macro.get(d) or {}).get("vix")
        if isinstance(vix, (int, float)):
            groups["volatility"].setdefault("high" if vix >= 25 else "normal", []).append(r)
    return {g: {k: _rounded({"days": len(v), "total_return": metrics.total_return(v),
                             "ann_return": sum(v) / len(v) * periods, "sharpe": metrics.sharpe(v, periods)})
                for k, v in sorted(groups[g].items())} for g in groups}


BY_NAME_KEEP = 1000


def _ticker(sec_row: dict) -> str | None:
    for i in sec_row.get("identifiers") or []:
        if i.get("type") == "ticker":
            return i.get("value")
    return None


def _by_name(acc: dict, ticker: dict, sector: dict, n_days: int) -> dict:
    """How each name held did: its contribution to the book's return (before costs), days held, average weight,
    trades and their hit rate, and its contribution by year. Sorted best first."""
    rows = []
    for s, a in acc.items():
        t = a["trades"]
        rows.append({
            "security_id": s, "ticker": ticker.get(s), "sector": sector.get(s, "Unknown"),
            "contribution": _round(a["contribution"]), "days_long": a["days_long"], "days_short": a["days_short"],
            "avg_weight": _round(a["abs_weight"] / max(1, n_days), 8), "trades": len(t),
            "hit_rate": _round(sum(1 for x in t if x > 0) / len(t), 6) if t else None,
            "avg_trade_return": _round(sum(t) / len(t)) if t else None,
            "by_year": {y: _round(v) for y, v in sorted(a["by_year"].items())},
            "days_by_year": dict(sorted(a["days_by_year"].items())),
        })
    rows.sort(key=lambda r: (-r["contribution"], r["security_id"]))
    gains = sorted((r["contribution"] for r in rows if r["contribution"] > 0), reverse=True)
    total_gain = sum(gains)
    top_decile = gains[: max(1, len(rows) // 10)] if gains else []
    return {
        "names": len(rows),
        "positive": sum(1 for r in rows if r["contribution"] > 0),
        "negative": sum(1 for r in rows if r["contribution"] < 0),
        # How much of the gains came from the best 10% of the names held: near 1 = a few names carry it.
        "top_decile_share_of_gains": _round(sum(top_decile) / total_gain, 6) if total_gain > 0 else None,
        # The best and worst BY_NAME_KEEP / 2 when more names were held (keeps the record small).
        "rows": rows if len(rows) <= BY_NAME_KEEP else rows[: BY_NAME_KEEP // 2] + rows[-(BY_NAME_KEEP // 2):],
        "truncated": max(0, len(rows) - BY_NAME_KEEP),
    }


def _trade_stats(trade_returns: list[float], open_at_end: int) -> dict:
    import statistics

    if not trade_returns:
        return {"count": 0, "open_at_end": open_at_end}
    edges = [-1.0, -0.5, -0.3, -0.2, -0.1, -0.05, 0.0, 0.05, 0.1, 0.2, 0.3, 0.5, 1.0, 5.0]
    return {"count": len(trade_returns), "open_at_end": open_at_end,
            "win_rate": _round(sum(1 for r in trade_returns if r > 0) / len(trade_returns)),
            "mean": _round(statistics.fmean(trade_returns)), "median": _round(statistics.median(trade_returns)),
            "histogram": metrics.histogram(trade_returns, edges)}


def _factor_returns(source, policies, cfg, targets, eligible_at, rets, out_dates, readable_end, start) -> dict | None:
    """Long-short factor returns over the eligible universe: top third minus bottom third by each factor field of
    features_ranked on the signal date, equal weight, held to the next execution (#106). None without the data."""
    fields = cfg.get("factors") or {}
    if "features_ranked" not in policies or not fields:
        return None
    # One read over every name ever eligible (the reader caches it), then each date's names in memory: a filter
    # per date would be a new cache entry each time, loading the whole window again (#350: 45 min, then OOM).
    every = sorted({s for _, names in eligible_at.values() for s in names})
    reader = PitReader(source, policies, end=readable_end, start=start, scope_ids=every or None)
    legs: dict[str, dict[str, tuple[list, list]]] = {f: {} for f in fields}
    for exec_day, (signal_day, names) in eligible_at.items():
        try:
            frame = reader.read_df("features_ranked", None, ["security_id", *fields.values()],
                                   as_of=signal_day, lookback_days=7)
        except Exception:  # noqa: BLE001 - factors are optional context
            return None
        frame = frame[frame["security_id"].isin(set(names))] if not frame.empty else frame
        if frame.empty:
            continue
        last = frame.sort_values("as_of_date").groupby("security_id").tail(1)
        for name, col in fields.items():
            vals = last[["security_id", col]].dropna().sort_values([col, "security_id"])
            k = len(vals) // 3
            if k:
                legs[name][exec_day] = (list(vals.security_id[-k:]), list(vals.security_id[:k]))
    out = {}
    for name, by_day in legs.items():
        if not by_day:
            continue
        series, cur = [], None
        for d in out_dates:
            day = rets.get(d, {})
            if cur:
                top = [day[s] for s in cur[0] if s in day]
                bot = [day[s] for s in cur[1] if s in day]
                series.append(sum(top) / len(top) - sum(bot) / len(bot) if top and bot else 0.0)
            else:
                series.append(0.0)
            cur = by_day.get(d, cur)  # formed at this close, earns from the next day
        out[name] = series
    return out or None


def _warnings(rebalances: list[dict], extreme: list[tuple]) -> list[dict]:
    """Structured warnings (codes and counts, no prose the record depends on)."""
    out = []
    empty = [r["date"] for r in rebalances if not r["long"] and not r["short"]]
    if empty:
        out.append({"code": "empty_book", "count": len(empty), "of": len(rebalances), "first": empty[0],
                    "hint": "signal(ctx) returned no usable scores for eligible names (check column names and NaNs)"})
    if extreme:
        out.append({"code": "extreme_returns", "count": len(extreme),
                    "examples": [{"date": d, "security_id": s, "return": _round(r, 6)} for d, s, r in extreme[:5]],
                    "hint": "held names moved more than 50% in a day; check prices_daily dq_flags"})
    return out


def _snapshot(source, end: str) -> dict:
    """What the data looked like: the latest prices_daily as_of_date on or before the end."""
    rows = source.find("prices_daily", {"as_of_date": {"$lte": end, "$gte": (date.fromisoformat(end) - timedelta(days=10)).isoformat()}}, ["as_of_date"])
    return {"prices_as_of": max((r["as_of_date"] for r in rows), default=None)}


def record_hash(record: dict) -> str:
    body = {k: v for k, v in record.items() if k not in ("record_hash", "timing")}
    return "sha256:" + hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()
