"""`ctx`, the only thing a strategy plugin receives (#103)."""
from __future__ import annotations


class StrategyContext:
    """ctx.date (YYYY-MM-DD), ctx.params, ctx.read_df(...) cut at ctx.date, ctx.universe_ids on that date."""

    __slots__ = ("date", "params", "universe_ids", "_reader")

    def __init__(self, date: str, reader, params: dict | None = None, universe_ids: list[str] | None = None):
        self.date = date
        self.params = dict(params or {})
        self.universe_ids = list(universe_ids or [])
        self._reader = reader

    def read_df(self, collection: str, filter: dict | None = None, columns: list[str] | None = None,
                lookback_days: int | None = None):
        """A pandas DataFrame of the rows known by ctx.date (`as_of_date` column included for dated data).

        lookback_days limits the rows to those that became known in the last N calendar days.
        """
        return self._reader.read_df(collection, filter, columns, as_of=self.date, lookback_days=lookback_days)

    def __repr__(self):
        return f"StrategyContext(date={self.date!r})"
