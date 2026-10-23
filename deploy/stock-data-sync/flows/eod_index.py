# Index / volatility levels: ^GSPC, ^VIX, ^DJI, ^IXIC EOD. Daily. Upsert on (symbol, date).
def run():
    syms = PARAMS.get("symbols") or ["^GSPC", "^VIX", "^DJI", "^IXIC"]
    days = pint("days", 5)
    frm = (now_et() - dt.timedelta(days=days)).strftime("%Y-%m-%d")
    to = now_et().strftime("%Y-%m-%d")
    ensure_index("eod_index", ["symbol", "date"], unique=True)
    total = errors = 0
    for sym in syms:
        try:
            rows = fmp_get("historical-price-eod/full", symbol=sym, **{"from": frm, "to": to})
            for r in rows:
                r["symbol"] = sym
            total += upsert("eod_index", rows, ["symbol", "date"])
        except Exception as e:
            errors += 1
            log("  index error", sym, e)
    return {"symbols": len(syms), "rowsWritten": total, "errors": errors}
