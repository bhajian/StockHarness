# Analyst estimates (annual + quarterly snapshots) for the universe. Weekly.
def run():
    if not due_weekly():
        return {"skipped": "not weekly day"}
    # Annual only: quarterly analyst-estimates is not on the Premium plan; limit max is 10.
    syms = universe_symbols(pint("limit", 0))
    ensure_index("analyst_estimates", ["symbol", "date", "period"], unique=False)
    total = errors = 0
    for i, sym in enumerate(syms):
        try:
            data = fmp_get("analyst-estimates", symbol=sym, period="annual", limit=10)
            for r in data:
                r["symbol"] = sym
                r["period"] = "annual"
            total += upsert("analyst_estimates", data, ["symbol", "date", "period"])
        except Exception as e:
            errors += 1
            if errors <= 5:
                log("  estimate error", sym, e)
        if (i + 1) % 250 == 0:
            log(f"  analyst_estimates {i + 1}/{len(syms)} written={total}")
    return {"symbols": len(syms), "rowsWritten": total, "errors": errors}
