# Financial scores (Altman Z, Piotroski, etc.) for the universe. Weekly. One row per symbol.
def run():
    if not due_weekly():
        return {"skipped": "not weekly day"}
    return per_symbol("financial_scores", "financial-scores", ["symbol"], cap=pint("limit", 0))
