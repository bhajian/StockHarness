"""The paper broker (#124): one share-and-cash ledger for simulations (M6) and the live paper book (M7).

The broker is stepped one session at a time:

    b = PaperBroker(capital, costs)
    b.open_day(day, bars)            # borrow, splits and dividends, mark to the close, delistings
    b.exit(day, key, reason)         # an exit decided `lag` sessions earlier fills at this close
    b.rebalance(day, books)          # target weights per (idea, security), filled at this close
    row, positions = b.close_day(day)

Prices come from prices_daily (`close`, `ret_1d`, `tr_1d`). The day's split ratio and dividend per share are
recovered from them exactly as the prices transform computed them (tr_1d = ((close + div) * ratio) / prev - 1), so
the ledger's NAV follows the evaluator's total returns. Splits adjust share counts; dividends credit cash (and
debit it for shorts); a delisted name closes at its last price times (1 + delisting_return).

Costs follow the evaluator's convention so a one-idea simulation reproduces its equity curve: an order costs
(commission + slippage) on the traded value at the pre-trade NAV, and the targets are sized on the NAV after
costs. Every day reconciles: NAV = cash + market value, and the change in NAV = price P&L + dividends - costs -
borrow.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

EPS = 1e-12
EXIT_REASONS = ("replaced", "rebalance", "stop", "take_profit", "horizon", "invalidation", "p_outperform",
                "delisted", "no_price", "end")


def _r(x, nd=6):
    return None if x is None or not math.isfinite(x) else round(float(x), nd)


@dataclass
class Lot:
    """A position of one idea in one security, from its first fill to the fill that closes it."""

    idea: str
    security_id: str
    shares: float = 0.0
    entry_date: str = ""
    entry_price: float = 0.0
    entry_value: float = 0.0  # |notional| of the opening fill (the trade return's base)
    net_invested: float = 0.0  # buys - sells (cash paid into the position)
    dividends: float = 0.0
    commissions: float = 0.0
    borrow: float = 0.0
    held_days: int = 0  # sessions since the entry or the last rebalance that kept it (for the horizon exit)
    sessions: int = 0  # sessions since the entry
    opened: int = 0  # 1 long, -1 short (the side of the opening fill)
    signal: dict | None = None  # the score, rank and date that opened it

    @property
    def side(self) -> int:
        return (self.shares > 0) - (self.shares < 0)


@dataclass
class PaperBroker:
    capital: float
    commission_bps: float = 1.0
    slippage_bps: float = 5.0
    borrow_bps: float = 50.0
    delisting_return: float = -0.30
    periods: int = 252
    inactive: set = field(default_factory=set)  # securities no longer active (for the delisting rule)
    final_bar: dict = field(default_factory=dict)  # security -> the last date it has a price
    tickers: dict = field(default_factory=dict)
    # "reinvest": a long lot's dividend buys more of it at that close, at no cost (as the evaluator's tr_1d
    # assumes); "cash": it stays in cash until the next rebalance. Shorts always pay theirs from cash.
    dividends: str = "reinvest"

    def __post_init__(self):
        self.cash = float(self.capital)
        self.lots: dict[tuple[str, str], Lot] = {}
        self.close: dict[str, float] = {}  # last close per security
        self.nav_prev = float(self.capital)
        self.orders: list[dict] = []
        self.trades: list[dict] = []
        self._day: dict = {}

    # --- helpers -----------------------------------------------------------------------------------------
    @property
    def cost_rate(self) -> float:
        return (float(self.commission_bps) + float(self.slippage_bps)) / 1e4

    def value(self, key) -> float:
        lot = self.lots[key]
        return lot.shares * self.close.get(lot.security_id, 0.0)

    def nav(self) -> float:
        return self.cash + sum(self.value(k) for k in self.lots)

    def weights(self) -> dict[tuple[str, str], float]:
        n = self.nav()
        return {k: self.value(k) / n for k in self.lots} if n > 0 else {}

    # --- the day -----------------------------------------------------------------------------------------
    def open_day(self, day: str, bars: dict[str, dict]) -> None:
        """Borrow on yesterday's short value, then each held name's split, dividend and close; delistings."""
        st = self._day = {"date": day, "price_pnl": 0.0, "dividends": 0.0, "costs": 0.0, "borrow": 0.0,
                          "bars": bars, "traded": 0.0}
        daily = float(self.borrow_bps) / 1e4 / self.periods
        for lot in self.lots.values():
            if lot.shares < 0:
                b = -lot.shares * self.close.get(lot.security_id, 0.0) * daily
                lot.borrow += b
                st["borrow"] += b
        self.cash -= st["borrow"]
        held = {lot.security_id for lot in self.lots.values()}
        for s, bar in bars.items():
            prev = self.close.get(s)
            close, ratio, div = _price_step(prev, bar)
            if close is None:
                continue
            reinvest = []
            if s in held and prev is not None:
                for lot in (l for l in self.lots.values() if l.security_id == s):
                    before = lot.shares * prev
                    lot.shares *= ratio
                    d = lot.shares * div
                    lot.dividends += d
                    st["dividends"] += d
                    self.cash += d
                    st["price_pnl"] += lot.shares * close - before
                    if d > 0 and lot.shares > 0 and self.dividends == "reinvest":
                        reinvest.append((lot, d))
            self.close[s] = close
            for lot, d in reinvest:  # cash into shares at the close: no change in NAV
                qty = d / close
                lot.shares += qty
                lot.net_invested += d
                self.cash -= d
                self.orders.append({
                    "n": len(self.orders) + 1, "date": day, "fill_date": day, "idea_id": lot.idea,
                    "security_id": s, "ticker": self.tickers.get(s), "side": "buy", "shares": _r(qty, 6),
                    "price": _r(close, 6), "notional": _r(d, 4), "cost": 0.0, "reason": "dividend",
                })
        for key in [k for k, l in self.lots.items() if l.security_id not in bars]:
            s = key[1]
            if s in self.inactive and self.final_bar.get(s, day) < day:
                prev = self.close.get(s, 0.0)
                gone = prev * (1 + float(self.delisting_return))
                st["price_pnl"] += self.lots[key].shares * (gone - prev)
                self.close[s] = gone
                self._fill(day, key, -self.lots[key].shares, "delisted", cost=0.0)

    def exit(self, day: str, key: tuple[str, str], reason: str) -> bool:
        """Close a lot at today's close (an exit decided earlier). False when it is already gone or has no price."""
        if key not in self.lots or key[1] not in self._day.get("bars", {}):
            return False
        lot = self.lots[key]
        cost = self.cost_rate * abs(self.value(key))
        self._fill(day, key, -lot.shares, reason, cost=cost)
        return True

    def rebalance(self, day: str, books: dict[str, dict[str, float]], signals: dict | None = None,
                  reasons: dict | None = None) -> None:
        """Trade each idea in `books` to its target weights {security: weight of NAV} at today's close.

        Ideas not in `books` keep their lots. A held name of a rebalanced idea that is not in its book is sold
        ("replaced", or `reasons[(idea, security)]`); one without a price today is sold at its last close.
        """
        signals = signals or {}
        reasons = reasons or {}
        bars = self._day.get("bars", {})
        n_pre = self.nav()
        if n_pre <= 0:
            return
        plan = []  # (key, target weight or None for a sale at the last close, reason)
        for idea, book in books.items():
            tgt = {s: w for s, w in book.items() if s in bars}
            for key in [k for k in self.lots if k[0] == idea]:
                if key[1] not in tgt:
                    plan.append((key, 0.0 if key[1] in bars else None, reasons.get(key) or
                                 ("replaced" if key[1] in bars else "no_price")))
            for s, w in tgt.items():
                plan.append(((idea, s), w, "rebalance" if (idea, s) in self.lots else "entry"))
        current = {k: (self.value(k) if k in self.lots else 0.0) for k, _, _ in plan}
        # Costs on the traded value at the pre-trade NAV; targets on the NAV after costs (the evaluator's rule).
        traded = [(k, w, why, abs((w or 0.0) * n_pre - current[k]) if w is not None else abs(current[k]))
                  for k, w, why in plan]
        costs = {k: self.cost_rate * t for k, _, _, t in traded}
        n_post = n_pre - sum(costs.values())
        for key, w, why, _ in traded:
            price = self.close.get(key[1])
            if not price:
                continue
            target_shares = 0.0 if w is None else w * n_post / price
            have = self.lots[key].shares if key in self.lots else 0.0
            if abs(target_shares - have) * price < 1e-9 and costs[key] < 1e-12:
                continue
            self._fill(day, key, target_shares - have, why, cost=costs[key],
                       signal=(signals.get(key[0]) or {}).get(key[1]))
        for idea, book in books.items():  # kept or bought by this rebalance: the horizon clock restarts
            for s in book:
                if (idea, s) in self.lots:
                    self.lots[(idea, s)].held_days = 0

    def _fill(self, day: str, key: tuple[str, str], qty: float, reason: str, *, cost: float, signal=None) -> None:
        idea, s = key
        price = self.close.get(s, 0.0)
        lot = self.lots.get(key)
        if lot is None:
            lot = self.lots[key] = Lot(idea=idea, security_id=s, entry_date=day, entry_price=price,
                                       entry_value=abs(qty * price), opened=1 if qty > 0 else -1,
                                       signal={"date": signal[3], "score": _r(signal[0], 8), "rank": signal[1],
                                               "of": signal[2]} if signal else None)
        before = lot.shares
        notional = qty * price
        self.cash -= notional + cost
        lot.shares += qty
        lot.net_invested += notional
        lot.commissions += cost
        self._day["costs"] = self._day.get("costs", 0.0) + cost
        self._day["traded"] = self._day.get("traded", 0.0) + abs(notional)
        side = ("buy" if before >= 0 else "cover") if qty > 0 else ("sell" if before > 0 else "short")
        self.orders.append({
            "n": len(self.orders) + 1, "date": day, "fill_date": day, "idea_id": idea, "security_id": s,
            "ticker": self.tickers.get(s), "side": side, "shares": _r(qty, 6), "price": _r(price, 6),
            "notional": _r(notional, 4), "cost": _r(cost, 6), "reason": reason,
            **({"signal": {"date": signal[3], "score": _r(signal[0], 8), "rank": signal[1], "of": signal[2]}}
               if signal else {}),
        })
        if abs(lot.shares) * max(price, 1e-12) < 1e-9:  # closed: the round trip is a trade
            self._close_trade(day, lot, price, reason)
            del self.lots[key]

    def _close_trade(self, day: str, lot: Lot, price: float, reason: str) -> None:
        pnl = -lot.net_invested + lot.dividends - lot.commissions - lot.borrow
        self.trades.append({
            "n": len(self.trades) + 1, "idea_id": lot.idea, "security_id": lot.security_id,
            "ticker": self.tickers.get(lot.security_id), "side": "long" if lot.opened > 0 else "short",
            "entry_date": lot.entry_date, "exit_date": day, "entry_price": _r(lot.entry_price, 6),
            "exit_price": _r(price, 6), "pnl": _r(pnl, 4),
            "return": _r(pnl / lot.entry_value, 8) if lot.entry_value else None,
            "dividends": _r(lot.dividends, 4), "costs": _r(lot.commissions, 4), "borrow": _r(lot.borrow, 4),
            "days_held": lot.sessions, "exit_reason": reason, **({"signal": lot.signal} if lot.signal else {}),
        })

    def lot_return(self, key) -> float | None:
        """A lot's return so far (price, dividends, costs and borrow) on its opening value."""
        lot = self.lots.get(key)
        if not lot or not lot.entry_value:
            return None
        return (self.value(key) - lot.net_invested + lot.dividends - lot.commissions - lot.borrow) / lot.entry_value

    def close_day(self, day: str, sector: dict | None = None) -> tuple[dict, list[dict]]:
        """The portfolio row (with the reconciliation terms) and the positions at the close."""
        nav = self.nav()
        st = self._day
        mv = {k: self.value(k) for k in self.lots}
        long_v = sum(v for v in mv.values() if v > 0)
        short_v = -sum(v for v in mv.values() if v < 0)
        row = {
            "date": day, "nav": nav, "cash": self.cash, "long_value": long_v, "short_value": short_v,
            "gross": (long_v + short_v) / nav if nav > 0 else None, "net": (long_v - short_v) / nav if nav > 0 else None,
            "return": nav / self.nav_prev - 1 if self.nav_prev > 0 else 0.0,
            "price_pnl": st.get("price_pnl", 0.0), "dividends": st.get("dividends", 0.0),
            "costs": st.get("costs", 0.0), "borrow": st.get("borrow", 0.0),
            "turnover": st.get("traded", 0.0) / self.nav_prev if self.nav_prev > 0 else 0.0,
            "positions": len(self.lots),
        }
        positions = [{
            "date": day, "idea_id": k[0], "security_id": k[1], "ticker": self.tickers.get(k[1]),
            "shares": l.shares, "price": self.close.get(k[1]), "value": mv[k],
            "weight": mv[k] / nav if nav > 0 else None, "entry_date": l.entry_date,
            "unrealized_pnl": mv[k] - l.net_invested + l.dividends - l.commissions - l.borrow,
            **({"sector": sector.get(k[1], "Unknown")} if sector is not None else {}),
        } for k, l in sorted(self.lots.items())]
        for l in self.lots.values():
            l.held_days += 1
            l.sessions += 1
        self.nav_prev = nav
        return row, positions


def _price_step(prev: float | None, bar: dict) -> tuple[float | None, float, float]:
    """(close, split ratio, dividend per share) of a bar, consistent with its ret_1d / tr_1d.

    Without a close (or a previous one) the price moves by tr_1d (dividends reinvested, ratio 1).
    """
    close = bar.get("close")
    ret = bar.get("ret_1d")
    tr = bar.get("tr_1d") if bar.get("tr_1d") is not None else ret
    ok = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)  # noqa: E731
    if prev is None or not prev:
        return (float(close) if ok(close) and close > 0 else (1.0 if ok(tr) else None)), 1.0, 0.0
    if not ok(tr):
        return prev, 1.0, 0.0  # no return today: the price holds
    if ok(close) and close > 0 and ok(ret):
        ratio = (1 + ret) * prev / close
        if abs(ratio - 1) < 1e-9:
            ratio = 1.0
        div = (1 + tr) * prev / ratio - close
        if abs(div) < 1e-9 * close:
            div = 0.0
        return float(close), ratio, div
    return prev * (1 + tr), 1.0, 0.0
