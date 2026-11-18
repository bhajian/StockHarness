"""The independent executor (#467, stage 2): trade the signal tape on as-traded prices and keep a shares-and-cash
ledger, so a bug in the evaluator's return math can't show up as profit in both.

It imports nothing from the evaluator (`engine.py`): only the tape schema and the delisting rules, which are the
documented policy both follow. It never reads `tr_1d` or `ret_1d` for valuation:

- each book is filled at the close of its execution session, at the as-traded close (`close_raw`, else `close` when
  the data has no splits to undo), with shares = weight × NAV / price and the rest in cash (cash earns nothing,
  short proceeds included, like the evaluator);
- on a split's ex-date the share count is multiplied by the ratio (new per old), from `corporate_actions`;
- on a dividend's ex-date the position earns shares × the dividend as paid per share (a short pays it), reinvested
  in the same name at that close, which is what a total return assumes;
- a bad print (`dq_flags` has `bad_print`) is not a price: the last good close is kept;
- a dividend row repeated within one class counts once; a cash and a special dividend on one day both count (#518),
  and a dividend is skipped where the price row is flagged `implausible_dividend`
  (the bars are adjusted for it, e.g. KDP's $103.75 merger dividend on 2018-07-10): both are listed;
- a held name whose prices stopped and which is no longer active delists once, by the delisting rules, into cash.

Its daily return is before costs: the reconciliation compares it with the evaluator's return before costs.
It also checks the trading rules: every fill is `lag` sessions after its signal, on a session of the trading
calendar, at a price that exists, in a name eligible on the signal date.
"""
from __future__ import annotations

import math

from . import delisting

SPLIT = "split"
DIVIDENDS = ("cash_dividend", "special_dividend")


def _num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def load_market(source, names: list[str], start: str, end: str, calendar_from: str | None = None) -> dict:
    """As-traded closes, corporate actions, activity and the calendar for `names` over start..end."""
    px: dict[str, dict[str, float]] = {}
    implausible: set[tuple[str, str]] = set()
    last_row: dict[str, str] = {}
    rets: dict[str, list] = {}  # for the delisting class: (date, close, ret_1d) in date order
    for r in source.find("prices_daily", {"security_id": {"$in": names}, "date": {"$gte": start, "$lte": end}},
                         ["security_id", "date", "close", "close_raw", "dq_flags", "ret_1d"]) if names else []:
        s, d = r["security_id"], r["date"]
        last_row[s] = max(last_row.get(s, d), d)
        price = _num(r.get("close_raw"))
        price = price if price is not None else _num(r.get("close"))
        rets.setdefault(s, []).append((d, price, r.get("ret_1d")))
        if "implausible_dividend" in (r.get("dq_flags") or []):
            implausible.add((s, d))
        if price is None or price <= 0 or "bad_print" in (r.get("dq_flags") or []):
            continue
        px.setdefault(s, {})[d] = price
    splits: dict[str, dict[str, float]] = {}
    # Per security, ex-date and class (cash / special): the distinct amounts (#518 left a repeated row within a class
    # possible). Classes add up: a regular and a special dividend of the same size on one day are both paid
    # (Equinor 2024-08-19: $0.35 ordinary + $0.35 extraordinary; Ford 2025-02-18: $0.15 + $0.15 supplemental).
    amounts: dict[tuple[str, str, str], set[float]] = {}
    rows_of: dict[tuple[str, str, str], int] = {}
    for a in source.find("corporate_actions", {"security_id": {"$in": names}, "ex_date": {"$gte": start, "$lte": end}},
                         ["security_id", "action_type", "ex_date", "split_ratio", "dividend_amount"]) if names else []:
        s, d = a["security_id"], str(a["ex_date"])[:10]
        if a.get("action_type") == SPLIT and _num(a.get("split_ratio")) and a["split_ratio"] > 0:
            splits.setdefault(s, {})[d] = splits.get(s, {}).get(d, 1.0) * float(a["split_ratio"])
        elif a.get("action_type") in DIVIDENDS and _num(a.get("dividend_amount")):
            k = (s, d, a["action_type"])
            amounts.setdefault(k, set()).add(round(float(a["dividend_amount"]), 8))
            rows_of[k] = rows_of.get(k, 0) + 1
    divs: dict[str, dict[str, float]] = {}
    skipped = []
    for (s, d, _kind), xs in sorted(amounts.items()):
        if (s, d) in implausible:
            skipped.append({"security_id": s, "ex_date": d, "amount": max(xs)})
            continue
        divs.setdefault(s, {})[d] = divs.get(s, {}).get(d, 0.0) + sum(xs)
    duplicates = [{"security_id": s, "ex_date": d} for (s, d, k), n in sorted(rows_of.items()) if n > len(amounts[(s, d, k)])]
    inactive = {r["security_id"] for r in source.find("securities", {"security_id": {"$in": names}},
                                                       ["security_id", "is_active"]) if r.get("is_active") is False}
    calendar = {r["date"] for r in source.find("trading_calendar", {"date": {"$gte": calendar_from or start, "$lte": end}},
                                               ["date", "is_trading_day"]) if r.get("is_trading_day", True)}
    return {"px": px, "splits": splits, "divs": divs, "inactive": inactive, "last_row": last_row,
            "dividend_notes": {"duplicates_ignored": duplicates[:20], "duplicate_count": len(duplicates),
                               "implausible_skipped": skipped[:20], "implausible_count": len(skipped)},
            "history": {s: sorted(v) for s, v in rets.items()}, "calendar": calendar}


def run(tape: dict, source, cfg: dict, eligible: dict[str, set[str]] | None = None) -> dict:
    """Execute the tape. Returns daily returns before costs, per-name daily contributions and the rule checks."""
    sessions = tape["sessions"]
    if not sessions:
        return {"dates": [], "returns": [], "contributions": {}, "rules": {"checked": 0, "violations": []}}
    books: dict[str, dict[str, float]] = {r["exec_date"]: {} for r in tape["rebalances"]}
    for row in tape["rows"]:
        books[row["exec_date"]][row["security_id"]] = float(row["weight"])
    names = sorted({row["security_id"] for row in tape["rows"]})
    first_signal = min((rb["signal_date"] for rb in tape["rebalances"]), default=sessions[0])
    mk = load_market(source, names, sessions[0], sessions[-1], calendar_from=min(first_signal, sessions[0]))
    px, splits, divs = mk["px"], mk["splits"], mk["divs"]
    if names and not px:  # the data has no closes at all (returns only): nothing to execute against
        return {"dates": [], "returns": [], "contributions": {}, "unavailable": "prices_daily has no closes",
                "rules": {"checked": 0, "violations": [], "violation_count": 0}}
    delist_cfg = delisting.settings(cfg)

    violations: list[dict] = []
    cal = sorted(mk["calendar"])
    pos = {d: k for k, d in enumerate(cal)}
    for rb in tape["rebalances"]:  # the trading rules, on what the tape asked for
        if cal and rb["exec_date"] not in pos:
            violations.append({"rule": "fill_on_a_session", "exec_date": rb["exec_date"]})
        if rb["exec_date"] <= rb["signal_date"]:
            violations.append({"rule": "fill_after_signal", "signal_date": rb["signal_date"], "exec_date": rb["exec_date"]})
        elif rb["signal_date"] in pos and rb["exec_date"] in pos and \
                pos[rb["exec_date"]] - pos[rb["signal_date"]] != int(tape["lag"]):
            violations.append({"rule": "lag_sessions", "signal_date": rb["signal_date"], "exec_date": rb["exec_date"],
                               "sessions": pos[rb["exec_date"]] - pos[rb["signal_date"]], "lag": int(tape["lag"])})
    checked = 0
    unfilled: list[dict] = []
    shares: dict[str, float] = {}
    last: dict[str, float] = {}
    cash, nav_prev = 1.0, 1.0
    gone: set[str] = set()
    dates, returns, contributions = [], [], {}
    for d in sessions:
        contrib: dict[str, float] = {}
        value_prev = {s: q * last[s] for s, q in shares.items() if s in last}
        for s in list(shares):  # corporate actions at the open of the ex-date
            r = splits.get(s, {}).get(d)
            if r:
                shares[s] *= r
                if s in last:
                    last[s] /= r
        paid = {s: shares[s] * divs[s][d] for s in shares if d in divs.get(s, {})}
        for s in list(shares):
            if d in px.get(s, {}):
                last[s] = px[s][d]
            if s in paid and last.get(s):  # the dividend buys more of the name at this close (a short owes more)
                shares[s] += paid[s] / last[s]
            elif s in mk["inactive"] and s not in gone and mk["last_row"].get(s, d) < d:
                hist = mk["history"].get(s, [])
                cls = delisting.classify([c for _, c, _ in hist], [x for _, _, x in hist])
                move = delisting.price_return(cls, 1 if shares[s] > 0 else -1, delist_cfg)
                proceeds = shares[s] * last.get(s, 0.0) * (1 + move)
                contrib[s] = contrib.get(s, 0.0) + (proceeds - value_prev.get(s, 0.0)) / (nav_prev or 1.0)
                cash += proceeds
                gone.add(s)
                del shares[s]
        for s, q in shares.items():
            if s in last:
                contrib[s] = contrib.get(s, 0.0) + (q * last[s] - value_prev.get(s, 0.0)) / (nav_prev or 1.0)
        nav = cash + sum(q * last[s] for s, q in shares.items() if s in last)
        dates.append(d)
        returns.append(nav / nav_prev - 1 if nav_prev else 0.0)
        contributions[d] = contrib
        if d in books:  # fill the book at this close; names without a price today are sold at their last close
            book = {s: w for s, w in books[d].items() if d in px.get(s, {}) and s not in gone}
            for s, w in books[d].items():
                checked += 1
                if s not in book and s not in gone:  # no price at this close: not traded (the evaluator skips it too)
                    unfilled.append({"exec_date": d, "security_id": s})
                if eligible is not None and s not in eligible.get(d, set()):
                    violations.append({"rule": "eligible_on_signal_date", "exec_date": d, "security_id": s})
            shares = {s: w * nav / px[s][d] for s, w in book.items()}
            last.update({s: px[s][d] for s in book})
            cash = nav - sum(q * last[s] for s, q in shares.items())
        nav_prev = nav if nav > 0 else 0.0
        if nav <= 0:  # wiped out, like the evaluator: no book after a total loss
            shares, cash = {}, 0.0
    return {"dates": dates, "returns": returns, "contributions": contributions,
            "rules": {"checked": checked, "violations": violations[:50], "violation_count": len(violations),
                      "unfilled": unfilled[:20], "unfilled_count": len(unfilled)},
            "dividends": mk["dividend_notes"]}
