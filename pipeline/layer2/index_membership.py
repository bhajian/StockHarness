"""index_membership (#388): point-in-time S&P 500, Nasdaq-100 and Dow membership intervals per security.

Run by the `index_membership` Transform: `compute(read, params)` reads `index_constituents` (current lists),
`index_changes` (FMP's change history) and `securities`, and returns (rows, issues). One row per membership
interval [valid_from, valid_to); `universe_daily` turns them into in_sp500 / in_ndx / in_dji per day.
"""
from __future__ import annotations

from datetime import date

from ..core import pit
from ._resolve import as_date
from .index_membership_logic import INDEXES, build_intervals, strict_resolver

TV = "1"
DEFAULTS = {"history_from": "2016-01-01"}


def compute(read, params=None, today=None):
    p = {**DEFAULTS, **(params or {})}
    today = today or date.today().isoformat()
    resolve = strict_resolver(read("securities", None, ["security_id", "identifiers"]))
    current, changes = {}, {}
    for r in read("index_constituents"):
        current.setdefault(r.get("index"), []).append(r)
    for r in read("index_changes"):
        changes.setdefault(r.get("index"), []).append(r)
    rows, issues = [], []
    for index in INDEXES:
        if not current.get(index):
            continue  # no current list: nothing to anchor the history on
        hist = changes.get(index, [])
        start = min((str(c["date"])[:10] for c in hist if c.get("date")), default=today)
        ivs, found = build_intervals(index, current[index], hist, today, resolve, p["history_from"])
        for iv in ivs:
            vf = iv["valid_from"] or start
            rows.append(
                {
                    "membership_id": f"{index}:{iv['key']}:{iv['valid_from'] or 'start'}",
                    "index": index,
                    "security_id": iv["security_id"],
                    "ticker": iv["ticker"],
                    "tickers": iv["tickers"],
                    "name": iv["name"],
                    "valid_from": iv["valid_from"],
                    "valid_to": iv["valid_to"],
                    "start_known": iv["start_known"],
                    "source": iv["source"],
                    "known_at": pit.eod_known_at(as_date(vf)).isoformat(),
                    "as_of_date": vf,
                    "transform_name": "index_membership",
                    "transform_version": TV,
                }
            )
        issues.extend({**i, "index": index} for i in found)
    return rows, issues
