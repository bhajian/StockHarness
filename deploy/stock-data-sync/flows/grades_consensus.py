# Analyst grades consensus snapshot for the universe. Weekly. One row per symbol.
def run():
    if not due_weekly():
        return {"skipped": "not weekly day"}
    return per_symbol("grades_consensus", "grades-consensus", ["symbol"], cap=pint("limit", 0))
