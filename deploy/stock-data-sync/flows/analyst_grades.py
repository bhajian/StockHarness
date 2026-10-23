# Analyst grade changes (latest news feed, universe-wide). Daily. Paginated.
def run():
    pages = pint("pages", 5)
    per = pint("limit", 100) or 100
    keys = ["symbol", "publishedDate", "newsURL"]
    ensure_index("analyst_grades", keys, unique=False)
    total = fetched = 0
    for p in range(pages):
        rows = fmp_get("grades-latest-news", page=p, limit=per)
        if not rows:
            break
        fetched += len(rows)
        total += upsert("analyst_grades", rows, keys)
    return {"rowsWritten": total, "fetched": fetched}
