# Delisted companies. Weekly. Paginated. Upsert on (symbol, delistedDate).
def run():
    if not due_weekly():
        return {"skipped": "not weekly day"}
    keys = ["symbol", "delistedDate"]
    ensure_index("delisted_companies", keys, unique=False)
    total = 0
    for p in range(pint("pages", 100)):
        rows = fmp_get("delisted-companies", page=p, limit=100)
        if not rows:
            break
        total += upsert("delisted_companies", rows, keys)
    return {"rowsWritten": total}
