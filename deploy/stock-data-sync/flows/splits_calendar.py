# Splits calendar (market-wide window). Daily. Upsert on (symbol, date).
def run():
    frm = (now_et() - dt.timedelta(days=pint("back", 7))).strftime("%Y-%m-%d")
    to = (now_et() + dt.timedelta(days=pint("ahead", 30))).strftime("%Y-%m-%d")
    rows = fmp_get("splits-calendar", **{"from": frm, "to": to})
    ensure_index("splits_calendar", ["symbol", "date"], unique=True)
    return {"rowsWritten": upsert("splits_calendar", rows, ["symbol", "date"]), "window": [frm, to]}
