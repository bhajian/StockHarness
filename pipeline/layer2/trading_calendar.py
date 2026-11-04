"""build_trading_calendar (spec §3.1): NYSE sessions 1990..next year.

Uses exchange_calendars (already in the executor image); falls back to pandas_market_calendars.
"""
from __future__ import annotations

from datetime import date

from ..core.runner import transform
from .calendar_logic import shape_calendar


def _sessions(start: date, end: date):
    try:
        import exchange_calendars as xcals

        # Explicit bounds: the default calendar only reaches about a year ahead (M2, #31).
        cal = xcals.get_calendar("XNYS", start=str(start), end=str(end))
        idx = cal.sessions  # the calendar is already bounded to [start, end]
        out = []
        for s in idx:
            out.append((s.date(), cal.session_open(s).to_pydatetime(), cal.session_close(s).to_pydatetime()))
        return out
    except Exception:
        import pandas_market_calendars as mcal

        sched = mcal.get_calendar("XNYS").schedule(start_date=str(start), end_date=str(end))
        return [
            (i.date(), r["market_open"].to_pydatetime(), r["market_close"].to_pydatetime())
            for i, r in sched.iterrows()
        ]


def compute(start=None, end=None):
    """NYSE sessions from 1990 (or `start`) through the end of next year (M2: re-run monthly so the calendar
    always reaches at least 11 months ahead)."""
    start = start or date(1990, 1, 1)
    end = end or date(date.today().year + 1, 12, 31)
    return shape_calendar(_sessions(start, end))


@transform("build_trading_calendar")
def build(ctx):
    from pymongo import ReplaceOne

    from ..core.db import coll

    rows = compute(ctx.start, ctx.end)
    ctx.rows_read = len(rows)
    c = coll("trading_calendar")
    c.create_index("date", unique=True)
    if rows:
        res = c.bulk_write([ReplaceOne({"date": r["date"]}, r, upsert=True) for r in rows], ordered=False)
        ctx.rows_written = (res.upserted_count or 0) + (res.modified_count or 0)
