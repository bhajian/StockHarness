"""Pure logic for fundamentals_pit (#100): merge quarterly statements into point-in-time versions, derive Q4,
compute TTM, check the balance-sheet identity. Stdlib only -> unit-tested."""
from __future__ import annotations

from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo

    ET = ZoneInfo("America/New_York")
except Exception:  # pragma: no cover
    ET = timezone.utc
UTC = timezone.utc

# camelCase statement field -> snake_case output field. Flow fields add up over quarters (TTM, Q4 derivation).
INCOME = {
    "revenue": "revenue", "costOfRevenue": "cost_of_revenue", "grossProfit": "gross_profit",
    "researchAndDevelopmentExpenses": "rd_expense", "sellingGeneralAndAdministrativeExpenses": "sga_expense",
    "operatingExpenses": "operating_expenses", "operatingIncome": "operating_income", "ebitda": "ebitda", "ebit": "ebit",
    "interestExpense": "interest_expense", "incomeBeforeTax": "pretax_income", "incomeTaxExpense": "income_tax",
    "netIncome": "net_income", "eps": "eps", "epsDiluted": "eps_diluted", "depreciationAndAmortization": "d_and_a",
    "weightedAverageShsOut": "shares_basic", "weightedAverageShsOutDil": "shares_diluted",
}
BALANCE = {
    "cashAndCashEquivalents": "cash", "cashAndShortTermInvestments": "cash_and_st_investments", "netReceivables": "receivables",
    "inventory": "inventory", "totalCurrentAssets": "current_assets", "propertyPlantEquipmentNet": "ppe_net",
    "goodwillAndIntangibleAssets": "goodwill_and_intangibles", "totalAssets": "total_assets", "accountPayables": "payables",
    "totalCurrentLiabilities": "current_liabilities", "shortTermDebt": "short_term_debt", "longTermDebt": "long_term_debt",
    "totalDebt": "total_debt", "netDebt": "net_debt", "totalLiabilities": "total_liabilities",
    "retainedEarnings": "retained_earnings", "totalStockholdersEquity": "stockholders_equity", "totalEquity": "total_equity",
}
CASHFLOW = {
    "operatingCashFlow": "operating_cash_flow", "capitalExpenditure": "capex", "freeCashFlow": "free_cash_flow",
    "commonDividendsPaid": "dividends_paid", "commonStockRepurchased": "buybacks", "stockBasedCompensation": "stock_based_comp",
    "acquisitionsNet": "acquisitions",
}
FLOW = {*INCOME.values(), *CASHFLOW.values()} - {"eps", "eps_diluted", "shares_basic", "shares_diluted"}
TTM_FIELDS = ("revenue", "gross_profit", "operating_income", "ebitda", "net_income", "operating_cash_flow", "free_cash_flow", "capex")
QUARTERS = ("Q1", "Q2", "Q3", "Q4")


def accepted_utc(accepted: str | None, fallback_date: str | None = None) -> str | None:
    """SEC acceptance times are US Eastern ('2017-02-01 16:33:29'); returned as ISO UTC. A date-only or missing
    value means end of that day (the filing date), so it is never treated as known earlier than it was."""
    s = (accepted or "").strip()
    try:
        if len(s) >= 19 and s[11:19] != "00:00:00":
            dt = datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=ET)
            return dt.astimezone(UTC).isoformat()
    except ValueError:
        pass
    day = s[:10] if len(s) >= 10 else (fallback_date or "")[:10]
    if not day:
        return None
    return datetime.strptime(day, "%Y-%m-%d").replace(hour=23, minute=59, tzinfo=ET).astimezone(UTC).isoformat()


def _num(v):
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


def _pick(row, mapping):
    return {out: _num(row.get(src)) for src, out in mapping.items()}


def versions(income, balance, cashflow):
    """Rows for ONE security: {(period_end, fiscal_period): [version dicts]} where each distinct acceptance time
    across the three statements makes a version holding the latest of each statement accepted by then."""
    by = {}
    for kind, rows in (("income", income), ("balance", balance), ("cashflow", cashflow)):
        for r in rows:
            k = (str(r.get("date"))[:10], r.get("period"))
            if not k[0] or k[1] not in QUARTERS:
                continue
            by.setdefault(k, {}).setdefault(kind, []).append(r)
    out = {}
    for k, kinds in by.items():
        for rows in kinds.values():
            rows.sort(key=lambda r: accepted_utc(r.get("acceptedDate"), r.get("filingDate")) or "")
        times = sorted({accepted_utc(r.get("acceptedDate"), r.get("filingDate")) for rows in kinds.values() for r in rows} - {None})
        vs = []
        for n, t in enumerate(times, 1):
            latest = {kind: [r for r in rows if (accepted_utc(r.get("acceptedDate"), r.get("filingDate")) or "") <= t] for kind, rows in kinds.items()}
            latest = {kind: rows[-1] for kind, rows in latest.items() if rows}
            any_row = next(iter(latest.values()))
            v = {
                "period_end": k[0],
                "fiscal_period": k[1],
                "fiscal_year": str(any_row.get("fiscalYear") or "")[:4] or None,
                "version": n,
                "is_latest": n == len(times),
                "known_at": t,
                "currency": any_row.get("reportedCurrency") or "USD",
                "filing_date": str(any_row.get("filingDate") or "")[:10] or None,
                "statements": sorted(latest),
                **(_pick(latest["income"], INCOME) if "income" in latest else {}),
                **(_pick(latest["balance"], BALANCE) if "balance" in latest else {}),
                **(_pick(latest["cashflow"], CASHFLOW) if "cashflow" in latest else {}),
            }
            v["is_usd"] = v["currency"] == "USD"
            vs.append(v)
        out[k] = vs
    return out


def derive_q4(quarters: dict, annual: dict) -> dict | None:
    """Q4 = FY − (Q1 + Q2 + Q3) for flow fields; stock (balance) fields come from FY. None if a quarter is missing."""
    if not all(q in quarters for q in ("Q1", "Q2", "Q3")):
        return None
    q4 = {}
    for f, v in annual.items():
        if f in FLOW:
            parts = [quarters[q].get(f) for q in ("Q1", "Q2", "Q3")]
            q4[f] = None if v is None or any(p is None for p in parts) else v - sum(parts)
        else:
            q4[f] = v
    q4["fiscal_period"] = "Q4"
    q4["derived_q4"] = True
    return q4


def ttm(history: list[dict], known_at: str) -> dict:
    """Trailing four quarters as known at `known_at`: `history` = every version of the security (any period).
    Uses the latest version of each of the last four consecutive quarters accepted by then; else nulls."""
    known = {}
    for v in history:
        if v["known_at"] and v["known_at"] <= known_at:
            k = v["period_end"]
            if k not in known or v["version"] > known[k]["version"]:
                known[k] = v
    ends = sorted(known)[-4:]
    ok = len(ends) == 4 and _consecutive(ends)
    return {f"ttm_{f}": (sum(known[e][f] for e in ends) if ok and all(known[e].get(f) is not None for e in ends) else None) for f in TTM_FIELDS}


def _consecutive(ends):
    """Four period ends roughly a quarter apart (70–110 days) with no gap."""
    ds = [datetime.strptime(e, "%Y-%m-%d") for e in ends]
    return all(70 <= (b - a).days <= 110 for a, b in zip(ds, ds[1:]))


def balance_issue(v: dict, tolerance=0.01):
    """total_assets ≈ total_liabilities + total_equity (within 1%), else a DQ issue type."""
    a, l, e = v.get("total_assets"), v.get("total_liabilities"), v.get("total_equity")
    if a is None or l is None or e is None or not a:
        return None
    return "balance_sheet_identity" if abs(a - (l + e)) / abs(a) > tolerance else None
