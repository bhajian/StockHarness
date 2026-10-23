"""build_corporate_actions (spec §3.4): normalized splits + dividends keyed to security_id."""
from __future__ import annotations

from ..core.runner import transform
from .corporate_actions_logic import is_special_dividend, normalize_split_ratio
from ._resolve import ticker_resolver, iso_minus_days

TV = "1"


@transform("build_corporate_actions")
def build(ctx):
    from pymongo import ReplaceOne

    from ..core.db import coll
    from ..core.lineage import lineage

    securities = list(coll("securities").find({}, {"security_id": 1, "identifiers": 1}))
    resolve = ticker_resolver(securities)
    out: list[dict] = []

    # Dividends (grouped per security to classify specials vs the trailing regular).
    divs = list(coll("dividends_calendar").find({}))
    ctx.rows_read += len(divs)
    by_sec: dict[str, list] = {}
    for r in divs:
        ex = r.get("date")
        sid = resolve(r.get("symbol"), ex)
        if sid and ex:
            by_sec.setdefault(sid, []).append(r)
    for sid, rows in by_sec.items():
        rows.sort(key=lambda x: x.get("date") or "")
        prev_regular = None
        for r in rows:
            amt = r.get("dividend") if r.get("dividend") is not None else r.get("adjDividend")
            special = is_special_dividend(amt, prev_regular)
            out.append(
                {
                    "security_id": sid,
                    "action_type": "special_dividend" if special else "cash_dividend",
                    "ex_date": r["date"],
                    "record_date": r.get("recordDate"),
                    "pay_date": r.get("paymentDate"),
                    "declaration_date": r.get("declarationDate"),
                    "dividend_amount": amt,
                    "currency": "USD",
                    "known_at": r.get("declarationDate") or iso_minus_days(r["date"], 1),
                    "_lineage": lineage("dividends_calendar", [r.get("_id")], "build_corporate_actions", TV),
                }
            )
            if amt and not special:
                prev_regular = amt

    # Splits.
    splits = list(coll("splits_calendar").find({}))
    ctx.rows_read += len(splits)
    for r in splits:
        ex = r.get("date")
        sid = resolve(r.get("symbol"), ex)
        if not sid or not ex:
            continue
        out.append(
            {
                "security_id": sid,
                "action_type": "split",
                "ex_date": ex,
                "split_ratio": normalize_split_ratio(r.get("numerator"), r.get("denominator")),
                "split_type": r.get("splitType"),
                "known_at": iso_minus_days(ex, 1),
                "_lineage": lineage("splits_calendar", [r.get("_id")], "build_corporate_actions", TV),
            }
        )

    c = coll("corporate_actions")
    c.create_index([("security_id", 1), ("ex_date", 1)])
    c.create_index([("security_id", 1), ("action_type", 1), ("ex_date", 1)], unique=True)
    if out:
        ops = [
            ReplaceOne(
                {"security_id": d["security_id"], "action_type": d["action_type"], "ex_date": d["ex_date"]},
                d,
                upsert=True,
            )
            for d in out
        ]
        res = c.bulk_write(ops, ordered=False)
        ctx.rows_written = (res.upserted_count or 0) + (res.modified_count or 0)
