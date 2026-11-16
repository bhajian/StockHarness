"""Macro regime columns for macro_daily (#456). Pure, so it is unit-tested; point in time on every row.

Market regime from the rows themselves (each uses only rows on or before its date):
- spx_above_200d, spx_ret_63d, spx_drawdown_252d: the S&P 500 against its 200-day average, its 63-session return and
  its distance from the 252-session high. The evaluator's by_regime uses the same 200-day rule.
- vix_pct_252d: where today's VIX sits in the last 252 sessions (0..1); vix_high: VIX ≥ 25 (by_regime's rule).
- curve_inverted: the 10-year below the 2-year; ust_10y_chg_63d: the 10-year's change over 63 sessions (points).
- regime: bull/bear (S&P vs 200-day) × calm/volatile (VIX < / ≥ 25).

Economy from economic_indicators, each value known RELEASE_LAG_DAYS after its period date (the catalog's rule):
- cpi_yoy and cpi_yoy_chg_3m, unemployment and sahm_gap (the 3-month average minus the lowest 3-month average of the
  prior 12 months; 0.5 points is the Sahm recession signal), recession_prob, fed_funds.
"""
from __future__ import annotations

from bisect import bisect_right
from datetime import date, timedelta

RELEASE_LAG_DAYS = 45
VIX_HIGH = 25.0


def _known(iso: str) -> str:
    return (date.fromisoformat(iso[:10]) + timedelta(days=RELEASE_LAG_DAYS)).isoformat()


def econ_series(rows) -> dict[str, list[tuple[str, str, float]]]:
    """name -> [(known date, period date, value)] sorted by known date."""
    out: dict[str, list] = {}
    for r in rows:
        if r.get("name") and r.get("date") and isinstance(r.get("value"), (int, float)):
            p = str(r["date"])[:10]
            out.setdefault(r["name"], []).append((_known(p), p, float(r["value"])))
    for v in out.values():
        v.sort()
    return out


def _as_of(series, d: str):
    """The (period, value) entries known on d, in period order."""
    if not series:
        return []
    k = bisect_right([x[0] for x in series], d)
    return sorted((p, v) for _, p, v in series[:k])


def _month(p: str) -> str:
    return p[:7]


def _months_back(p: str, n: int) -> str:
    y, m = int(p[:4]), int(p[5:7])
    m -= n
    while m <= 0:
        m += 12
        y -= 1
    return f"{y:04d}-{m:02d}"


def _yoy(known: list[tuple[str, float]], back: int = 0):
    """Year-over-year change of the latest known month (or `back` months before it)."""
    if len(known) <= back:
        return None
    by = {_month(p): v for p, v in known}
    last = _month(known[-1 - back][0])
    prev = by.get(_months_back(last + "-01", 12))
    cur = by.get(last)
    return cur / prev - 1 if cur and prev else None


def _sahm(known: list[tuple[str, float]]):
    vals = [v for _, v in known]
    if len(vals) < 15:
        return None
    avgs = [sum(vals[i - 2:i + 1]) / 3 for i in range(2, len(vals))]
    return avgs[-1] - min(avgs[-13:-1])


def add_regimes(rows: list[dict], econ: dict[str, list] | None = None) -> list[dict]:
    econ = econ or {}
    spx, vix, y10 = [], [], []
    for r in rows:  # rows are in date order
        d = r["date"]
        s, v, t = r.get("spx_close"), r.get("vix"), r.get("ust_10y")
        if isinstance(s, (int, float)):
            spx.append(s)
        if isinstance(v, (int, float)):
            vix.append(v)
        if isinstance(t, (int, float)):
            y10.append(t)
        cur_s = s if isinstance(s, (int, float)) else None
        above = (cur_s >= sum(spx[-200:]) / 200) if cur_s is not None and len(spx) >= 200 else None
        r["spx_above_200d"] = above
        r["spx_ret_63d"] = (spx[-1] / spx[-64] - 1) if cur_s is not None and len(spx) >= 64 else None
        r["spx_drawdown_252d"] = (spx[-1] / max(spx[-252:]) - 1) if cur_s is not None and spx else None
        cur_v = v if isinstance(v, (int, float)) else None
        r["vix_pct_252d"] = (sum(1 for x in vix[-252:] if x <= cur_v) / len(vix[-252:])) if cur_v is not None else None
        r["vix_high"] = (cur_v >= VIX_HIGH) if cur_v is not None else None
        c = r.get("curve_10y_2y")
        r["curve_inverted"] = (c < 0) if isinstance(c, (int, float)) else None
        r["ust_10y_chg_63d"] = (y10[-1] - y10[-64]) if isinstance(t, (int, float)) and len(y10) >= 64 else None
        r["regime"] = (f"{'bull' if above else 'bear'}_{'volatile' if r['vix_high'] else 'calm'}"
                       if above is not None and r["vix_high"] is not None else None)
        cpi = _as_of(econ.get("CPI"), d)
        now, before = _yoy(cpi), _yoy(cpi, 3)
        r["cpi_yoy"] = now
        r["cpi_yoy_chg_3m"] = (now - before) if now is not None and before is not None else None
        un = _as_of(econ.get("unemploymentRate"), d)
        r["unemployment"] = un[-1][1] if un else None
        r["sahm_gap"] = _sahm(un)
        rp = _as_of(econ.get("smoothedUSRecessionProbabilities"), d)
        r["recession_prob"] = rp[-1][1] if rp else None
        ff = _as_of(econ.get("federalFunds"), d)
        r["fed_funds"] = ff[-1][1] if ff else None
    return rows
