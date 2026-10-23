# Insider trades (latest feed, universe-wide). Daily. Paginated. Upsert on a composite key.
def run():
    pages = pint("pages", 3)
    per = pint("limit", 100) or 100
    keys = ["symbol", "filingDate", "transactionDate", "reportingCik", "transactionType", "price"]
    ensure_index("insider_trades", keys, unique=False)
    total = fetched = 0
    for p in range(pages):
        rows = fmp_get("insider-trading/latest", page=p, limit=per)
        if not rows:
            break
        fetched += len(rows)
        total += upsert("insider_trades", rows, keys)
    return {"rowsWritten": total, "fetched": fetched, "pages": pages}
