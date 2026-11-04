"""build_securities (spec §3.2): master identity table seeded from stock list + profiles + delisted.

Matches by CIK, then CUSIP, then ticker+name; maintains validity intervals for ticker/sector/
industry/exchange; assigns immutable security_id. Idempotent: re-runs match existing securities.
"""
from __future__ import annotations

from datetime import datetime, timezone


UTC = timezone.utc


def compute(read, aggregate, *, today=None, exchanges=None):
    """Gather the Layer 1 inputs through `read`/`aggregate` (oh.read / oh.aggregate in a Transform) and build
    the securities docs. `read(collection, filter=None, columns=None)`."""
    from datetime import date

    from ..core.config import load
    from .securities_logic import DEFAULT_EXCHANGES, build_securities_docs

    cfg = (load("universe.yaml") or {}).get("securities", {})
    first = aggregate(
        "eod_prices",
        [{"$sort": {"symbol": 1, "date": 1}}, {"$group": {"_id": "$symbol", "first": {"$first": "$date"}}}],
    )
    return build_securities_docs(
        profiles=read("company_profiles"),
        stock_list=read("stock_list", None, ["symbol", "companyName", "ipoDate"]),
        delisted=read("delisted_companies"),
        existing=read("securities"),
        first_seen={r["_id"]: r["first"] for r in first if r.get("_id")},
        today=today or date.today().isoformat(),
        exchanges=exchanges or cfg.get("exchanges", DEFAULT_EXCHANGES),
    )
