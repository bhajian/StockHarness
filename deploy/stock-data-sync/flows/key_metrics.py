# Key metrics (annual; quarterly not on the Premium plan) for the universe. Weekly.
def run():
    if not due_weekly():
        return {"skipped": "not weekly day"}
    return per_symbol(
        "key_metrics", "key-metrics", ["symbol", "date"],
        extra={"period": "annual", "limit": 10}, cap=pint("limit", 0),
    )
