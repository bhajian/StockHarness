"""Event features for features_daily (#457). Pure, so it is unit-tested; each one is point in time by its source's rule.

- eps_surprise, revenue_surprise, days_since_earnings: the latest report (earnings_surprises), usable from the session
  after the report date (BMO / AMC timing isn't known). Surprise = (actual − estimate) / |estimate|, clipped to ±5.
- grade_net_90d: upgrades minus downgrades in the last 90 days (analyst_grades_history, by date).
- target_upside_90d: mean of price target ÷ price when posted − 1 over targets published in the last 90 days
  (price_target_changes, by publishedDate).
- insider_net_buy_90d: open-market purchases minus sales by insiders filed in the last 90 days (insider_trades, by
  filingDate), as a share of market cap.
- days_since_sp500_add, days_since_sp500_removal: days since the latest S&P 500 addition or removal (index_changes).
- shares_change_yoy: shares outstanding against a year earlier, as filed (buybacks below 0, dilution above).
"""
from __future__ import annotations

from bisect import bisect_right
from datetime import date, timedelta

WINDOW_DAYS = 90
CLIP = 5.0


def _iso(v) -> str:
    return str(v)[:10]


def _next_weekday(iso: str) -> str:
    d = date.fromisoformat(iso) + timedelta(days=1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d.isoformat()


def _surprise(actual, estimate):
    if not isinstance(actual, (int, float)) or not isinstance(estimate, (int, float)) or estimate == 0:
        return None
    return max(-CLIP, min(CLIP, (actual - estimate) / abs(estimate)))


def build(earnings=(), grades=(), targets=(), insiders=(), index_changes=(), tickers=()) -> dict:
    """Sorted, per-source event lists for one security (each entry starts with the date it became known)."""
    e = sorted((_next_weekday(_iso(r["date"])), _surprise(r.get("epsActual"), r.get("epsEstimated")),
                _surprise(r.get("revenueActual"), r.get("revenueEstimated")), _iso(r["date"]))
               for r in earnings if r.get("date") and r.get("epsActual") is not None)
    g = sorted((_iso(r["date"]), 1 if str(r.get("action")).lower() == "upgrade" else -1)
               for r in grades if r.get("date") and str(r.get("action")).lower() in ("upgrade", "downgrade"))
    t = sorted((_iso(r["publishedDate"]), r["priceTarget"] / r["priceWhenPosted"] - 1)
               for r in targets if r.get("publishedDate") and isinstance(r.get("priceTarget"), (int, float))
               and isinstance(r.get("priceWhenPosted"), (int, float)) and r["priceWhenPosted"] > 0)
    ins = []
    for r in insiders:
        kind = str(r.get("transactionType") or "")[:1]
        if kind not in ("P", "S") or not r.get("filingDate"):
            continue
        q, p = r.get("securitiesTransacted"), r.get("price")
        if isinstance(q, (int, float)) and isinstance(p, (int, float)) and q > 0 and p > 0:
            ins.append((_iso(r["filingDate"]), q * p if kind == "P" else -q * p))
    ins.sort()
    names = set(tickers)
    adds = sorted(_iso(r["date"]) for r in index_changes
                  if r.get("index") == "sp500" and r.get("date") and (r.get("addedTicker") or r.get("symbol")) in names)
    rems = sorted(_iso(r["date"]) for r in index_changes
                  if r.get("index") == "sp500" and r.get("date") and r.get("removedTicker") in names)
    return {"earnings": e, "grades": g, "targets": t, "insiders": ins, "adds": adds, "removals": rems,
            "_cum_grades": _cumsum([x[1] for x in g]), "_cum_ins": _cumsum([x[1] for x in ins]),
            "_e": [x[0] for x in e], "_g": [x[0] for x in g], "_t": [x[0] for x in t], "_i": [x[0] for x in ins]}


def _cumsum(xs):
    out, s = [0.0], 0.0
    for x in xs:
        s += x
        out.append(s)
    return out


def _window_sum(dates, cum, day: str, days: int) -> float:
    lo = bisect_right(dates, (date.fromisoformat(day) - timedelta(days=days)).isoformat())
    hi = bisect_right(dates, day)
    return cum[hi] - cum[lo]


def _days_since(dates: list[str], day: str):
    k = bisect_right(dates, day)
    return (date.fromisoformat(day) - date.fromisoformat(dates[k - 1])).days if k else None


def event_features(ev: dict, day: str, market_cap=None, shares_now=None, shares_year_ago=None) -> dict:
    out = {}
    known = bisect_right(ev["_e"], day)
    if known:
        _, eps, rev, report = ev["earnings"][known - 1]
        out.update(eps_surprise=eps, revenue_surprise=rev,
                   days_since_earnings=(date.fromisoformat(day) - date.fromisoformat(report)).days)
    else:
        out.update(eps_surprise=None, revenue_surprise=None, days_since_earnings=None)
    out["grade_net_90d"] = _window_sum(ev["_g"], ev["_cum_grades"], day, WINDOW_DAYS) if ev["grades"] else None
    ts = ev["targets"]
    if ts:
        dates = ev["_t"]
        lo = bisect_right(dates, (date.fromisoformat(day) - timedelta(days=WINDOW_DAYS)).isoformat())
        hi = bisect_right(dates, day)
        vals = [x[1] for x in ts[lo:hi]]
        out["target_upside_90d"] = sum(vals) / len(vals) if vals else None
    else:
        out["target_upside_90d"] = None
    if ev["insiders"] and isinstance(market_cap, (int, float)) and market_cap > 0:
        out["insider_net_buy_90d"] = _window_sum(ev["_i"], ev["_cum_ins"], day, WINDOW_DAYS) / market_cap
    else:
        out["insider_net_buy_90d"] = None
    out["days_since_sp500_add"] = _days_since(ev["adds"], day)
    out["days_since_sp500_removal"] = _days_since(ev["removals"], day)
    out["shares_change_yoy"] = (shares_now / shares_year_ago - 1
                                if isinstance(shares_now, (int, float)) and isinstance(shares_year_ago, (int, float))
                                and shares_year_ago > 0 else None)
    return out
