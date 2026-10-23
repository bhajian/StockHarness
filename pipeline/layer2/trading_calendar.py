"""build_trading_calendar (spec §3.1): NYSE sessions 1990..next year from pandas_market_calendars."""
from __future__ import annotations

from datetime import date

from ..core.runner import transform
from .calendar_logic import shape_calendar


@transform("build_trading_calendar")
def build(ctx):
    import pandas_market_calendars as mcal
    from pymongo import ReplaceOne

    from ..core.db import coll

    start = ctx.start or date(1990, 1, 1)
    end = ctx.end or date(date.today().year + 1, 12, 31)
    nyse = mcal.get_calendar("XNYS")
    sched = nyse.schedule(start_date=start.isoformat(), end_date=end.isoformat())
    sessions = [
        (idx.date(), row["market_open"].to_pydatetime(), row["market_close"].to_pydatetime())
        for idx, row in sched.iterrows()
    ]
    ctx.rows_read = len(sessions)
    rows = shape_calendar(sessions)
    c = coll("trading_calendar")
    c.create_index("date", unique=True)
    if rows:
        res = c.bulk_write([ReplaceOne({"date": r["date"]}, r, upsert=True) for r in rows], ordered=False)
        ctx.rows_written = (res.upserted_count or 0) + (res.modified_count or 0)
