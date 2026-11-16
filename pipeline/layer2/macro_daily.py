"""macro_daily (spec §3.15): treasury curve, VIX, index levels and sector returns per date.

Run by the `macro_daily` Transform (#99): `compute(read)` rebuilds every date (a few thousand rows) from the full
history of its inputs. A day without a treasury print (a bond-market holiday) takes the latest earlier print up to
TREASURY_CARRY_DAYS back, never a later one. Sector returns use one exchange's series per day (#388): NASDAQ, the
one both the daily snapshot and the historical endpoint serve, else the first exchange by name.

#445: the benchmark is total return. FMP doesn't serve ^SP500TR, so spx_tr_1d is SPY's close plus the dividend on
its ex-date over the previous close (SPY never split; its 0.09% fee makes it a slightly conservative benchmark).
rf_1d is the 3-month T-bill (annual %, as known that day) as a daily rate, for Sharpe and alpha over cash.
"""
from __future__ import annotations

from bisect import bisect_right

from ..core import pit
from ._resolve import as_date

TV = "4"  # 4: spx_tr_1d (SPY close + dividends) and rf_1d (3-month T-bill per trading day), #445
TREASURY_CARRY_DAYS = 5
SECTOR_EXCHANGE = "NASDAQ"


def compute(read):
    tr = {str(r["date"])[:10]: r for r in read("treasury_rates") if r.get("date")}
    idx = {}
    for r in read("eod_index", None, ["symbol", "date", "close"]):
        if r.get("symbol") and r.get("date"):
            idx.setdefault(r["symbol"], {})[str(r["date"])[:10]] = r.get("close")
    by_exchange = {}
    for r in read("sector_performance"):
        if r.get("date") and r.get("sector") and r.get("averageChange") is not None:
            by_exchange.setdefault(str(r["date"])[:10], {}).setdefault(r.get("exchange") or "", {})[r["sector"]] = r["averageChange"]
    sectors = {
        d: ex[SECTOR_EXCHANGE] if SECTOR_EXCHANGE in ex else ex[sorted(ex)[0]] for d, ex in by_exchange.items()
    }
    spx, vix, ndx = idx.get("^GSPC", {}), idx.get("^VIX", {}), idx.get("^IXIC", {})
    spy = idx.get("SPY", {})
    spy_div = {}
    try:
        for r in read("benchmark_dividends", {"symbol": "SPY"}, ["symbol", "date", "dividend"]):
            if r.get("date") and r.get("dividend"):
                spy_div[str(r["date"])[:10]] = float(r["dividend"])
    except Exception:  # noqa: BLE001 - not synced yet: spx_tr_1d stays empty, the evaluator falls back
        pass
    prev_spy = None
    tr_dates = sorted(tr)
    rows = []
    prev_spx = None
    for d in sorted(set(tr) | set(spx) | set(vix) | set(sectors) | set(spy)):
        t = tr.get(d) or _nearest_prior(tr, tr_dates, d, TREASURY_CARRY_DAYS)
        s = spx.get(d)
        y10, y2, m3 = _g(t, "year10"), _g(t, "year2"), _g(t, "month3")
        rows.append(
            {
                "date": d,
                "ust_3m": m3,
                "ust_2y": y2,
                "ust_10y": y10,
                "ust_30y": _g(t, "year30"),
                "curve_10y_2y": _sub(y10, y2),
                "curve_10y_3m": _sub(y10, m3),
                "vix": vix.get(d),
                "spx_close": s,
                "ndx_close": ndx.get(d),
                "spx_ret_1d": (s / prev_spx - 1.0) if (s is not None and prev_spx) else None,
                "spy_close": spy.get(d),
                "spx_tr_1d": ((spy[d] + spy_div.get(d, 0.0)) / prev_spy - 1.0) if (spy.get(d) and prev_spy) else None,
                "rf_1d": (1.0 + m3 / 100.0) ** (1.0 / 252) - 1.0 if isinstance(m3, (int, float)) else None,
                "sector_returns": sectors.get(d, {}),
                "known_at": pit.eod_known_at(as_date(d)).isoformat(),
                "as_of_date": d,
                "transform_name": "macro_daily",
                "transform_version": TV,
            }
        )
        if s is not None:
            prev_spx = s
        if spy.get(d):
            prev_spy = spy[d]
    return rows


def _g(row, key):
    return row.get(key) if row else None


def _sub(a, b):
    return None if a is None or b is None else a - b


def _nearest_prior(tr, tr_dates, d, max_days):
    """The latest treasury row on or before `d`, if it is at most `max_days` old (sorted dates, binary search)."""
    i = bisect_right(tr_dates, d)
    if i == 0:
        return None
    best = tr_dates[i - 1]
    if (as_date(d) - as_date(best)).days > max_days:
        return None
    return tr[best]
