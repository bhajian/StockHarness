"""build_securities (spec §3.2): master identity table seeded from stock list + profiles + delisted.

Matches by CIK, then CUSIP, then ticker+name; maintains validity intervals for ticker/sector/
industry/exchange; assigns immutable security_id. Idempotent: re-runs match existing securities.
"""
from __future__ import annotations

from datetime import datetime, timezone

from ..core.runner import transform

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


@transform("build_securities")
def build(ctx):
    """Harness entry point (until the Layer 2 harness is removed, #99): same logic, direct writes."""
    from pymongo import ReplaceOne

    from ..core.db import coll

    def read(c, flt=None, columns=None):
        return list(coll(c).find(flt or {}, ({k: 1 for k in columns} if columns else None)))

    docs = compute(read, lambda c, p: list(coll(c).aggregate(p, allowDiskUse=True)))
    ctx.rows_read = len(docs)
    sec = coll("securities")
    sec.create_index("security_id", unique=True)
    ops = [ReplaceOne({"security_id": d["security_id"]}, d, upsert=True) for d in docs]
    if ops:
        res = sec.bulk_write(ops, ordered=False)
        ctx.rows_written = (res.upserted_count or 0) + (res.modified_count or 0)
