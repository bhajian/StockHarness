"""test_strategy (#153): a dry run of a plugin on a small sample, for the write -> test -> fix loop.

It runs the contract check and signal(ctx) through the same as_of reader as the evaluator, on about 20 symbols
and a few dates before the readable end, and returns either the error (type, message, the plugin's own line
numbers, and for a missing column the columns the collection really has) or a sanity summary: names scored per
date, NaN and non-numeric scores, unknown names, and warnings for an empty signal or a blocked lookahead attempt.
It never returns performance numbers, so fixing code cannot turn into tuning it to pass the gates.
"""
from __future__ import annotations

import math
from datetime import date, timedelta

from . import contract
from .context import StrategyContext
from .engine import _universe_on, resolve_scope, trading_days
from .reader import PitReader

SAMPLE_SYMBOLS = 20
OFFSETS_DAYS = (0, 30, 91, 182)  # sample dates: the readable end and about 1, 3 and 6 months before


def _sample_dates(source, end: str) -> list[str]:
    start = (date.fromisoformat(end) - timedelta(days=200)).isoformat()
    days = trading_days(source, start, end)
    out = []
    for off in OFFSETS_DAYS:
        target = (date.fromisoformat(end) - timedelta(days=off)).isoformat()
        prior = [d for d in days if d <= target]
        if prior and prior[-1] not in out:
            out.append(prior[-1])
    return sorted(out)


def _sample_scope(source, end: str, days: list[str]) -> list[str]:
    """The largest names in the universe on the last sample date (by market cap), else the first 20."""
    rows = source.find("universe_daily", {"date": end, "in_universe": True}, ["security_id", "market_cap"])
    rows.sort(key=lambda r: (-(r.get("market_cap") or 0), r["security_id"]))
    ids = [r["security_id"] for r in rows[:SAMPLE_SYMBOLS]]
    return ids or _universe_on(source, end, None, days)[:SAMPLE_SYMBOLS]


def test_plugin(code: str, *, source, policies: dict, params: dict | None = None,
                readable_end: str | None = None) -> dict:
    params = params or {}
    end = params.get("end") or readable_end
    if not end:
        raise ValueError("test_strategy needs an end date (the readable end)")
    if readable_end and end > readable_end:
        end = readable_end
    plugin = contract.load(code)  # contract problems surface as PluginError with lines
    dates = params.get("dates") or _sample_dates(source, end)
    dates = [d for d in dates if d <= end][:6]
    if not dates:
        raise ValueError(f"no trading days on or before {end}")
    scope, tickers = resolve_scope(source, params.get("symbols"))
    if not scope:
        scope = _sample_scope(source, dates[-1], trading_days(source, dates[0], dates[-1]))
    reader = PitReader(source, policies, end=end, start=dates[0], scope_ids=scope, scope_tickers=tickers)
    plugin_params = {**plugin.params, **(params.get("plugin_params") or {})}
    per_date, warnings = [], []
    for d in dates:
        days = trading_days(source, (date.fromisoformat(d) - timedelta(days=10)).isoformat(), d)
        uni = _universe_on(source, d, scope, days) if d in days else list(scope)
        ctx = StrategyContext(d, reader, plugin_params, uni)
        try:
            scores = plugin.signal(ctx)
        except (KeyError, AttributeError) as exc:  # most often a column name: show what the collections have
            exc.columns_seen = reader.columns_seen  # type: ignore[attr-defined]
            raise
        if not isinstance(scores, dict):
            raise TypeError(f"signal(ctx) returned {type(scores).__name__} on {d}; it must return a dict of score per security_id")
        values = list(scores.values())
        numeric = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
        finite = [v for v in numeric if math.isfinite(v)]
        unknown = [k for k in scores if k not in set(uni)]
        per_date.append({"date": d, "eligible": len(uni), "scored": len(scores), "usable": len(finite),
                         "nan": len(numeric) - len(finite), "non_numeric": len(values) - len(numeric),
                         "not_in_universe": len(unknown), "distinct_scores": len(set(finite))})
    if all(p["usable"] == 0 for p in per_date):
        warnings.append({"code": "empty_signal", "hint": "no usable scores on any sample date: check the collection, "
                         "column names, the date field you filter on, and NaNs (describe_collection lists the fields)"})
    elif any(p["usable"] == 0 for p in per_date):
        warnings.append({"code": "empty_on_some_dates", "dates": [p["date"] for p in per_date if not p["usable"]]})
    if any(p["nan"] for p in per_date):
        warnings.append({"code": "nan_scores", "count": sum(p["nan"] for p in per_date)})
    if any(p["not_in_universe"] for p in per_date):
        warnings.append({"code": "unknown_names", "hint": "scores must be keyed by security_id of names in ctx.universe_ids"})
    if any(p["usable"] and p["distinct_scores"] == 1 for p in per_date):
        warnings.append({"code": "constant_scores", "hint": "every name gets the same score, so ranking is arbitrary"})
    if reader.stats["lookahead_attempts"]:
        warnings.append({"code": "lookahead_blocked", "count": reader.stats["lookahead_attempts"],
                         "hint": "a read asked for dates after ctx.date; it returned nothing. Use data known by ctx.date"})
    ok = not any(w["code"] in ("empty_signal", "lookahead_blocked", "unknown_names") for w in warnings)
    return {"ok": ok, "dates": per_date, "warnings": warnings, "symbols": len(scope), "meta": plugin.META,
            "reads": {"count": reader.stats["reads"], "rows": reader.stats["rows"]},
            "columns_seen": reader.columns_seen}
