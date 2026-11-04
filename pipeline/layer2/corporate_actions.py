"""corporate_actions (spec §3.4): normalized splits + dividends keyed to security_id.

Run by the `corporate_actions` Transform (#99): `compute(read)` returns the rows; the Transform writes them
through `oh.output("corporate_actions").upsert(...)` on (security_id, action_type, ex_date).
"""
from __future__ import annotations

from .corporate_actions_logic import is_special_dividend, normalize_split_ratio
from ._resolve import iso_minus_days, ticker_resolver

TV = "3"


def _union(read, names, keys=("symbol", "date")):
    """Docs from several collections, deduped on `keys`: the rolling calendar windows plus the full per-symbol
    history (C3)."""
    docs, seen = [], set()
    for n in names:
        try:
            rows = read(n)
        except Exception:
            rows = []
        for r in rows:
            k = tuple(r.get(f) for f in keys)
            if k in seen:
                continue
            seen.add(k)
            docs.append(r)
    return docs


def _lineage(source, row):
    # No processed_at: rows must be identical on a re-run so unchanged rows are skipped.
    return {"source_collection": source, "source_ids": [str(row.get("_id"))], "transform_name": "corporate_actions", "transform_version": TV}


def compute(read):
    """`read(collection, filter=None, columns=None)` -> rows. Dividends classified cash/special, splits as ratio."""
    resolve = ticker_resolver(read("securities", None, ["security_id", "identifiers"]))
    out = []
    by_sec = {}
    for r in _union(read, ["dividends_calendar", "dividends_history"]):
        ex = r.get("date")
        sid = resolve(r.get("symbol"), ex)
        if sid and ex:
            by_sec.setdefault(sid, []).append(r)
    for sid, rows in sorted(by_sec.items()):
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
                    "record_date": r.get("recordDate") or None,
                    "pay_date": r.get("paymentDate") or None,
                    "declaration_date": r.get("declarationDate") or None,
                    "dividend_amount": amt,
                    "currency": "USD",
                    "known_at": r.get("declarationDate") or iso_minus_days(r["date"], 1),
                    "_lineage": _lineage("dividends", r),
                }
            )
            if amt and not special:
                prev_regular = amt
    for r in _union(read, ["splits_calendar", "splits_history"]):
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
                "_lineage": _lineage("splits", r),
            }
        )
    # One row per key (a ticker reused by two listings on the same day resolves to one security).
    unique = {}
    for d in out:
        unique[(d["security_id"], d["action_type"], d["ex_date"])] = d
    return list(unique.values())
