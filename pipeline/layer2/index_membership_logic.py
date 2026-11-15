"""Point-in-time index membership (#388): S&P 500, Nasdaq-100 and Dow intervals from FMP's lists (pure, stdlib).

FMP gives the current constituents and a change history (effective date D; an added and/or a removed ticker).
Membership is rebuilt *backwards* from the current list, which is exact today: undoing an addition on D means the
ticker was not a member before D (its interval starts on D); undoing a removal on D means it was a member until D
(an interval that ends on D, whose start is found further back). Intervals are half-open: [valid_from, valid_to).

FMP restates a renamed company under its new ticker, and our securities carry no ticker history, so an addition
recorded under an old ticker (SATS) has no open member to close while the renamed member (ECHO) never meets its
addition. Those are paired afterwards: by the current list's dateFirstAdded (within a few days of the change),
else by a similar company name. A member whose start stays unknown keeps valid_from None (before the history)
only when it is a current member without dateFirstAdded or pre-dates `history_from`; otherwise it is a DQ issue.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from difflib import SequenceMatcher

INDEXES = ("sp500", "ndx", "dji")
# FMP stable endpoints per index: (current constituents, change history). The index_* syncs (#387) add `index`.
INDEX_ENDPOINTS = {
    "sp500": ("sp500-constituent", "historical-sp500-constituent"),
    "ndx": ("nasdaq-constituent", "historical-nasdaq-constituent"),
    "dji": ("dowjones-constituent", "historical-dowjones-constituent"),
}
PAIR_DAYS = 7  # dateFirstAdded vs the change's effective date (FMP's two lists differ by a day at times)
NAME_SIMILARITY = 0.8
_SUFFIX = re.compile(r"\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|the|class [a-z])\b\.?")


def added_ticker(change: dict) -> str:
    """The ticker that joined. On removal rows FMP puts the *removed* ticker in `symbol`, so use addedTicker."""
    if change.get("addedTicker") is not None:
        return str(change.get("addedTicker") or "").strip()
    return "" if change.get("changeType") == "removal" else str(change.get("symbol") or "").strip()


def removed_ticker(change: dict) -> str:
    return str(change.get("removedTicker") or "").strip()


def norm_name(name) -> str:
    s = _SUFFIX.sub(" ", str(name or "").lower().replace("&", " and "))
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", s).split())


def similar(a, b) -> bool:
    na, nb = norm_name(a), norm_name(b)
    return bool(na and nb) and (na == nb or SequenceMatcher(None, na, nb).ratio() >= NAME_SIMILARITY)


def _iso(v):
    return None if v in (None, "") else str(v)[:10]


def _days(a: str, b: str) -> int:
    return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)


def _prev_day(d: str) -> str:
    return (date.fromisoformat(d) - timedelta(days=1)).isoformat()


def strict_resolver(securities: list[dict]):
    """resolve(ticker, on_date) -> security_id when a ticker identifier covers that date. A date before every
    interval of the ticker resolves to the earliest one (our identifiers start with our data, about 2016)."""
    idx: dict[str, list] = {}
    for s in securities:
        for ident in s.get("identifiers") or []:
            if ident.get("type") == "ticker" and ident.get("value"):
                idx.setdefault(ident["value"], []).append((s["security_id"], _iso(ident.get("valid_from")), _iso(ident.get("valid_to"))))

    def resolve(ticker: str, on_date: str | None):
        cands = sorted(idx.get(ticker) or [], key=lambda c: c[1] or "")
        if not cands:
            return None
        if on_date:
            for sid, vf, vt in cands:
                if (vf is None or vf <= on_date) and (vt is None or on_date < vt):
                    return sid
            if cands[0][1] and on_date < cands[0][1]:
                return cands[0][0]
            return None
        return cands[-1][0]

    return resolve


def build_intervals(index: str, current: list[dict], changes: list[dict], today: str, resolve=None, history_from="2016-01-01"):
    """Membership intervals of one index and the DQ issues found while rebuilding them.

    Each interval: {index, key, security_id, ticker, tickers, name, valid_from, valid_to, start_known, source};
    source tells where the start came from: change (an addition), rename (an addition under an earlier ticker),
    first_added (the current list's dateFirstAdded) or unknown (before the history).
    Each issue: {issue_type, severity, ticker, date, security_id, detail}.
    """
    def key_of(t, d):
        sid = resolve(t, d) if resolve else None
        return sid or f"T:{t}"

    open_: dict[str, dict] = {}
    issues: list[dict] = []
    for r in current:
        t = str(r.get("symbol") or "").strip()
        if not t:
            continue
        k = key_of(t, today)
        if k in open_:
            continue  # two share classes on one security (GOOG/GOOGL) count once
        open_[k] = {"ticker": t, "tickers": [t], "name": r.get("name"), "valid_to": None, "first_added": _iso(r.get("dateFirstAdded"))}
    out: list[dict] = []
    unmatched: list[dict] = []  # additions with no later member to close (renamed or missing records)
    by_date: dict[str, list[dict]] = {}
    for c in changes:
        d = _iso(c.get("date"))
        if d and d <= today:
            by_date.setdefault(d, []).append(c)

    def close(k, iv, valid_from, source):
        out.append({"key": k, "ticker": iv["ticker"], "tickers": iv["tickers"], "name": iv.get("name"),
                    "valid_from": valid_from, "valid_to": iv["valid_to"], "start_known": valid_from is not None,
                    "source": source})

    for d in sorted(by_date, reverse=True):
        rows = by_date[d]
        # Undo the additions first (members from d), then the removals (members until d): a ticker swapped out and
        # back in on the same day ends with two adjacent intervals instead of a conflict.
        for c in rows:
            a = added_ticker(c)
            if not a:
                continue
            k = key_of(a, d)
            if k not in open_:
                k = next((x for x, iv in open_.items() if iv["ticker"] == a), k)
            iv = open_.pop(k, None)
            if iv is None:
                unmatched.append({"ticker": a, "date": d, "name": c.get("addedSecurity")})
            else:
                close(k, iv, d, "change")
        for c in rows:
            r = removed_ticker(c)
            if not r:
                continue
            k = key_of(r, _prev_day(d))
            if k in open_ or any(iv["ticker"] == r for iv in open_.values()):
                issues.append({"issue_type": "removed_while_member", "severity": "info", "ticker": r, "date": d,
                               "detail": "removal of a ticker that is a member right after it"})
                continue
            open_[k] = {"ticker": r, "tickers": [r], "name": c.get("removedSecurity"), "valid_to": d, "first_added": None}

    # Pair members whose start was never found with additions recorded under another ticker (renames).
    for k, iv in list(open_.items()):
        match = None
        fa = iv.get("first_added")
        cands = [u for u in unmatched if u["date"] < (iv["valid_to"] or "9999")]
        if fa:
            near = [u for u in cands if _days(u["date"], fa) <= PAIR_DAYS]
            if len(near) > 1:
                near = [u for u in near if similar(u["name"], iv.get("name"))] or near[:1]
            match = near[0] if near else None
        if match is None:
            named = [u for u in cands if similar(u["name"], iv.get("name"))]
            match = max(named, key=lambda u: u["date"]) if named else None
        if match is not None:
            unmatched.remove(match)
            iv["tickers"] = [match["ticker"], *[t for t in iv["tickers"] if t != match["ticker"]]]
            close(k, iv, match["date"], "rename")
        elif fa and iv["valid_to"] is None:
            close(k, iv, fa, "first_added")  # a current member: its first addition, from the constituent list
        else:
            close(k, iv, None, "unknown")
            if iv["valid_to"] is None or iv["valid_to"] > history_from:
                issues.append({"issue_type": "start_unknown", "severity": "warn", "ticker": iv["ticker"],
                               "date": iv["valid_to"] or today, "detail": "member before the history; start date unknown"})
        del open_[k]
    for u in unmatched:
        if u["date"] >= history_from:
            issues.append({"issue_type": "added_without_member", "severity": "info", "ticker": u["ticker"], "date": u["date"],
                           "detail": "addition with no later membership (ticker change or missing removal)"})
    for iv in out:
        iv["index"] = index
        iv["security_id"] = None if iv["key"].startswith("T:") else iv["key"]
        if resolve and iv["security_id"] is None and (iv["valid_to"] is None or iv["valid_to"] > history_from):
            issues.append({"issue_type": "unresolved_ticker", "severity": "warn", "ticker": iv["ticker"],
                           "date": iv["valid_from"] or history_from, "detail": "no security for this ticker"})
    for i in issues:
        i.setdefault("security_id", None)
    out.sort(key=lambda iv: (iv["ticker"], iv["valid_from"] or ""))
    return out, issues


def member_on(intervals: list[dict], day: str) -> bool:
    """True when one of the intervals covers `day` ([valid_from, valid_to))."""
    return any((iv.get("valid_from") is None or iv["valid_from"] <= day) and (iv.get("valid_to") is None or day < iv["valid_to"])
               for iv in intervals)
