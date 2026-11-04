"""features_daily and features_ranked (#102), built only from point-in-time inputs.

features_daily: per security and trading day, price features from adjusted closes; valuation, quality and growth
from the fundamentals version known on that day (fundamentals_pit, as_of_date <= D) priced at that day's market
cap (universe_daily); days since the last filing. features_ranked: per date, over that date's universe members,
z-scores (clipped at ±3), percentiles and sector percentiles, plus value / quality / momentum / growth / low-vol
composites and a composite percentile. Every feature is in REGISTRY and documented in the catalog.
"""
from __future__ import annotations

import math
from datetime import date

from ..core import pit
from ._resolve import as_date

# name, group, unit, description, direction (+1 higher is better for composites, -1 lower is better, 0 n/a)
REGISTRY = [
    ("ret_1d", "price", "ratio", "1-day total split-adjusted price return", 0),
    ("mom_21d", "price", "ratio", "21-trading-day return of the adjusted close", 0),
    ("mom_63d", "price", "ratio", "63-trading-day return", 0),
    ("mom_126d", "price", "ratio", "126-trading-day return", 0),
    ("mom_252d", "price", "ratio", "252-trading-day return", 0),
    ("mom_12_1", "price", "ratio", "Return from 252 to 21 trading days ago (skips the last month)", 1),
    ("vol_21d", "price", "ratio", "Annualized volatility of daily returns over 21 days", 0),
    ("vol_63d", "price", "ratio", "Annualized volatility of daily returns over 63 days", -1),
    ("dist_52w_high", "price", "ratio", "Adjusted close / 252-day high − 1 (0 at a new high)", 0),
    ("adv_20d", "liquidity", "USD", "20-day median dollar volume (universe_daily)", 0),
    ("earnings_yield", "valuation", "ratio", "TTM net income / market cap", 1),
    ("sales_yield", "valuation", "ratio", "TTM revenue / market cap", 0),
    ("fcf_yield", "valuation", "ratio", "TTM free cash flow / market cap", 1),
    ("book_to_market", "valuation", "ratio", "Stockholders' equity / market cap", 1),
    ("roe", "quality", "ratio", "TTM net income / stockholders' equity", 1),
    ("gross_margin", "quality", "ratio", "TTM gross profit / TTM revenue", 1),
    ("operating_margin", "quality", "ratio", "TTM operating income / TTM revenue", 0),
    ("debt_to_equity", "quality", "ratio", "Total debt / stockholders' equity", -1),
    ("accruals", "quality", "ratio", "(TTM net income − TTM operating cash flow) / total assets", -1),
    ("revenue_growth_yoy", "growth", "ratio", "TTM revenue / TTM revenue a year earlier − 1, as known then", 1),
    ("earnings_growth_yoy", "growth", "ratio", "TTM net income growth versus a year earlier (on |prior|), as known then", 1),
    ("days_since_filing", "events", "days", "Days since the latest statement became usable (as_of_date)", 0),
]
FEATURES = [r[0] for r in REGISTRY]
COMPOSITES = {
    "value": [("earnings_yield", 1), ("fcf_yield", 1), ("book_to_market", 1)],
    "quality": [("roe", 1), ("gross_margin", 1), ("debt_to_equity", -1), ("accruals", -1)],
    "momentum": [("mom_12_1", 1)],
    "growth": [("revenue_growth_yoy", 1), ("earnings_growth_yoy", 1)],
    "low_vol": [("vol_63d", -1)],
}


def registry_docs(ranked=False):
    """Field docs for oh.describe: every feature, and for features_ranked its z / pct companions."""
    docs = {name: {"description": f"[{group}] {desc}", "unit": unit} for name, group, unit, desc, _ in REGISTRY}
    docs.update(
        {
            "sector": {"description": "GICS-style sector as of the date (securities.sector_history)"},
            "in_universe": {"description": "In universe_daily on this date"},
            "market_cap": {"description": "Market cap on this date (universe_daily)", "unit": "USD"},
        }
    )
    if not ranked:
        return docs
    out = {"sector": docs["sector"]}
    for name, group, unit, desc, _ in REGISTRY:
        out[f"{name}_z"] = {"description": f"Cross-sectional z-score of {name} (members on this date, clipped at ±3)"}
        out[f"{name}_pct"] = {"description": f"Percentile of {name} among members on this date (0..1)"}
    for c, parts in COMPOSITES.items():
        out[f"{c}_score"] = {"description": f"Mean percentile of {', '.join(('−' if s < 0 else '') + f for f, s in parts)}"}
        out[f"{c}_sector_pct"] = {"description": f"Percentile of {c}_score within the sector"}
    out["composite_pct"] = {"description": "Percentile of the mean of the composite scores (averages 0.5 per date)"}
    out["composite_sector_pct"] = {"description": "composite_pct within the sector"}
    return out


def _ratio(a, b):
    return None if a is None or b in (None, 0) else a / b


def _std(xs):
    if len(xs) < 2:
        return None
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def _interval(history, day):
    for iv in sorted(history or [], key=lambda i: str(i.get("valid_from") or "")):
        vf, vt = str(iv.get("valid_from") or "")[:10] or None, str(iv.get("valid_to") or "")[:10] or None
        if (vf is None or vf <= day) and (vt is None or day < vt):
            return iv.get("value")
    return None


def fundamentals_as_of(rows, day):
    """(current, year_ago) fundamentals as known on `day`: the latest version per period with as_of_date <= day."""
    known = {}
    for r in rows:
        if r.get("as_of_date") and r["as_of_date"] <= day:
            k = r["period_end"]
            if k not in known or r["version"] > known[k]["version"]:
                known[k] = r
    if not known:
        return None, None
    ends = sorted(known)
    cur = known[ends[-1]]
    target = date.fromisoformat(ends[-1])
    prior = [e for e in ends if 340 <= (target - date.fromisoformat(e)).days <= 390]
    return cur, (known[prior[-1]] if prior else None)


def price_features(closes, rets, i):
    """Price features at index i of a security's ascending adjusted-close / return series."""
    c = closes[i]
    back = lambda n: closes[i - n] if i - n >= 0 and closes[i - n] else None
    f = {"ret_1d": rets[i]}
    for n in (21, 63, 126, 252):
        f[f"mom_{n}d"] = _ratio(c, back(n)) - 1 if c is not None and back(n) else None
    f["mom_12_1"] = _ratio(back(21), back(252)) - 1 if back(21) and back(252) else None
    for n in (21, 63):
        window = [r for r in rets[max(0, i - n + 1) : i + 1] if r is not None]
        s = _std(window) if len(window) >= n * 0.8 else None
        f[f"vol_{n}d"] = s * math.sqrt(252) if s is not None else None
    hist = [x for x in closes[max(0, i - 251) : i + 1] if x is not None]
    f["dist_52w_high"] = c / max(hist) - 1 if c is not None and len(hist) >= 200 else None
    return f


def fundamental_features(cur, prior, cap, day):
    if not cur:
        return {k: None for k in ("earnings_yield", "sales_yield", "fcf_yield", "book_to_market", "roe", "gross_margin", "operating_margin", "debt_to_equity", "accruals", "revenue_growth_yoy", "earnings_growth_yoy", "days_since_filing")}
    eq = cur.get("stockholders_equity")
    f = {
        "earnings_yield": _ratio(cur.get("ttm_net_income"), cap),
        "sales_yield": _ratio(cur.get("ttm_revenue"), cap),
        "fcf_yield": _ratio(cur.get("ttm_free_cash_flow"), cap),
        "book_to_market": _ratio(eq, cap),
        "roe": _ratio(cur.get("ttm_net_income"), eq) if eq and eq > 0 else None,
        "gross_margin": _ratio(cur.get("ttm_gross_profit"), cur.get("ttm_revenue")),
        "operating_margin": _ratio(cur.get("ttm_operating_income"), cur.get("ttm_revenue")),
        "debt_to_equity": _ratio(cur.get("total_debt"), eq) if eq and eq > 0 else None,
        "accruals": (
            _ratio(cur["ttm_net_income"] - cur["ttm_operating_cash_flow"], cur.get("total_assets"))
            if cur.get("ttm_net_income") is not None and cur.get("ttm_operating_cash_flow") is not None
            else None
        ),
        "revenue_growth_yoy": None,
        "earnings_growth_yoy": None,
        "days_since_filing": (date.fromisoformat(day) - date.fromisoformat(cur["as_of_date"])).days,
    }
    if prior:
        r0, r1 = prior.get("ttm_revenue"), cur.get("ttm_revenue")
        f["revenue_growth_yoy"] = r1 / r0 - 1 if r0 and r1 is not None and r0 > 0 else None
        e0, e1 = prior.get("ttm_net_income"), cur.get("ttm_net_income")
        f["earnings_growth_yoy"] = (e1 - e0) / abs(e0) if e0 and e1 is not None else None
    return f


def compute_daily(read, window=None):
    """Yield features_daily rows per security. Every input is filtered to what was known on each day."""
    securities = read("securities", None, ["security_id", "sector_history"])
    start = window.start if window else None
    end = window.end if window else None
    lookback = window.lookback_start if window else None
    for s in sorted(securities, key=lambda x: x["security_id"]):
        sid = s["security_id"]
        q = {"security_id": sid}
        if window:
            q["date"] = {"$gte": lookback, "$lte": end}
        prices = read("prices_daily", q, ["date", "adj_close", "ret_1d"], [("date", 1)])
        if not prices:
            continue
        uq = {"security_id": sid}
        if window:
            uq["date"] = {"$gte": start, "$lte": end}
        uni = {r["date"]: r for r in read("universe_daily", uq, ["date", "in_universe", "market_cap", "adv_20d"])}
        fund = read("fundamentals_pit", {"security_id": sid}, None)
        closes = [p.get("adj_close") for p in prices]
        rets = [p.get("ret_1d") for p in prices]
        rows = []
        for i, p in enumerate(prices):
            day = p["date"]
            if window and day < start:
                continue  # lookback only
            u = uni.get(day, {})
            cur, prior = fundamentals_as_of(fund, day)
            rows.append(
                {
                    "security_id": sid,
                    "date": day,
                    "sector": _interval(s.get("sector_history"), day),
                    "in_universe": bool(u.get("in_universe")),
                    "market_cap": u.get("market_cap"),
                    "adv_20d": u.get("adv_20d"),
                    **price_features(closes, rets, i),
                    **fundamental_features(cur, prior, u.get("market_cap"), day),
                    "known_at": pit.eod_known_at(as_date(day)).isoformat(),
                    "as_of_date": day,
                }
            )
        yield rows


def _pct(values):
    """Percentile in (0, 1) per non-null value: (average rank − 0.5) / n, so the mean is exactly 0.5."""
    idx = sorted((v, i) for i, v in enumerate(values) if v is not None and not (isinstance(v, float) and math.isnan(v)))
    out = [None] * len(values)
    n = len(idx)
    j = 0
    while j < n:
        k = j
        while k + 1 < n and idx[k + 1][0] == idx[j][0]:
            k += 1
        p = ((j + k) / 2 + 0.5) / n
        for t in range(j, k + 1):
            out[idx[t][1]] = p
        j = k + 1
    return out


def rank_cross_section(rows):
    """features_ranked rows for one date's universe members."""
    members = [r for r in rows if r.get("in_universe")]
    out = [{"security_id": r["security_id"], "date": r["date"], "sector": r.get("sector")} for r in members]
    pct = {}
    for f in FEATURES:
        vals = [r.get(f) for r in members]
        nums = [v for v in vals if v is not None]
        m = sum(nums) / len(nums) if nums else None
        sd = _std(nums)
        pct[f] = _pct(vals)
        for o, v, p in zip(out, vals, pct[f]):
            o[f"{f}_z"] = max(-3.0, min(3.0, (v - m) / sd)) if v is not None and sd else None
            o[f"{f}_pct"] = p
    for c, parts in COMPOSITES.items():
        for i, o in enumerate(out):
            ps = [(pct[f][i] if s > 0 else 1 - pct[f][i]) for f, s in parts if pct[f][i] is not None]
            o[f"{c}_score"] = sum(ps) / len(ps) if ps else None
    raw = []
    for o in out:
        scores = [o[f"{c}_score"] for c in COMPOSITES if o[f"{c}_score"] is not None]
        raw.append(sum(scores) / len(scores) if scores else None)
    for o, p in zip(out, _pct(raw)):
        o["composite_pct"] = p
    # Within-sector percentiles of the composites.
    by_sector = {}
    for i, o in enumerate(out):
        by_sector.setdefault(o.get("sector"), []).append(i)
    for idxs in by_sector.values():
        for key in [f"{c}_score" for c in COMPOSITES] + ["composite_pct"]:
            name = key.replace("_score", "_sector_pct") if key.endswith("_score") else "composite_sector_pct"
            for i, p in zip(idxs, _pct([out[i][key] for i in idxs])):
                out[i][name] = p
    for o in out:
        o["known_at"] = pit.eod_known_at(as_date(o["date"])).isoformat()
        o["as_of_date"] = o["date"]
    return out


def compute_ranked(read, window=None):
    """Yield features_ranked rows per date in the window (or every date with features)."""
    if window:
        days = [r["date"] for r in read("universe_counts", {"date": {"$gte": window.start, "$lte": window.end}}, ["date"], [("date", 1)])]
    else:
        days = [r["date"] for r in read("universe_counts", None, ["date"], [("date", 1)])]
    for day in days:
        rows = read("features_daily", {"as_of_date": day}, None)
        yield rank_cross_section(rows)
