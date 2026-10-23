# Congress trades: Senate + House latest disclosures. Daily. Paginated into two collections.
def run():
    keys = ["symbol", "disclosureDate", "transactionDate", "firstName", "lastName", "amount"]
    out = {}
    for endpoint, coll in (("senate-latest", "congress_senate"), ("house-latest", "congress_house")):
        ensure_index(coll, keys, unique=False)
        total = 0
        for p in range(pint("pages", 3)):
            rows = fmp_get(endpoint, page=p, limit=100)
            if not rows:
                break
            total += upsert(coll, rows, keys)
        out[coll] = total
    return {"written": out}
