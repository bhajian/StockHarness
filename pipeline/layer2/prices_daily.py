"""prices_daily (spec §3.3): split/dividend-adjusted point-in-time daily prices, per security.

Run by the `prices_daily` Transform (#99) in date_range mode with a 10-trading-day lookback (H1):
`compute(read, window)` loads [lookback_start, end] but returns only rows in [start, end], so ret_1d, tr_1d and
the stale check are right on daily runs. A security with a split in the window gets its whole history
rewritten (split factors adjust every earlier bar). DQ flags are returned as issues for `oh.dq` (H2: idempotent);
nothing raises on them (H3: gates decide).
"""
from __future__ import annotations

from datetime import datetime, timezone

from ..core import pit
from .prices_logic import compute_symbol_rows, pick_bars
from ._resolve import as_date, security_symbols

UTC = timezone.utc
TV = "4"  # 4: one ticker per date, junk quotes and ×10 days without an action carry no return (#255); 3: #240
ERROR_FLAGS = ("zero_or_negative_price", "high_lt_low", "implausible_price")
BAR_FIELDS = ["_id", "symbol", "date", "open", "high", "low", "close", "volume", "vwap"]


def compute(read, window=None, *, security_ids=None):
    """Yield (rows, issues) per security. `read(collection, filter=None, columns=None, sort=None)`;
    `window` has start, end and lookback_start (ISO dates) or is None for a full rebuild."""
    securities = read("securities", None, ["security_id", "identifiers"])
    sec_syms = security_symbols(securities)
    ticker_iv = {
        s["security_id"]: [i for i in s.get("identifiers", []) if i.get("type") == "ticker"] for s in securities
    }
    if security_ids:
        sec_syms = {k: v for k, v in sec_syms.items() if k in set(security_ids)}
    actions = {}
    for a in read("corporate_actions", None, ["security_id", "action_type", "ex_date", "dividend_amount", "split_ratio"]):
        actions.setdefault(a["security_id"], []).append(a)
    start = window.start if window else None
    end = window.end if window else None
    lookback = window.lookback_start if window else None
    for sid in sorted(sec_syms):
        acts = actions.get(sid, [])
        splits = {a["ex_date"]: a.get("split_ratio") for a in acts if a["action_type"] == "split" and a.get("split_ratio")}
        divs = {
            a["ex_date"]: a.get("dividend_amount")
            for a in acts
            if a["action_type"] in ("cash_dividend", "special_dividend") and a.get("dividend_amount")
        }
        # A split inside the window changes the factor of every earlier bar: rewrite this security's history.
        full = window is None or any(ex >= lookback for ex in splits)
        q = {"symbol": {"$in": sorted(sec_syms[sid])}}
        if full:
            if end:
                q["date"] = {"$lte": end}
        else:
            q["date"] = {"$gte": lookback, "$lte": end}
        bars_raw = read("eod_prices", q, BAR_FIELDS, [("date", 1)])
        if not bars_raw:
            continue
        # One bar per date, from the right ticker when the security has several (#255).
        bars = pick_bars(bars_raw, ticker_iv.get(sid, []))
        by_date = {b["date"]: b for b in bars}
        rows = compute_symbol_rows([{k: b.get(k) for k in BAR_FIELDS[2:]} for b in bars], divs, splits)
        docs, issues = [], []
        for r in rows:
            d = r["date"]
            if not full and d < start:
                continue  # lookback context only (H1)
            docs.append(
                {
                    **r,
                    "security_id": sid,
                    "ticker": by_date[d].get("symbol"),
                    "known_at": pit.eod_known_at(as_date(d)).isoformat(),
                    "as_of_date": d,
                    "source_collection": "eod_prices",
                    "source_ids": [str(by_date[d].get("_id"))],
                    "transform_name": "prices_daily",
                    "transform_version": TV,
                }
            )
            for flag in r["dq_flags"]:
                issues.append(
                    {"issue_type": flag, "severity": "error" if flag in ERROR_FLAGS else "warn", "security_id": sid, "date": d}
                )
        yield docs, issues
