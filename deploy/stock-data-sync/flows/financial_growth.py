# Financial growth (quarterly) for the universe. Weekly. Upsert on (symbol, date, period).
def run():
    if not due_weekly():
        return {"skipped": "not weekly day"}
    return per_symbol(
        "financial_growth", "financial-growth", ["symbol", "date", "period"],
        extra={"period": "quarter", "limit": 8}, cap=pint("limit", 0),
    )
