# Sector performance snapshot (market-wide). Daily. Upsert on (date, sector, exchange).
def run():
    date = now_et().strftime("%Y-%m-%d")
    rows = fmp_get("sector-performance-snapshot", date=date)
    ensure_index("sector_performance", ["date", "sector", "exchange"], unique=False)
    return {"rowsWritten": upsert("sector_performance", rows, ["date", "sector", "exchange"]), "date": date}
