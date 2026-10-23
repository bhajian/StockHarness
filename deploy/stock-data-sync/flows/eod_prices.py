# EOD prices (OHLCV, adjusted) per symbol. Daily. Upsert on (symbol, date) so re-runs
# and overlapping windows never duplicate. params.limit caps symbols (0 = all).
def run():
    limit = pint("limit", 0)
    days = pint("days", 5)
    frm = (now_et() - dt.timedelta(days=days)).strftime("%Y-%m-%d")
    to = now_et().strftime("%Y-%m-%d")
    syms = universe_symbols(limit)
    ensure_index("eod_prices", ["symbol", "date"], unique=True)
    total = errors = 0
    for i, sym in enumerate(syms):
        try:
            rows = fmp_get("historical-price-eod/full", symbol=sym, **{"from": frm, "to": to})
            for r in rows:
                r["symbol"] = sym
            total += upsert("eod_prices", rows, ["symbol", "date"])
        except Exception as e:
            errors += 1
            if errors <= 5:
                log("  eod error", sym, e)
        if (i + 1) % 250 == 0:
            log(f"  eod progress {i + 1}/{len(syms)} written={total}")
    return {"symbols": len(syms), "rowsWritten": total, "errors": errors, "window": [frm, to]}
