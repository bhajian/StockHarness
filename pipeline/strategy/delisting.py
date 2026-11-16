"""What a position earns when its security delists (#448). Shared by the evaluator and the paper broker.

A flat -30% for every delisting gave shorts a +30% windfall and charged takeover targets, often bought out at a
premium, a loss. The class comes from the security's own prices into its last session (we have no delisting reason):

- merger: the price was pinned in its last 20 sessions (a cash-out at the deal price): 0% on either side.
- distress: the last traded price is under $1, or it fell more than half in its last 60 sessions: longs lose
  `distress` (Shumway 1997 finds about -30% to -55% for performance delistings).
- unknown: anything else, or too little history: longs lose `unknown`.

A short never gains from a delisting (`short`, default 0): we can't tell a buyout from a bankruptcy, and a short
can be recalled or bought in. Every delisting is recorded with its class.
"""
from __future__ import annotations

import statistics

DEFAULTS = {"merger": 0.0, "distress": -0.55, "unknown": -0.30, "short": 0.0}
PINNED_STD = 0.01  # daily std of returns over the last 20 sessions below this: pinned at a deal price
DISTRESS_PRICE = 1.0
DISTRESS_DROP = -0.5


def classify(closes_raw: list[float], rets: list[float]) -> str:
    """`closes_raw`: as-traded closes up to the last session (oldest first); `rets`: daily returns on those days."""
    closes = [c for c in closes_raw if isinstance(c, (int, float)) and c > 0]
    if closes and closes[-1] < DISTRESS_PRICE:
        return "distress"
    window = closes[-61:]
    if len(window) >= 21 and window[-1] / window[0] - 1 < DISTRESS_DROP:
        return "distress"
    last = [r for r in rets[-20:] if isinstance(r, (int, float))]
    if len(last) >= 15 and statistics.pstdev(last) < PINNED_STD:
        return "merger"
    return "unknown"


def settings(cfg: dict) -> dict:
    """The delisting returns from the evaluator config (`delisting` block; `delisting_return` is the old flat value)."""
    d = {**DEFAULTS, **(cfg.get("delisting") or {})}
    if "delisting" not in cfg and cfg.get("delisting_return") is not None:
        d["unknown"] = float(cfg["delisting_return"])
    return {k: float(v) for k, v in d.items()}


def price_return(cls: str, side: int, s: dict) -> float:
    """The price move applied once to a position of `side` (+1 long, -1 short) in a delisting of class `cls`."""
    if side < 0:
        return -s["short"]  # a short's P&L is -(price move): its return is s["short"]
    return s["merger"] if cls == "merger" else s["distress"] if cls == "distress" else s["unknown"]
