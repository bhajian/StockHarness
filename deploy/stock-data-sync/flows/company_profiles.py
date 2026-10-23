# Company profiles for the universe. Weekly. One row per symbol.
def run():
    if not due_weekly():
        return {"skipped": "not weekly day"}
    return per_symbol("company_profiles", "profile", ["symbol"], cap=pint("limit", 0))
