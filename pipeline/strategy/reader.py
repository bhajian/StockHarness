"""The as_of-enforced reader behind `ctx.read_df` (#103).

Every read is cut at `as_of` with the collection's point-in-time rule from the catalog:

- Layer 2 rows: `as_of_date <= as_of` (rule `asOf`);
- Layer 1 rows: their known-at rule (#84), e.g. `insider_trades.filingDate`, statements' `acceptedDate` with the
  lag fallback, end-of-day prices on their own date;
- static collections (trading_calendar, securities): no cut;
- current-only and undocumented collections are refused.

Rows are loaded once per (collection, filter, columns) up to the evaluation end and then sliced per date, so a
weekly walk over years makes one query per distinct read. Plugins never get a database handle.
"""
from __future__ import annotations

import json
import re
from datetime import date, timedelta

from . import known_at

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}")
_BANNED_OPS = ("$where", "$function", "$accumulator")


class DataAccessError(PermissionError):
    """A read the point-in-time policy refuses (an unknown, current-only or out-of-range read)."""


def _minus_days(iso: str, n: int) -> str:
    return (date.fromisoformat(iso) - timedelta(days=n)).isoformat()


def _check_filter(flt) -> None:
    if isinstance(flt, dict):
        for k, v in flt.items():
            if k in _BANNED_OPS:
                raise DataAccessError(f"{k} is not allowed in a read filter")
            _check_filter(v)
    elif isinstance(flt, list):
        for v in flt:
            _check_filter(v)


def _future_dates(flt, as_of: str, op: str = "") -> bool:
    """Does the filter ask for dates after `as_of`? (a lookahead attempt; the cut returns nothing for them)"""
    if isinstance(flt, dict):
        return any(_future_dates(v, as_of, k) for k, v in flt.items())
    if isinstance(flt, list):
        return any(_future_dates(v, as_of, op) for v in flt)
    if not (isinstance(flt, str) and _DATE.match(flt)):
        return False
    return flt[:10] >= as_of if op == "$gt" else flt[:10] > as_of


class PitReader:
    def __init__(self, source, policies: dict[str, dict], *, end: str, start: str | None = None,
                 scope_ids: list[str] | None = None, scope_tickers: list[str] | None = None,
                 max_lookback_days: int = 800):
        self.source = source
        self.policies = policies
        self.end = end
        self.start = start
        self.scope_ids = list(scope_ids) if scope_ids else None
        self.scope_tickers = list(scope_tickers) if scope_tickers else None
        self.max_lookback_days = max_lookback_days
        self._cache: dict[str, tuple] = {}
        self.stats = {"reads": 0, "rows": 0, "lookahead_attempts": 0, "refused": 0}
        self.columns_seen: dict[str, list[str]] = {}  # collection -> columns its rows have (for clear errors)
        self.missing_columns: dict[str, list[str]] = {}  # collection -> requested columns no row has (#251)

    def policy(self, collection: str) -> dict:
        p = self.policies.get(collection)
        if p is None:
            raise DataAccessError(
                f"{collection} is not in the Schema Catalog, so its point-in-time rule is unknown; "
                f"readable collections: {', '.join(sorted(c for c, x in self.policies.items() if x.get('mode') != 'refuse'))}"
            )
        if p.get("mode") == "refuse":
            raise DataAccessError(f"{collection} cannot be read for historical dates: {p.get('reason', 'no point-in-time rule')}")
        return p

    def _scope_filter(self, collection: str) -> dict:
        if self.scope_ids and self.source.has_field(collection, "security_id"):
            return {"security_id": {"$in": self.scope_ids}}
        if self.scope_tickers and self.source.has_field(collection, "symbol"):
            return {"symbol": {"$in": self.scope_tickers}}
        return {}

    def _load(self, collection: str, flt: dict | None, columns: list[str] | None):
        import pandas as pd

        key = json.dumps([collection, flt, columns], sort_keys=True, default=str)
        if key in self._cache:
            return self._cache[key]
        p = self.policy(collection)
        rule = p.get("rule") if p.get("mode") == "pit" else None
        parts = [f for f in (flt or {}, self._scope_filter(collection)) if f]
        fields = None
        if columns:
            fields = list(dict.fromkeys([*columns, *(known_at.rule_fields(rule) if rule else [])]))
        if rule:
            parts.append(known_at.coarse_filter(rule, self.end))
            if rule["type"] == "asOf" and self.start:
                parts.append({rule["field"]: {"$gte": _minus_days(self.start, self.max_lookback_days)}})
        query = parts[0] if len(parts) == 1 else ({"$and": parts} if parts else {})
        rows = self.source.find(collection, query, fields)
        if rule:
            kept = []
            for r in rows:
                a = known_at.as_of_date(rule, r)
                if a is not None and a <= self.end:
                    r["as_of_date"] = a
                    kept.append(r)
            rows = sorted(kept, key=lambda r: r["as_of_date"])
        frame = pd.DataFrame(rows)
        if columns and rows:
            present = set().union(*(r.keys() for r in rows))
            missing = [c for c in columns if c not in present]
            if missing:
                known = sorted(set(self.source.sample_fields(collection)) | present)
                self.missing_columns[collection] = sorted(set(self.missing_columns.get(collection, [])) | set(missing))
                if not self.columns_seen.get(collection) or len(known) > len(self.columns_seen[collection]):
                    self.columns_seen[collection] = known
        if columns:
            want = list(dict.fromkeys([*columns, *(["as_of_date"] if rule else [])]))
            frame = frame.reindex(columns=want)
        as_ofs = frame["as_of_date"].to_numpy(dtype=str) if rule and len(frame) else None
        self._cache[key] = (frame, as_ofs, bool(rule))
        return self._cache[key]

    def read_df(self, collection: str, filter: dict | None = None, columns: list[str] | None = None, *,
                as_of: str, lookback_days: int | None = None):
        """Rows of `collection` known by `as_of` (and, with lookback_days, known within that many days)."""
        import numpy as np

        if as_of > self.end:
            self.stats["refused"] += 1
            raise DataAccessError(f"as_of {as_of} is after the readable end {self.end} (holdout or evaluation end)")
        _check_filter(filter)
        if filter and _future_dates(filter, as_of):
            self.stats["lookahead_attempts"] += 1
        frame, as_ofs, pit = self._load(collection, filter, columns)
        self.stats["reads"] += 1
        if collection not in self.columns_seen or len(frame.columns) > len(self.columns_seen[collection]):
            self.columns_seen[collection] = sorted(str(c) for c in frame.columns)
        if not pit or as_ofs is None:
            out = frame.copy()
        else:
            hi = int(np.searchsorted(as_ofs, as_of, side="right"))
            lo = int(np.searchsorted(as_ofs, _minus_days(as_of, lookback_days), side="left")) if lookback_days else 0
            out = frame.iloc[lo:hi].reset_index(drop=True)
        self.stats["rows"] += len(out)
        return out
