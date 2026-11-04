"""fundamentals_pit (#100): quarterly income, balance sheet and cash flow merged into point-in-time versions per
security, with restatements as versions (is_latest), known_at = acceptance time, as_of_date = the first session
after it, TTM aggregates as known then, and a balance-sheet identity check.

Run by the `fundamentals_pit` Transform: `compute(read)` yields (rows, issues) per security.
"""
from __future__ import annotations

from datetime import date, datetime

from ..core.pit import as_of_from_known_at
from .fundamentals_logic import balance_issue, ttm, versions
from ._resolve import security_symbols, ticker_resolver


def _sessions(read):
    rows = read("trading_calendar", None, ["date", "open_utc"], [("date", 1)])
    out = []
    for r in rows:
        d, o = r.get("date"), r.get("open_utc")
        if d is None or o is None:
            continue
        d = d.date() if isinstance(d, datetime) else date.fromisoformat(str(d)[:10])
        o = o if isinstance(o, datetime) else datetime.fromisoformat(str(o).replace("Z", "+00:00"))
        out.append((d, o))
    return out


def compute(read, *, security_ids=None):
    securities = read("securities", None, ["security_id", "identifiers"])
    resolve = ticker_resolver(securities)
    sec_syms = security_symbols(securities)
    if security_ids:
        sec_syms = {k: v for k, v in sec_syms.items() if k in set(security_ids)}
    sessions = _sessions(read)
    for sid in sorted(sec_syms):
        q = {"symbol": {"$in": sorted(sec_syms[sid])}}
        inc, bal, cf = (read(c, q) for c in ("income_statement", "balance_sheet", "cash_flow"))
        # A reused ticker: keep the statements whose period the ticker belonged to this security.
        inc, bal, cf = ([r for r in rows if resolve(r.get("symbol"), str(r.get("date"))[:10]) == sid] for rows in (inc, bal, cf))
        by_period = versions(inc, bal, cf)
        history = [v for vs in by_period.values() for v in vs]
        rows, issues = [], []
        for v in sorted(history, key=lambda x: (x["period_end"], x["version"])):
            known = datetime.fromisoformat(v["known_at"])
            as_of = as_of_from_known_at(known, sessions) if sessions else None
            row = {
                "security_id": sid,
                **v,
                **ttm(history, v["known_at"]),
                "as_of_date": as_of.isoformat() if as_of else None,
                "transform_name": "fundamentals_pit",
            }
            rows.append(row)
            kind = balance_issue(v)
            if kind and v["is_latest"]:
                issues.append({"issue_type": kind, "severity": "warn", "security_id": sid, "date": v["period_end"]})
        yield rows, issues
