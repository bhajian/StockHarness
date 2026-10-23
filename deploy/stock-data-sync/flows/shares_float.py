# Shares float for the universe. Weekly. shares-float-all is paginated (1000/page); page
# through it and keep the universe rows. Upsert on symbol.
def run():
    if not due_weekly():
        return {"skipped": "not weekly day"}
    uni = set(universe_symbols())
    ensure_index("shares_float", ["symbol"], unique=True)
    total = matched = page = 0
    while True:
        rows = fmp_get("shares-float-all", page=page)
        if not rows:
            break
        keep = [r for r in rows if r.get("symbol") in uni] if uni else rows
        matched += len(keep)
        total += upsert("shares_float", keep, ["symbol"])
        page += 1
        if len(rows) < 1000 or page > 100:
            break
    return {"rowsWritten": total, "universeMatched": matched, "pages": page}
