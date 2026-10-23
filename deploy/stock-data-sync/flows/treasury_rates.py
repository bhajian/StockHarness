# Treasury rates (market-wide). Daily. One call. Upsert on date.
def run():
    rows = fmp_get("treasury-rates")
    ensure_index("treasury_rates", ["date"], unique=True)
    return {"rowsWritten": upsert("treasury_rates", rows, ["date"])}
