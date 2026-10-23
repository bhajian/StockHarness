# Earnings calendar: last 3 days + next 14. Daily. The endpoint caps at 4000 rows and drops
# the earliest dates on a wide window, so fetch past and future separately. Upsert (symbol, date).
def run():
    today = now_et()
    past_from = (today - dt.timedelta(days=3)).strftime("%Y-%m-%d")
    today_s = today.strftime("%Y-%m-%d")
    fut_to = (today + dt.timedelta(days=14)).strftime("%Y-%m-%d")
    ensure_index("earnings_calendar", ["symbol", "date"], unique=True)
    total = 0
    for frm, to in ((past_from, today_s), (today_s, fut_to)):
        rows = fmp_get("earnings-calendar", **{"from": frm, "to": to})
        total += upsert("earnings_calendar", rows, ["symbol", "date"])
    return {"rowsWritten": total, "window": [past_from, fut_to]}
