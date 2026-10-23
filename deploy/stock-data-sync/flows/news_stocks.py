# Stock news (latest feed). Daily (optional). Paginated. Upsert on (symbol, publishedDate, title).
def run():
    pages = pint("pages", 3)
    per = pint("limit", 100) or 100
    keys = ["symbol", "publishedDate", "title"]
    ensure_index("news_stocks", keys, unique=False)
    total = fetched = 0
    for p in range(pages):
        rows = fmp_get("news/stock-latest", page=p, limit=per)
        if not rows:
            break
        fetched += len(rows)
        total += upsert("news_stocks", rows, keys)
    return {"rowsWritten": total, "fetched": fetched}
