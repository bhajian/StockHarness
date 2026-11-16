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
from ..core.instruments import EQUITY_TYPES
from .prices_logic import compute_symbol_rows, pick_bars
from ._resolve import as_date, security_symbols

UTC = timezone.utc
TV = "9"  # 9: real crashes keep their return, only reverting prints are dropped (#451); 8: implausible or ambiguous-basis dividends (#481); 7: dividends on the bars' split basis (#443), close_raw as traded (#444); 6: bars on non-trading days are dropped (#437); 5: notes, preferreds, warrants, units and funds are skipped (#393); 4: one ticker per date, junk quotes and ×10 days without an action carry no return (#255); 3: #240
ERROR_FLAGS = ("zero_or_negative_price", "high_lt_low", "implausible_price")
BAR_FIELDS = ["_id", "symbol", "date", "open", "high", "low", "close", "volume", "vwap"]


def compute(read, window=None, *, security_ids=None):
    """Yield (rows, issues) per security. `read(collection, filter=None, columns=None, sort=None)`;
    `window` has start, end and lookback_start (ISO dates) or is None for a full rebuild."""
    # Equity only (#393): exchange-traded notes, preferreds, warrants, units and funds get no adjusted prices (and
    # so no DQ issues); their open issues resolve on the next full run.
    securities = [
        s
        for s in read("securities", None, ["security_id", "identifiers", "security_type"])
        if (s.get("security_type") or "common") in EQUITY_TYPES
    ]
    sec_syms = security_symbols(securities)
    ticker_iv = {
        s["security_id"]: [i for i in s.get("identifiers", []) if i.get("type") == "ticker"] for s in securities
    }
    if security_ids:
        sec_syms = {k: v for k, v in sec_syms.items() if k in set(security_ids)}
    # Trading sessions only (#437): FMP sometimes returns a bar on a weekend or holiday (BEP on Saturday 2025-11-08).
    sessions = {
        str(r["date"].isoformat() if hasattr(r["date"], "isoformat") else r["date"])[:10]
        for r in read("trading_calendar", {"is_trading_day": True}, ["date"])
        if r.get("date")
    }
    actions = {}
    for a in read("corporate_actions", None, ["security_id", "action_type", "ex_date", "dividend_amount", "adj_dividend_amount", "split_ratio"]):
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
        adj_divs = {
            a["ex_date"]: a.get("adj_dividend_amount")
            for a in acts
            if a["action_type"] in ("cash_dividend", "special_dividend") and a.get("adj_dividend_amount")
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
        if sessions:
            bars_raw = [b for b in bars_raw if str(b.get("date"))[:10] in sessions]
        if not bars_raw:
            continue
        # One bar per date, from the right ticker when the security has several (#255).
        bars = pick_bars(bars_raw, ticker_iv.get(sid, []))
        by_date = {b["date"]: b for b in bars}
        rows = compute_symbol_rows([{k: b.get(k) for k in BAR_FIELDS[2:]} for b in bars], divs, splits, adj_divs)
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
