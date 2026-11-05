"""A small synthetic market in the Layer 2 shapes, for the evaluator tests and the sanity suite (#104, #107)."""
from __future__ import annotations

import random
from datetime import date, timedelta

from .sources import MemorySource

POLICIES = {
    "prices_daily": {"mode": "pit", "rule": {"type": "asOf", "field": "as_of_date"}},
    "features_daily": {"mode": "pit", "rule": {"type": "asOf", "field": "as_of_date"}},
    "universe_daily": {"mode": "pit", "rule": {"type": "asOf", "field": "as_of_date"}},
    "macro_daily": {"mode": "pit", "rule": {"type": "asOf", "field": "as_of_date"}},
    "securities": {"mode": "static"},
    "trading_calendar": {"mode": "static"},
}


def weekdays(start: str, n: int) -> list[str]:
    out, d = [], date.fromisoformat(start)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def market(n_sec: int = 40, n_days: int = 520, seed: int = 1, start: str = "2020-01-01", mu: float = 0.0003,
           sigma: float = 0.02, momentum: float = 0.0, overrides: dict | None = None,
           delist: dict | None = None) -> tuple[MemorySource, list[str]]:
    """prices_daily, universe_daily, securities, trading_calendar and macro_daily for `n_sec` securities.

    momentum > 0 makes each security's drift persist (a trend the 12-1 signal can find). overrides maps
    (security_id, date) -> a fixed return; delist maps security_id -> last date with a price (then inactive).
    """
    rnd = random.Random(seed)
    days = weekdays(start, n_days)
    ids = [f"SEC_{k:06d}" for k in range(n_sec)]
    drift = {s: rnd.gauss(0, 0.0008) * (momentum > 0) for s in ids}
    prices, uni, feats = [], [], []
    closes = {s: 100.0 for s in ids}
    delist = delist or {}
    overrides = overrides or {}
    for d in days:
        day_rets = []
        for s in ids:
            if s in delist and d > delist[s]:
                continue
            r = overrides.get((s, d), rnd.gauss(mu + drift[s] * momentum * 10, sigma))
            closes[s] *= 1 + r
            day_rets.append(r)
            prices.append({"security_id": s, "ticker": s.replace("SEC_", "T"), "date": d, "as_of_date": d,
                           "close": closes[s], "tr_1d": r, "ret_1d": r})
            uni.append({"security_id": s, "date": d, "as_of_date": d, "in_universe": True})
        feats.append({"date": d, "as_of_date": d, "spx_ret_1d": sum(day_rets) / max(1, len(day_rets))})
    securities = [{"security_id": s, "is_active": s not in delist,
                   "identifiers": [{"type": "ticker", "value": s.replace("SEC_", "T")}],
                   "sector_history": [{"value": "Tech" if k % 2 else "Energy", "valid_from": start, "valid_to": None}]}
                  for k, s in enumerate(ids)]
    calendar = [{"date": d, "is_trading_day": True} for d in days]
    src = MemorySource({"prices_daily": prices, "universe_daily": uni, "securities": securities,
                        "trading_calendar": calendar, "macro_daily": feats})
    return src, days
