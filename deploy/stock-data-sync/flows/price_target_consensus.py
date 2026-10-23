# Price-target consensus snapshot for the universe. Weekly. One row per symbol.
def run():
    if not due_weekly():
        return {"skipped": "not weekly day"}
    return per_symbol("price_target_consensus", "price-target-consensus", ["symbol"], cap=pint("limit", 0))
