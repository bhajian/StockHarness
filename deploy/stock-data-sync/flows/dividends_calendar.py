# Dividends calendar (market-wide window). Daily. Upsert on (symbol, date).
def run():
    frm = (now_et() - dt.timedelta(days=pint("back", 7))).strftime("%Y-%m-%d")
    to = (now_et() + dt.timedelta(days=pint("ahead", 30))).strftime("%Y-%m-%d")
    rows = fmp_get("dividends-calendar", **{"from": frm, "to": to})
    ensure_index("dividends_calendar", ["symbol", "date"], unique=True)
    return {"rowsWritten": upsert("dividends_calendar", rows, ["symbol", "date"]), "window": [frm, to]}
