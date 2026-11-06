"""Simulations (#124, #125): one or more ideas run as one book through the paper broker.

Each idea's target books come from the evaluator's own signal walk (engine.plan_books), so with the default
settings (equal weight, exits only when a name is replaced) a one-idea simulation reproduces the evaluation's
equity curve. On top of that:

- allocation across ideas: equal, risk parity (inverse trailing volatility of each idea's book) or custom;
- sizing: equal weight, or quarter-Kelly on the shrunk edge of each idea's book (estimated from its own history
  up to the day before, so nothing is known before it happened), capped per position;
- constraints: per-position, per-sector, gross and net limits; shorts skip hard-to-borrow names;
- daily exits, decided at a close and filled `execution_lag_days` later: stop, take-profit (a fixed return, or
  "p90": the 90th percentile of the idea's closed trades so far), horizon (META.horizon_days without a rebalance
  keeping it), and the plugin's optional review(ctx, held) -> {security: "invalidation" | "p_outperform"}.

The ledger (orders, trades, the daily portfolio and positions) goes to a sink: the workspace database in the
executor, lists in tests. The result is the summary, the series and the attribution; `ledger_hash` covers the
whole ledger, so the same config and seed give the same hash.
"""
from __future__ import annotations

import hashlib
import json
import math
import statistics

from . import EVALUATOR_VERSION, contract, metrics
from .broker import PaperBroker
from .config import load_config
from .context import StrategyContext
from .engine import EvaluationError, _current, _universe_on, plan_books, resolve_scope, trading_days
from .reader import PitReader

SIMULATOR_VERSION = "1.0.0"
COLLECTIONS = ("sim_orders", "sim_trades", "sim_portfolio_daily", "sim_positions")
DEFAULTS = {
    "capital": 1_000_000.0,
    "allocation": {"mode": "equal"},  # equal | risk_parity | custom (weights by idea id)
    "sizing": {"mode": "equal", "kelly_fraction": 0.25, "prior_days": 252, "min_history": 63, "fallback": 1.0},
    "constraints": {"position_cap": None, "sector_cap": None, "gross": 1.0, "net": None},
    "exits": {"stop": None, "take_profit": None, "horizon": False, "review": True},
    "hard_to_borrow": [],
    "dividends": "reinvest",  # reinvest | cash (see broker.PaperBroker.dividends)
    "seed": 0,
}


class ListSink:
    """Collects the ledger in memory (tests, and the preview of a run)."""

    def __init__(self):
        self.rows: dict[str, list[dict]] = {c: [] for c in COLLECTIONS}

    def write(self, collection: str, docs: list[dict]) -> None:
        self.rows[collection].extend(docs)


class MongoSink:
    """Writes the ledger to the workspace database, replacing an earlier run of the same simulation."""

    def __init__(self, db, simulation_id: str, batch: int = 2000):
        self.db, self.id, self.batch = db, simulation_id, batch
        for c in COLLECTIONS:
            db[c].delete_many({"simulation_id": simulation_id})
            db[c].create_index([("simulation_id", 1), ("date", 1)])

    def write(self, collection: str, docs: list[dict]) -> None:
        for i in range(0, len(docs), self.batch):
            chunk = [{"simulation_id": self.id, **d} for d in docs[i:i + self.batch]]
            if chunk:
                self.db[collection].insert_many(chunk, ordered=True)


def _merge(base: dict, over: dict | None) -> dict:
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in base.items()}
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = {**out[k], **{a: b for a, b in v.items()}}
        elif v is not None or k in out:
            out[k] = v
    return out


def simulate(ideas: list[dict], *, source, policies: dict, params: dict, config: dict | None = None,
             readable_end: str | None = None, sink=None) -> dict:
    """Run `ideas` ([{id, ref?, code, plugin_ref?}]) over params.start..params.end as one book."""
    if not ideas:
        raise EvaluationError("a simulation needs at least one idea")
    cfg = load_config(config)
    sim = _merge(DEFAULTS, {k: params.get(k) for k in DEFAULTS if k in params})
    costs = {**{k: cfg[k] for k in ("commission_bps", "slippage_bps", "borrow_cost_bps_default", "delisting_return",
                                     "execution_lag_days")}, **(params.get("costs") or {})}
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
    lag = int(costs["execution_lag_days"])
    gross = float(sim["constraints"].get("gross") or 1.0)
    sink = sink or ListSink()

    # Pass 1: every idea's target books (the evaluator's walk).
    plans, plugins, metas = {}, {}, {}
    for idea in ideas:
        try:
            _plan_idea(idea, plans, plugins, metas, source=source, reader=reader, days=days, scope=scope, lag=lag,
                       gross=gross)
        except Exception as exc:  # noqa: BLE001 - re-raised with the idea it came from (for the error frames)
            exc.idea_id = idea["id"]
            raise
    first = min(min(p["targets"]) for p in plans.values())
    names = sorted({s for p in plans.values() for b in p["targets"].values() for s in b})

    # Pass 2: prices of every name an idea may hold, securities, the benchmark.
    bars: dict[str, dict[str, dict]] = {}
    final_bar: dict[str, str] = {}
    for r in source.find("prices_daily", {"security_id": {"$in": names}, "date": {"$gte": first, "$lte": end}},
                         ["security_id", "date", "close", "ret_1d", "tr_1d"]) if names else []:
        bars.setdefault(r["date"], {})[r["security_id"]] = r
        final_bar[r["security_id"]] = max(final_bar.get(r["security_id"], r["date"]), r["date"])
    sec_rows = source.find("securities", {"security_id": {"$in": names}},
                           ["security_id", "is_active", "sector_history", "identifiers", "hard_to_borrow"]) if names else []
    sector = {r["security_id"]: _current(r.get("sector_history")) or "Unknown" for r in sec_rows}
    ticker = {r["security_id"]: next((i.get("value") for i in r.get("identifiers") or [] if i.get("type") == "ticker"), None)
              for r in sec_rows}
    htb = set(sim.get("hard_to_borrow") or []) | {r["security_id"] for r in sec_rows if r.get("hard_to_borrow")}
    spx = {r["date"]: r.get("spx_ret_1d") for r in source.find("macro_daily", {"date": {"$gte": first, "$lte": end}},
                                                                 ["date", "spx_ret_1d"])}
    broker = PaperBroker(
        float(sim["capital"]), commission_bps=float(costs["commission_bps"]), slippage_bps=float(costs["slippage_bps"]),
        borrow_bps=float(costs["borrow_cost_bps_default"]), delisting_return=float(costs["delisting_return"]),
        periods=int(cfg["trading_days_per_year"]),
        inactive={r["security_id"] for r in sec_rows if r.get("is_active") is False},
        final_bar=final_bar, tickers=ticker, dividends=str(sim.get("dividends") or "reinvest"))

    ids = [i["id"] for i in ideas]
    shadow: dict[str, list[float]] = {i: [] for i in ids}  # each idea's unscaled book return per day
    current_book: dict[str, dict] = {i: {} for i in ids}
    pending: dict[str, list[tuple]] = {}  # fill day -> [(key, reason)]
    blocked: dict[tuple, tuple[str, str]] = {}  # (idea, security) -> (exit decision date, reason)
    closed_returns: dict[str, list[float]] = {i: [] for i in ids}
    run_days = days[days.index(first):]
    portfolio, positions_out = [], []
    trades_seen = 0
    for di, d in enumerate(run_days):
        day_bars = bars.get(d, {})
        broker.open_day(d, day_bars)
        for idea in ids:  # the shadow book's return today (for risk parity and Kelly)
            b = current_book[idea]
            shadow[idea].append(sum(w * _tr(day_bars.get(s)) for s, w in b.items()))
        for key, reason in pending.pop(d, []):
            broker.exit(d, key, reason)
        books, signals = {}, {}
        for idea in ids:
            plan = plans[idea]
            if d not in plan["targets"]:
                continue
            signal_day = plan["eligible_at"][d][0]
            book = {s: w for s, w in plan["targets"][d].items() if not (w < 0 and s in htb)}
            book = {s: w for s, w in book.items() if blocked.get((idea, s), ("",))[0] < signal_day}
            current_book[idea] = dict(plan["targets"][d])
            books[idea] = book
            signals[idea] = {s: (*v, signal_day) for s, v in plan["signals"].get(d, {}).items()}
        if books:
            alloc = _allocation(sim["allocation"], ids, shadow)
            sized = {idea: _size(book, sim["sizing"], shadow[idea][:-1], alloc[idea]) for idea, book in books.items()}
            sized = _constrain(sized, broker, sim["constraints"], sector)
            # A name waiting on an exit that the rebalance sells first leaves with the exit's reason.
            broker.rebalance(d, sized, signals, {k: why for k, (_, why) in blocked.items()})
            for key in list(blocked):
                if key[0] in books and key[1] in books[key[0]]:
                    del blocked[key]
        for t in broker.trades[trades_seen:]:
            closed_returns[t["idea_id"]].append(t["return"] or 0.0)
        trades_seen = len(broker.trades)
        # Exits decided at this close, filled `lag` sessions later.
        if di + lag < len(run_days):
            fill = run_days[di + lag]
            for key, reason in _exit_decisions(d, broker, sim["exits"], metas, plugins, closed_returns, reader,
                                               plans, ideas, source, scope, days):
                if not any(k == key for k, _ in pending.get(fill, [])):
                    pending.setdefault(fill, []).append((key, reason))
                    blocked[key] = (d, reason)
        row, positions = broker.close_day(d, sector)
        row["spx_return"] = spx.get(d)
        portfolio.append(row)
        positions_out.extend(positions)
    # Lots still open at the end are marked to market as trades closed "end" (not filled, no costs).
    open_at_end = [{**_open_trade(broker, key, run_days[-1]), "n": len(broker.trades) + k + 1}
                   for k, key in enumerate(sorted(broker.lots))]

    raw_returns = [r["return"] for r in portfolio]  # metrics use these, not the ledger's rounded copy
    orders = [_clean(o) for o in broker.orders]
    trades = [_clean(t) for t in broker.trades + open_at_end]
    portfolio = [_clean(r) for r in portfolio]
    positions_out = [_clean(p) for p in positions_out]
    for c, docs in zip(COLLECTIONS, (orders, trades, portfolio, positions_out)):
        sink.write(c, docs)
    return _result(ideas, plans, metas, sim, costs, params, portfolio, trades, orders, positions_out,
                   int(cfg["trading_days_per_year"]), readable_end or end, sector, raw_returns)


def _plan_idea(idea, plans, plugins, metas, *, source, reader, days, scope, lag, gross):
    plugin = contract.load(idea["code"])
    over = idea.get("overrides") or {}
    meta = {**plugin.META, **{k: over[k] for k in ("side", "top_n", "rebalance") if over.get(k) is not None}}
    plans[idea["id"]] = plan_books(plugin, meta, source=source, reader=reader, days=days, scope=scope, lag=lag,
                                   gross=gross, plugin_params={**plugin.params, **(idea.get("plugin_params") or {})})
    plugins[idea["id"]], metas[idea["id"]] = plugin, meta


def _tr(bar) -> float:
    if not bar:
        return 0.0
    v = bar.get("tr_1d") if bar.get("tr_1d") is not None else bar.get("ret_1d")
    return float(v) if isinstance(v, (int, float)) and math.isfinite(v) else 0.0


def _allocation(cfg: dict, ids: list[str], shadow: dict[str, list[float]]) -> dict[str, float]:
    mode = (cfg or {}).get("mode", "equal")
    if mode == "custom":
        w = {i: max(0.0, float((cfg.get("weights") or {}).get(i, 0.0))) for i in ids}
        total = sum(w.values())
        return {i: w[i] / total for i in ids} if total > 1 + 1e-9 else w  # sum < 1 keeps the rest in cash
    if mode == "risk_parity":
        vols = {}
        for i in ids:
            hist = shadow[i][-64:-1]
            vols[i] = statistics.pstdev(hist) if len(hist) >= 20 and statistics.pstdev(hist) > 0 else None
        if all(v for v in vols.values()):
            inv = {i: 1 / vols[i] for i in ids}
            total = sum(inv.values())
            return {i: inv[i] / total for i in ids}
    return {i: 1 / len(ids) for i in ids}


def _size(book: dict[str, float], cfg: dict, history: list[float], alloc: float) -> dict[str, float]:
    """The idea's book scaled to its allocation, then by quarter-Kelly on its shrunk edge (if chosen)."""
    scale = alloc
    if cfg.get("mode") == "quarter_kelly":
        n = len(history)
        if n >= int(cfg.get("min_history", 63)):
            mu = statistics.fmean(history) * n / (n + float(cfg.get("prior_days", 252)))
            var = statistics.pvariance(history)
            f = float(cfg.get("kelly_fraction", 0.25)) * mu / var if var > 0 else 0.0
            scale *= max(0.0, min(f, 1.0))
        else:
            scale *= float(cfg.get("fallback", 1.0))
    return {s: w * scale for s, w in book.items()}


def _constrain(books: dict[str, dict[str, float]], broker: PaperBroker, cfg: dict, sector: dict) -> dict:
    """Per-position, per-sector, gross and net limits over the whole book (other ideas' lots as they are)."""
    cap = cfg.get("position_cap")
    out = {i: {s: (max(-cap, min(cap, w)) if cap else w) for s, w in b.items()} for i, b in books.items()}
    others = {k: w for k, w in broker.weights().items() if k[0] not in books}

    def all_weights():
        return list(others.items()) + [((i, s), w) for i, b in out.items() for s, w in b.items()]

    sector_cap = cfg.get("sector_cap")
    if sector_cap:
        by: dict[str, float] = {}
        for (i, s), w in all_weights():
            by[sector.get(s, "Unknown")] = by.get(sector.get(s, "Unknown"), 0.0) + abs(w)
        for sec, total in by.items():
            if total > sector_cap + 1e-9:
                mine = sum(abs(w) for i, b in out.items() for s, w in b.items() if sector.get(s, "Unknown") == sec)
                fixed = total - mine
                k = max(0.0, (sector_cap - fixed) / mine) if mine else 1.0
                for b in out.values():
                    for s in b:
                        if sector.get(s, "Unknown") == sec:
                            b[s] *= k
    gross = cfg.get("gross")
    if gross:
        total = sum(abs(w) for _, w in all_weights())
        if total > gross + 1e-9:
            mine = sum(abs(w) for b in out.values() for w in b.values())
            k = max(0.0, (gross - (total - mine)) / mine) if mine else 1.0
            out = {i: {s: w * k for s, w in b.items()} for i, b in out.items()}
    net = cfg.get("net")
    if net is not None:
        total = sum(w for _, w in all_weights())
        if abs(total) > net + 1e-9:
            side = 1 if total > 0 else -1
            mine = sum(w for b in out.values() for w in b.values() if w * side > 0)
            excess = abs(total) - net
            k = max(0.0, 1 - excess / abs(mine)) if mine else 1.0
            out = {i: {s: (w * k if w * side > 0 else w) for s, w in b.items()} for i, b in out.items()}
    return out


def _exit_decisions(d, broker, exits, metas, plugins, closed_returns, reader, plans, ideas, source, scope, days):
    """(key, reason) for each lot that should exit, decided at today's close."""
    out = []
    stop, tp = exits.get("stop"), exits.get("take_profit")
    review_on = exits.get("review", True)
    by_idea: dict[str, list] = {}
    for key, lot in sorted(broker.lots.items()):
        by_idea.setdefault(key[0], []).append(key)
        r = broker.lot_return(key)
        if r is None:
            continue
        if stop and r <= -abs(float(stop)):
            out.append((key, "stop"))
            continue
        level = None
        if tp == "p90":
            hist = closed_returns.get(key[0]) or []
            level = sorted(hist)[int(0.9 * (len(hist) - 1))] if len(hist) >= 20 else None
            level = level if level and level > 0 else None
        elif isinstance(tp, (int, float)) and tp > 0:
            level = float(tp)
        if level is not None and r >= level:
            out.append((key, "take_profit"))
            continue
        if exits.get("horizon") and lot.held_days >= int(metas[key[0]].get("horizon_days") or 10**9):
            out.append((key, "horizon"))
    taken = {k for k, _ in out}
    if review_on:
        for idea, keys in by_idea.items():
            plugin = plugins[idea]
            review = getattr(plugin, "review", None)
            if not review:
                continue
            held = [k[1] for k in keys if k not in taken]
            if not held:
                continue
            ctx = StrategyContext(d, reader, plugin.params, _universe_on(source, d, scope, days))
            try:
                verdicts = review(ctx, list(held)) or {}
            except Exception as exc:  # noqa: BLE001 - re-raised with the idea it came from
                exc.idea_id = idea
                raise
            if not isinstance(verdicts, dict):
                raise EvaluationError(f"review(ctx, held) returned {type(verdicts).__name__} on {d}; it must return a dict")
            for s in held:
                if s in verdicts and verdicts[s]:
                    out.append(((idea, s), "p_outperform" if verdicts[s] == "p_outperform" else "invalidation"))
    return out


def _open_trade(broker: PaperBroker, key, day: str) -> dict:
    lot = broker.lots[key]
    value = broker.value(key)
    pnl = value - lot.net_invested + lot.dividends - lot.commissions - lot.borrow
    return {"idea_id": lot.idea, "security_id": lot.security_id, "ticker": broker.tickers.get(lot.security_id),
            "side": "long" if lot.opened > 0 else "short", "entry_date": lot.entry_date, "exit_date": None,
            "entry_price": lot.entry_price, "exit_price": broker.close.get(lot.security_id), "pnl": pnl,
            "return": pnl / lot.entry_value if lot.entry_value else None, "dividends": lot.dividends,
            "costs": lot.commissions, "borrow": lot.borrow, "days_held": lot.sessions, "exit_reason": "open",
            **({"signal": lot.signal} if lot.signal else {})}


def _clean(d: dict) -> dict:
    return {k: (round(v, 8) if isinstance(v, float) and math.isfinite(v) else (None if isinstance(v, float) else v))
            for k, v in d.items()}


def ledger_hash(orders, trades, portfolio, positions) -> str:
    body = json.dumps({"orders": orders, "trades": trades, "portfolio": portfolio, "positions": positions},
                      sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(body.encode()).hexdigest()


def _group(trades: list[dict], key) -> list[dict]:
    groups: dict = {}
    for t in trades:
        groups.setdefault(key(t), []).append(t)
    out = []
    for k, ts in sorted(groups.items(), key=lambda kv: -abs(sum(t["pnl"] or 0 for t in kv[1]))):
        rets = [t["return"] for t in ts if t["return"] is not None]
        out.append({"key": k, "trades": len(ts), "pnl": round(sum(t["pnl"] or 0 for t in ts), 2),
                    "win_rate": round(sum(1 for r in rets if r > 0) / len(rets), 4) if rets else None,
                    "mean_return": round(statistics.fmean(rets), 6) if rets else None})
    return out


def _holding_bucket(days_held) -> str:
    if days_held is None:
        return "unknown"
    for limit, label in ((5, "≤ 1 week"), (21, "≤ 1 month"), (63, "≤ 3 months"), (126, "≤ 6 months"), (252, "≤ 1 year")):
        if days_held <= limit:
            return label
    return "> 1 year"


def _result(ideas, plans, metas, sim, costs, params, portfolio, trades, orders, positions, periods, readable_end,
            sector, rets):
    spx = [r["spx_return"] if isinstance(r.get("spx_return"), (int, float)) else 0.0 for r in portfolio]
    navs = [r["nav"] for r in portfolio]
    wins = [t["pnl"] for t in trades if (t["pnl"] or 0) > 0]
    losses = [t["pnl"] for t in trades if (t["pnl"] or 0) < 0]
    # Reconciliation: NAV = cash + long - short, and the change in NAV = price P&L + dividends - costs - borrow.
    nav_err = max((abs(r["nav"] - (r["cash"] + r["long_value"] - r["short_value"])) for r in portfolio), default=0.0)
    prev = float(sim["capital"])
    pnl_err = 0.0
    for r in portfolio:
        pnl_err = max(pnl_err, abs((r["nav"] - prev) - (r["price_pnl"] + r["dividends"] - r["costs"] - r["borrow"])))
        prev = r["nav"]
    rank_buckets: dict[str, list[float]] = {}
    for t in trades:
        sig = t.get("signal") or {}
        if sig.get("rank") and sig.get("of"):
            q = min(5, 1 + int(5 * (sig["rank"] - 1) / max(1, sig["of"])))
            rank_buckets.setdefault(f"Q{q}", []).append(t["return"] or 0.0)
    summary = metrics.summary(rets, periods)
    return {
        "simulator_version": SIMULATOR_VERSION,
        "evaluator_version": EVALUATOR_VERSION,
        "ideas": [{"id": i["id"], "ref": i.get("ref"), "plugin": {**(i.get("plugin_ref") or {}),
                   "hash": contract.code_hash(i["code"])}, "meta": metas[i["id"]],
                   "rebalances": len(plans[i["id"]]["rebalances"])} for i in ideas],
        "settings": {k: sim[k] for k in DEFAULTS},
        "costs": costs,
        "period": {"start": params.get("start"), "end": params.get("end"), "first_trade": portfolio[0]["date"] if portfolio else None,
                   "days": len(portfolio), "readable_end": readable_end},
        "summary": {**{k: (round(v, 8) if isinstance(v, float) and math.isfinite(v) else v) for k, v in summary.items()},
                    "sortino": metrics.sortino(rets, periods), "calmar": metrics.calmar(rets, periods),
                    "final_nav": round(navs[-1], 2) if navs else None, "capital": sim["capital"],
                    "spx_total_return": metrics.total_return(spx), "orders": len(orders),
                    "trades": len([t for t in trades if t["exit_reason"] != "open"]),
                    "open_at_end": len([t for t in trades if t["exit_reason"] == "open"]),
                    "win_rate": round(len(wins) / max(1, len(wins) + len(losses)), 4),
                    "avg_win": round(statistics.fmean(wins), 2) if wins else None,
                    "avg_loss": round(statistics.fmean(losses), 2) if losses else None,
                    "profit_factor": round(sum(wins) / -sum(losses), 4) if losses else None,
                    "costs_paid": round(sum(r["costs"] for r in portfolio), 2),
                    "dividends": round(sum(r["dividends"] for r in portfolio), 2),
                    "borrow_paid": round(sum(r["borrow"] for r in portfolio), 2),
                    "annual_turnover": round(sum(r["turnover"] for r in portfolio) / max(1, len(portfolio)) * periods, 4),
                    "avg_gross": round(statistics.fmean(r["gross"] or 0 for r in portfolio), 4) if portfolio else None},
        "excess": metrics.excess(rets, spx, periods),
        "reconciliation": {"max_nav_error": nav_err, "max_pnl_error": pnl_err},
        "series": {"dates": [r["date"] for r in portfolio], "series": {
            "nav": navs, "equity": _equity(rets),
            "spx_equity": _equity(spx), "returns": rets,
            "drawdown": [round(x, 8) for x in metrics.drawdown_series(rets)],
            "rolling_sharpe_126": [round(x, 6) if x is not None else None for x in metrics.rolling_sharpe(rets, 126, periods)],
            "gross": [r["gross"] for r in portfolio], "net": [r["net"] for r in portfolio],
            "long": [r["long_value"] / r["nav"] if r["nav"] else None for r in portfolio],
            "short": [-r["short_value"] / r["nav"] if r["nav"] else None for r in portfolio],
            "cash": [r["cash"] / r["nav"] if r["nav"] else None for r in portfolio]}},
        "monthly_returns": _monthly(portfolio),
        "attribution": {
            "by_idea": _group(trades, lambda t: t["idea_id"]),
            "by_sector": _group(trades, lambda t: sector.get(t["security_id"], "Unknown")),
            "by_side": _group(trades, lambda t: t["side"]),
            "by_exit_reason": _group(trades, lambda t: t["exit_reason"]),
            "by_holding_period": _group(trades, lambda t: _holding_bucket(t.get("days_held"))),
            # Calibration: realized trade returns by the signal's rank quintile at entry (Q1 = top ranked).
            "calibration": [{"key": k, "trades": len(v), "mean_return": round(statistics.fmean(v), 6),
                             "win_rate": round(sum(1 for r in v if r > 0) / len(v), 4)}
                            for k, v in sorted(rank_buckets.items())],
        },
        "counts": {"orders": len(orders), "trades": len(trades), "portfolio_days": len(portfolio),
                   "positions": len(positions)},
        "ledger_hash": ledger_hash(orders, trades, portfolio, positions),
    }


def _equity(returns) -> list:
    nav, out = 1.0, []
    for r in returns:
        nav *= 1 + r
        out.append(round(nav, 10))
    return out


def _monthly(portfolio: list[dict]) -> list[dict]:
    """Return per calendar month (for the heatmap)."""
    out, cur, start_nav, last_nav = [], None, None, None
    for r in portfolio:
        m = r["date"][:7]
        if m != cur:
            if cur is not None:
                out.append({"month": cur, "return": round(last_nav / start_nav - 1, 8)})
            cur, start_nav = m, (last_nav if last_nav is not None else r["nav"] / (1 + r["return"]))
        last_nav = r["nav"]
    if cur is not None:
        out.append({"month": cur, "return": round(last_nav / start_nav - 1, 8)})
    return out
