# Universe: US common stock on major exchanges above a market-cap floor (~2,000 names).
# Per-symbol flows read this `universe` collection. Cheap (one screener call); runs daily.
def run():
    mcap = int(PARAMS.get("marketCapMoreThan", 2_000_000_000))
    rows = fmp_get(
        "company-screener",
        exchange="NASDAQ,NYSE,AMEX",
        isEtf="false",
        isFund="false",
        isActivelyTrading="true",
        marketCapMoreThan=mcap,
        limit=5000,
    )
    syms = [
        {
            "symbol": r["symbol"],
            "companyName": r.get("companyName"),
            "marketCap": r.get("marketCap"),
            "exchange": r.get("exchangeShortName"),
            "sector": r.get("sector"),
            "industry": r.get("industry"),
        }
        for r in rows
        if r.get("symbol")
    ]
    ensure_index("universe", ["symbol"], unique=True)
    n = upsert("universe", syms, ["symbol"])
    return {"universe": len(syms), "written": n}
