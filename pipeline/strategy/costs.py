"""Trading costs that depend on the name and the book's size (#452). Shared by the evaluator and the paper broker.

Every trade pays commission + slippage (the half-spread, `backtest.yaml`) plus market impact from a square-root model:
impact = coef × σ_daily × √(traded value ÷ 20-day median dollar volume), at an assumed book size (`impact.aum`). A
short pays borrow by market-cap tier. Where a name's ADV or market cap is unknown, it pays the flat rates only (the
behavior before #452). The record reports what impact cost and the book size the strategy can take (capacity).
"""
from __future__ import annotations

import math

DEFAULTS = {
    "aum": 10_000_000.0,  # the book size costs are computed at
    "coef": 1.0,  # Almgren et al. / Torre: about 1 for US equities
    "max_impact": 0.05,  # a single trade's impact is capped at 5% (beyond that the model says: don't)
    "max_participation": 0.1,  # capacity: the book size at which the median trade is 10% of ADV
    "vol_days": 21,
}
# Borrow by market cap (annual bps): general collateral for large caps, more for small ones.
BORROW_TIERS = [(10e9, 25.0), (2e9, 50.0), (300e6, 200.0), (0.0, 500.0)]


def settings(cfg: dict) -> dict:
    return {**DEFAULTS, **{k: float(v) for k, v in (cfg.get("impact") or {}).items()}}


def impact(trade_frac: float, nav: float, adv: float | None, vol: float | None, s: dict) -> tuple[float, float | None]:
    """(impact as a fraction of the traded value, participation) of trading `trade_frac` of a `nav` book."""
    if not adv or adv <= 0 or not vol or not math.isfinite(vol) or trade_frac <= 0:
        return 0.0, None
    participation = trade_frac * nav / adv
    return min(s["max_impact"], s["coef"] * vol * math.sqrt(participation)), participation


def borrow_bps(market_cap: float | None, default_bps: float) -> float:
    if not market_cap or market_cap <= 0:
        return default_bps
    for floor, bps in BORROW_TIERS:
        if market_cap >= floor:
            return bps
    return BORROW_TIERS[-1][1]


def vol_of(returns: list[float], days: int) -> float | None:
    xs = [r for r in returns[-days:] if isinstance(r, (int, float)) and math.isfinite(r)]
    if len(xs) < max(5, days // 2):
        return None
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def capacity(participations: list[float], aum: float, max_participation: float) -> dict:
    """The book size at which the median trade reaches max_participation of ADV (participation scales with size)."""
    ps = sorted(p for p in participations if p is not None and p > 0)
    if not ps:
        return {"trades": 0}
    med = ps[len(ps) // 2]
    return {"trades": len(ps), "aum": aum, "median_participation": med, "p95_participation": ps[int(len(ps) * 0.95)],
            "capacity_aum": aum * max_participation / med}


# #466: turnover controls. A held name stays in the book while it ranks within top_n × rank_buffer; after a risk exit
# (stop, invalidation) a simulation doesn't buy the name back for reentry_cooldown_days sessions.
TURNOVER = {"rank_buffer": 1.5, "reentry_cooldown_days": 10}


def turnover_settings(cfg: dict) -> dict:
    return {**TURNOVER, **{k: float(v) for k, v in (cfg.get("turnover") or {}).items()}}

