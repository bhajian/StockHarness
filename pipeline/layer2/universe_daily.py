"""universe_daily (#101): the point-in-time tradeable universe per trading date.

For each security and priced date: close, 20-day median dollar volume, market cap as of that date (reported, else
close × shares outstanding as known from fundamentals_pit) and exchange as of that date; `in_universe` when every
filter passes. Delisted names are included while they were listed (they have prices only then). Thresholds come
from the Transform's params. Also `universe_counts`: members per date.

Run by the `universe_daily` Transform: `compute(read, window, params)` yields ("universe_daily", rows) per
security, then ("universe_counts", rows).
"""
from __future__ import annotations

from statistics import median

from ..core import pit
from ._resolve import as_date, security_symbols

DEFAULTS = {
    "min_price": 5.0,
    "min_adv_20d": 1_000_000.0,
    "min_market_cap": 300_000_000.0,
    "exchanges": ["NASDAQ", "NYSE", "AMEX", "NYSE American"],
    "adv_days": 20,
}


def _interval_value(history, day):
    for iv in sorted(history or [], key=lambda i: str(i.get("valid_from") or "")):
        vf, vt = str(iv.get("valid_from") or "")[:10] or None, str(iv.get("valid_to") or "")[:10] or None
        if (vf is None or vf <= day) and (vt is None or day < vt):
            return iv.get("value")
    return None


def evaluate(day, close, adv, market_cap, exchange, p):
    """Failing filters for one security on one day (empty = in the universe)."""
    fails = []  # a threshold of 0 (or less) turns that filter off
    if p["min_price"] > 0 and (close is None or close < p["min_price"]):
        fails.append("price")
    if p["min_adv_20d"] > 0 and (adv is None or adv < p["min_adv_20d"]):
        fails.append("liquidity")
    if p["min_market_cap"] > 0 and (market_cap is None or market_cap < p["min_market_cap"]):
        fails.append("market_cap")
    allowed = [e.upper() for e in p["exchanges"]]
    if allowed and not (exchange and any(a in exchange.upper() for a in allowed)):
        fails.append("exchange")
    return fails


def compute(read, window=None, params=None):
    p = {**DEFAULTS, **(params or {})}
    securities = read("securities", None, ["security_id", "identifiers", "exchange_history"])
    syms = security_symbols(securities)
    exch = {s["security_id"]: s.get("exchange_history") or [] for s in securities}
    start = window.start if window else None
    end = window.end if window else None
    lookback = window.lookback_start if window else None
    counts = {}
    for sid in sorted(syms):
        q = {"security_id": sid}
        if window:
            q["date"] = {"$gte": lookback, "$lte": end}
        prices = read("prices_daily", q, ["date", "close", "dollar_volume"], [("date", 1)])
        if not prices:
            continue
        caps = {}
        for r in read("historical_market_cap", {"symbol": {"$in": sorted(syms[sid])}}, ["date", "marketCap"]):
            if r.get("marketCap"):
                caps[str(r["date"])[:10]] = float(r["marketCap"])
        shares = sorted(
            (r["as_of_date"], r["version"], r.get("shares_basic"))
            for r in read("fundamentals_pit", {"security_id": sid}, ["as_of_date", "version", "shares_basic"])
            if r.get("as_of_date") and r.get("shares_basic")
        )
        rows = []
        dv = []
        si = 0
        known_shares = None
        for r in prices:
            day = r["date"]
            dv.append(r.get("dollar_volume"))
            dv = dv[-p["adv_days"] :]
            while si < len(shares) and shares[si][0] <= day:
                known_shares = shares[si][2]
                si += 1
            if window and day < start:
                continue  # lookback for the ADV only
            vals = [v for v in dv if v is not None]
            adv = median(vals) if len(vals) >= min(p["adv_days"], 5) else None
            close = r.get("close")
            if day in caps:
                cap, src = caps[day], "reported"
            elif known_shares and close:
                cap, src = close * known_shares, "estimated"
            else:
                cap, src = None, None
            exchange = _interval_value(exch.get(sid), day)
            fails = evaluate(day, close, adv, cap, exchange, p)
            rows.append(
                {
                    "security_id": sid,
                    "date": day,
                    "in_universe": not fails,
                    "fails": fails,
                    "close": close,
                    "adv_20d": adv,
                    "market_cap": cap,
                    "market_cap_source": src,
                    "exchange": exchange,
                    "known_at": pit.eod_known_at(as_date(day)).isoformat(),
                    "as_of_date": day,
                }
            )
            c = counts.setdefault(day, [0, 0])
            c[0] += 1
            c[1] += 0 if fails else 1
        yield "universe_daily", rows
    yield "universe_counts", [
        {"date": d, "priced": n, "members": m, "known_at": pit.eod_known_at(as_date(d)).isoformat(), "as_of_date": d}
        for d, (n, m) in sorted(counts.items())
    ]
