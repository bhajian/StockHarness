# Full tradable symbol list. Weekly. Upsert on symbol.
def run():
    if not due_weekly():
        return {"skipped": "not weekly day"}
    rows = fmp_get("stock-list")
    ensure_index("stock_list", ["symbol"], unique=True)
    return {"rowsWritten": upsert("stock_list", rows, ["symbol"]), "count": len(rows)}
