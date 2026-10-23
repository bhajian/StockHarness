# Earnings surprises for recent reporters. Daily. Reporters come from a direct past-window
# earnings-calendar call; per reporter we pull the earnings history (actual vs estimate).
def run():
    syms = recent_reporters(pint("lookbackDays", 3), cap=pint("limit", 0))
    ensure_index("earnings_surprises", ["symbol", "date"], unique=True)
    total = errors = 0
    for sym in syms:
        try:
            data = fmp_get("earnings", symbol=sym)
            for r in data:
                r["symbol"] = sym
            total += upsert("earnings_surprises", data, ["symbol", "date"])
        except Exception as e:
            errors += 1
            if errors <= 5:
                log("  surprise error", sym, e)
    return {"reporters": len(syms), "rowsWritten": total, "errors": errors}
