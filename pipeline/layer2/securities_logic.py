"""Pure identity-resolution + validity-interval logic for `securities` (spec §3.2).

Stdlib only -> unit-tested without mongo. The build() orchestrator in securities.py wires these
to Layer 1 reads and Mongo writes.
"""
from __future__ import annotations

from difflib import SequenceMatcher

IDENTIFIER_TYPES = ("ticker", "cusip", "cik", "isin", "figi")


def name_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def match_security(candidate: dict, existing: list[dict], name_threshold: float = 0.88, live=None):
    """Return the security_id of the existing security the candidate refers to, else None.

    Match precedence (spec §3.2): CIK, then CUSIP, then ticker + name similarity.
    `existing` items: {security_id, cik, cusips:set, tickers:set, name}.

    A CIK names the issuer, not the instrument (#255): with `live` (the tickers trading now), a CIK match is
    taken only when that security has no *other* ticker trading now. A rename (the old ticker stopped) still
    matches; a preferred share or a baby bond of the same issuer, listed alongside the common stock, does not.
    """
    cik = candidate.get("cik")
    ticker = candidate.get("ticker")
    if cik:
        for s in existing:
            if s.get("cik") and str(s["cik"]) == str(cik):
                if live is not None and (set(s.get("tickers", set())) & set(live)) - {ticker}:
                    continue
                return s["security_id"]
    cusip = candidate.get("cusip")
    if cusip:
        for s in existing:
            if cusip in s.get("cusips", set()):
                return s["security_id"]
    if ticker:
        best, best_score = None, 0.0
        for s in existing:
            if ticker in s.get("tickers", set()):
                score = name_similarity(candidate.get("name", ""), s.get("name", ""))
                if score > best_score:
                    best, best_score = s["security_id"], score
        if best and best_score >= name_threshold:
            return best
    return None


def upsert_interval(intervals: list[dict], value, valid_from, valid_to=None):
    """Append a validity interval for a changing attribute (ticker/sector/industry/exchange).

    If the newest open interval already carries `value`, do nothing. Otherwise close the open
    interval at `valid_from` and open a new one. Returns the updated list (new object).
    """
    intervals = [dict(i) for i in intervals]
    open_iv = next((i for i in reversed(intervals) if i.get("valid_to") is None), None)
    if open_iv is not None and open_iv.get("value") == value:
        return intervals
    if open_iv is not None:
        open_iv["valid_to"] = valid_from
    intervals.append({"value": value, "valid_from": valid_from, "valid_to": valid_to})
    return intervals


def ticker_on(identifiers: list[dict], on_date):
    """Resolve the ticker valid on `on_date` from identifier intervals (spec §1.1)."""
    for ident in identifiers:
        if ident.get("type") != "ticker":
            continue
        vf, vt = ident.get("valid_from"), ident.get("valid_to")
        if (vf is None or vf <= on_date) and (vt is None or on_date < vt):
            return ident.get("value")
    return None


def has_ticker_collision(active: list[dict], on_date) -> list[str]:
    """Return tickers shared by >1 active security on `on_date` (validation, spec §3.2)."""
    seen: dict[str, int] = {}
    for s in active:
        t = ticker_on(s.get("identifiers", []), on_date)
        if t:
            seen[t] = seen.get(t, 0) + 1
    return [t for t, n in seen.items() if n > 1]


# --- build_securities as a pure function (#98) ------------------------------------------------------
DEFAULT_EXCHANGES = ("NASDAQ", "NYSE", "AMEX", "NYSE American")


def iso_bound(v):
    """H4: every interval bound is an ISO date string (YYYY-MM-DD); datetimes from older runs are normalized."""
    if v is None:
        return None
    if hasattr(v, "date") and callable(v.date):  # datetime
        return v.date().isoformat()
    if hasattr(v, "isoformat"):  # date
        return v.isoformat()
    return str(v)[:10]


def _normalized(intervals):
    return [{**i, "valid_from": iso_bound(i.get("valid_from")), "valid_to": iso_bound(i.get("valid_to"))} for i in intervals or []]


def match_index(docs):
    out = []
    for d in docs:
        tickers, cusips, cik = set(), set(), None
        for ident in d.get("identifiers", []):
            if ident["type"] == "ticker":
                tickers.add(ident["value"])
            elif ident["type"] == "cusip":
                cusips.add(ident["value"])
            elif ident["type"] == "cik":
                cik = ident["value"]
        out.append({"security_id": d["security_id"], "cik": cik, "cusips": cusips, "tickers": tickers, "name": d.get("name", "")})
    return out


def set_identifier(doc, id_type, value, valid_from):
    """Ensure an identifier exists; tickers keep validity intervals (a change closes the previous one)."""
    if value in (None, ""):
        return
    value = str(value)
    if id_type in ("cik", "cusip", "isin"):
        if not any(i["type"] == id_type and i["value"] == value for i in doc["identifiers"]):
            doc["identifiers"].append({"type": id_type, "value": value, "valid_from": valid_from, "valid_to": None})
        return
    tickers = [i for i in doc["identifiers"] if i["type"] == "ticker"]
    others = [i for i in doc["identifiers"] if i["type"] != "ticker"]
    merged = upsert_interval(
        [{"value": t["value"], "valid_from": t.get("valid_from"), "valid_to": t.get("valid_to")} for t in tickers],
        value,
        valid_from,
    )
    doc["identifiers"] = others + [{"type": "ticker", **m} for m in merged]


def _history(doc, field, value, today, first_seen):
    """H5: the first interval of a security's sector/industry is backfilled to when the security was first
    observed (and flagged); later changes are real observations dated today."""
    hist = _normalized(doc.get(f"{field}_history"))
    if len(hist) == 1 and not hist[0].get("backfilled") and hist[0].get("valid_from") and hist[0]["valid_from"] > first_seen:
        # Docs from before H5: the single interval started at the first run; backfill it and flag it.
        doc.setdefault(f"{field}_observed_from", hist[0]["valid_from"])
        hist[0] = {**hist[0], "valid_from": first_seen, "backfilled": True}
        doc[f"{field}_is_backfilled"] = True
    if not hist:
        doc[f"{field}_history"] = [{"value": value, "valid_from": first_seen, "valid_to": None, "backfilled": first_seen < today}]
        doc[f"{field}_is_backfilled"] = first_seen < today
        doc[f"{field}_observed_from"] = today
        return
    doc[f"{field}_history"] = upsert_interval(hist, value, today)
    doc.setdefault(f"{field}_is_backfilled", bool(hist[0].get("backfilled")))


def split_securities(existing_docs: dict, profiles: dict, live: set, touched: dict) -> None:
    """Undo merges of concurrently listed instruments (#255): an existing security with more than one ticker
    trading now keeps the earliest-seen one (ties: the shortest, then alphabetical) and its id; the others lose
    their ticker, CUSIP and ISIN here and become securities of their own in this run. The kept ticker's
    intervals, fragmented by the merge, become one open interval from its first observation."""
    for sid, d in existing_docs.items():
        tick = [i for i in d.get("identifiers", []) if i["type"] == "ticker"]
        live_t = sorted({i["value"] for i in tick if i["value"] in live})
        if len(live_t) < 2:
            continue
        first = {t: min((i.get("valid_from") or "") for i in tick if i["value"] == t) for t in live_t}
        keep = min(live_t, key=lambda t: (first[t], len(t), t))
        drop = set(live_t) - {keep}
        kept_ids = {(k, str(profiles.get(keep, {}).get(k))) for k in ("cusip", "isin") if profiles.get(keep, {}).get(k)}
        drop_ids = {(k, str(profiles[t][k])) for t in drop for k in ("cusip", "isin") if profiles.get(t, {}).get(k)} - kept_ids
        others = [i for i in d["identifiers"] if i["type"] != "ticker" and (i["type"], str(i["value"])) not in drop_ids]
        old_tickers = [i for i in tick if i["value"] not in drop and i["value"] != keep]
        merged = {"type": "ticker", "value": keep, "valid_from": first[keep] or None, "valid_to": None}
        d["identifiers"] = others + old_tickers + [merged]
        d["split_tickers"] = sorted(set(d.get("split_tickers", [])) | drop)
        touched[sid] = d


def build_securities_docs(profiles, stock_list, delisted, existing, first_seen, today, exchanges=DEFAULT_EXCHANGES):
    """The securities master: match by CIK, then CUSIP, then ticker+name; immutable SEC_ ids; validity intervals.

    profiles / stock_list / delisted: lists of Layer 1 rows; existing: current securities docs;
    first_seen: {symbol: first ISO date observed in eod_prices}; today: ISO date of this run.
    Returns the docs to upsert on security_id. H4/H5/H6 (#28, #29, #30).
    """
    allowed = {a.upper() for a in exchanges}
    existing_docs = {}
    for d in existing:
        d = {k: v for k, v in d.items() if k != "_id"}
        d["identifiers"] = _normalized(d.get("identifiers"))
        for f in ("sector", "industry", "exchange"):
            if d.get(f"{f}_history"):
                d[f"{f}_history"] = _normalized(d[f"{f}_history"])
        existing_docs[d["security_id"]] = d
    next_num = 1 + max((int(s.split("_")[1]) for s in existing_docs if s.startswith("SEC_")), default=0)
    profiles = {p["symbol"]: p for p in profiles if p.get("symbol")}
    stock = {s["symbol"]: s for s in stock_list if s.get("symbol")}
    dl = {d["symbol"]: d for d in delisted if d.get("symbol")}
    touched = {}
    # Tickers trading now: an active profile, not delisted.
    live = {sym for sym, p in profiles.items() if p.get("isActivelyTrading", True) and not dl.get(sym, {}).get("delistedDate")}
    split_securities(existing_docs, profiles, live, touched)
    idx = match_index(list(existing_docs.values()))
    by_sid = {e["security_id"]: e for e in idx}
    for sym in sorted(set(profiles) | set(dl)):
        p, sl, d = profiles.get(sym, {}), stock.get(sym, {}), dl.get(sym, {})
        if p:
            if p.get("isEtf") or p.get("isFund"):
                continue
            exch = (p.get("exchange") or p.get("exchangeShortName") or "").upper()
            if exch and allowed and not any(a in exch for a in allowed):
                continue
        name = p.get("companyName") or sl.get("companyName") or d.get("companyName") or sym
        sid = match_security({"ticker": sym, "cik": p.get("cik"), "cusip": p.get("cusip"), "name": name}, idx, live=live)
        if sid and sid in touched:
            doc = touched[sid]
        elif sid and sid in existing_docs:
            doc = existing_docs[sid]
            doc.setdefault("identifiers", [])
        else:
            sid = f"SEC_{next_num:06d}"
            next_num += 1
            doc = {
                "security_id": sid,
                "name": name,
                "security_type": "ADR" if p.get("isAdr") else "common",
                "country": p.get("country"),
                "currency": p.get("currency") or "USD",
                "identifiers": [],
                "ipo_date": iso_bound(p.get("ipoDate") or sl.get("ipoDate") or d.get("ipoDate")),
                "is_active": True,
            }
            entry = {"security_id": sid, "cik": p.get("cik"), "cusips": set(), "tickers": set(), "name": name}
            idx.append(entry)
            by_sid[sid] = entry
        # The index learns this ticker and CUSIP now, so a second instrument of the same issuer in this run is
        # told apart from the first (#255).
        by_sid[sid]["tickers"].add(sym)
        if p.get("cusip"):
            by_sid[sid]["cusips"].add(str(p["cusip"]))
        # H6: identifiers are valid from the first date the ticker is observed (not the IPO date).
        seen = iso_bound(first_seen.get(sym)) or today
        set_identifier(doc, "ticker", sym, seen)
        if sym in first_seen:
            # Older docs used the IPO date (or 1900-01-01): the ticker's first interval starts when it is first seen.
            mine = [i for i in doc["identifiers"] if i["type"] == "ticker" and i["value"] == sym]
            if mine and len(mine) == 1 and mine[0]["valid_from"] != seen and not any(
                i["type"] == "ticker" and i["value"] != sym and (i.get("valid_from") or "") <= seen for i in doc["identifiers"]
            ):
                mine[0]["valid_from"] = seen
        for t in ("cik", "cusip", "isin"):
            set_identifier(doc, t, p.get(t), seen)
        if p.get("sector"):
            _history(doc, "sector", p["sector"], today, seen)
        if p.get("industry"):
            _history(doc, "industry", p["industry"], today, seen)
        # Delisted names have no profile: their exchange comes from the delisted list (needed by universe_daily).
        # Exchanges follow the same backfill rule as sectors (H5): without it, universe_daily finds no exchange
        # before the first run and the historical universe is empty.
        exch = p.get("exchange") or p.get("exchangeShortName") or d.get("exchange")
        if exch:
            _history(doc, "exchange", exch, today, seen)
        if d.get("delistedDate"):
            doc["delisted_date"] = iso_bound(d["delistedDate"])
            doc["is_active"] = False
        elif p:
            doc["is_active"] = bool(p.get("isActivelyTrading", True))
        doc["name"] = name
        # A canonical order keeps re-runs byte-identical (the content hash skips unchanged docs).
        doc["identifiers"] = sorted(
            doc["identifiers"],
            key=lambda i: (IDENTIFIER_TYPES.index(i["type"]) if i["type"] in IDENTIFIER_TYPES else 99, i.get("valid_from") or "", i["value"]),
        )
        doc["source_collections"] = ["company_profiles", "stock_list", "delisted_companies", "eod_prices"]
        touched[sid] = doc
    return list(touched.values())
