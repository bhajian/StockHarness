"""corporate_actions (spec §3.4): normalized splits + dividends keyed to security_id.

Run by the `corporate_actions` Transform (#99): `compute(read)` returns the rows; the Transform writes them
through `oh.output("corporate_actions").upsert(..., prune_by=["security_id", "ex_date"])` on (security_id,
action_type, ex_date): on a day the run wrote, an older row (an old class of the dividend, an amount FMP revised) is
moved to `corporate_actions_retired`; a day the run did not produce is left alone (#518).
"""
from __future__ import annotations

from .corporate_actions_logic import is_special_dividend, normalize_split_ratio
from ._resolve import iso_minus_days, ticker_resolver

TV = "5"  # 5: every FMP row of an ex-date (a regular and a special dividend on one day both count; FMP's label decides the class) (#518); 4: as-paid and split-adjusted dividends both kept; special dividends judged on the adjusted amount (#443)


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


def _dividend_days(read):
    """(symbol, ex-date) -> FMP's dividend rows of that day (#518).

    FMP lists a regular and a special (or variable) dividend paid on one ex-date as two rows (BEN 2018-03-28: $0.23
    quarterly + $3.00 special; both confirmed in its 10-Q). Every row of the day is kept: the history's rows when it
    has that day, else the calendar's, and a row repeated within a source counts once.
    """
    days: dict[tuple, tuple[str, list]] = {}
    for src in ("dividends_history", "dividends_calendar"):
        try:
            rows = read(src)
        except Exception:
            rows = []
        for r in rows:
            k = (r.get("symbol"), r.get("date"))
            if not k[0] or not k[1]:
                continue
            owner, kept = days.setdefault(k, (src, []))
            if owner != src:
                continue  # the history already has this day
            sig = (r.get("frequency"), r.get("dividend"), r.get("adjDividend"))
            if sig not in [(x.get("frequency"), x.get("dividend"), x.get("adjDividend")) for x in kept]:
                kept.append(r)
    return {k: v[1] for k, v in days.items()}


def _sum(rows, field):
    xs = [r.get(field) for r in rows if isinstance(r.get(field), (int, float))]
    return sum(xs) if xs else None


def _is_special_label(r) -> bool:
    return str(r.get("frequency") or "").strip().lower() in ("special", "extra", "variable", "supplemental")


def compute(read):
    """`read(collection, filter=None, columns=None)` -> rows. Dividends classified cash/special, splits as ratio."""
    resolve = ticker_resolver(read("securities", None, ["security_id", "identifiers"]))
    out = []
    by_sec: dict[str, list] = {}
    for (symbol, ex), rows in _dividend_days(read).items():
        sid = resolve(symbol, ex)
        if sid:
            by_sec.setdefault(sid, []).append((ex, rows))
    for sid, days in sorted(by_sec.items()):
        days.sort(key=lambda x: x[0])
        prev_regular = None
        for ex, rows in days:
            labelled = any(r.get("frequency") for r in rows)
            if labelled:
                # FMP says which part is special; each part is the sum of its rows (#518).
                parts = [("cash_dividend", [r for r in rows if not _is_special_label(r)]),
                         ("special_dividend", [r for r in rows if _is_special_label(r)])]
            else:
                parts = [(None, rows)]
            for kind, part in parts:
                if not part:
                    continue
                # As paid (on the share basis of the ex-date) and split-adjusted to today's basis (#443). prices_daily
                # puts the as-paid amount on its bars' basis; the special test uses the adjusted one, so a split
                # between two dividends doesn't make an ordinary one look special.
                paid, adj = _sum(part, "dividend"), _sum(part, "adjDividend")
                amt = adj if adj is not None else paid
                if kind is None:  # no label from FMP: the old size rule
                    kind = "special_dividend" if is_special_dividend(amt, prev_regular) else "cash_dividend"
                first = part[0]
                declared = sorted(r.get("declarationDate") for r in part if r.get("declarationDate"))
                out.append(
                    {
                        "security_id": sid,
                        "action_type": kind,
                        "ex_date": ex,
                        "record_date": first.get("recordDate") or None,
                        "pay_date": first.get("paymentDate") or None,
                        "declaration_date": declared[0] if declared else None,
                        "dividend_amount": paid,
                        "adj_dividend_amount": adj,
                        "currency": "USD",
                        "known_at": declared[0] if declared else iso_minus_days(ex, 1),
                        "_lineage": {**_lineage("dividends", first),
                                     "source_ids": sorted(str(r.get("_id")) for r in part)},
                    }
                )
                if amt and kind == "cash_dividend":
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
