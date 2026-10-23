# Event-driven financials for recent reporters (from earnings_calendar). Daily; lookback 7
# days doubles as the weekly statement catch-up. key-metrics/ratios are annual (quarterly
# is not on the Premium plan). Each endpoint upserts into its own collection.
def run():
    syms = recent_reporters(pint("lookbackDays", 7), cap=pint("limit", 0))
    specs = [
        ("income-statement", "fin_income", {"period": "quarter", "limit": 4}),
        ("balance-sheet-statement", "fin_balance", {"period": "quarter", "limit": 4}),
        ("cash-flow-statement", "fin_cashflow", {"period": "quarter", "limit": 4}),
        ("key-metrics", "fin_key_metrics", {"period": "annual", "limit": 5}),
        ("ratios", "fin_ratios", {"period": "annual", "limit": 5}),
        ("financial-growth", "fin_growth", {"period": "quarter", "limit": 4}),
    ]
    out = {}
    for path, coll, extra in specs:
        ensure_index(coll, ["symbol", "date"], unique=False)
        total = errors = 0
        for sym in syms:
            try:
                data = fmp_get(path, symbol=sym, **extra)
                for r in data:
                    r["symbol"] = sym
                total += upsert(coll, data, ["symbol", "date"])
            except Exception as e:
                errors += 1
                if errors <= 3:
                    log("  ", coll, "error", sym, e)
        out[coll] = {"written": total, "errors": errors}
    return {"reporters": len(syms), "results": out}
