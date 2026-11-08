"""Options pricing for the trusted evaluator (#327): fixed platform code, no plugin touches it.

- Black-Scholes-Merton with a continuous dividend yield, and its greeks.
- Listed-contract realism: monthly expiries on the third Friday, a strike grid by price level, 100 shares a
  contract, strikes picked by target delta or by moneyness.
- Modeled quotes, when there is no market chain (#326): an implied volatility with a put skew, and a bid/ask
  spread. Buys pay the ask, sells get the bid.
- Expiry settles at intrinsic value; a short call deep enough in the money is assigned the day before an
  ex-dividend date when its time value is below the dividend.

Only math and datetime: the same numbers everywhere, no solver libraries.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta

CONTRACT_SIZE = 100
CALL, PUT = "call", "put"


def _cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _check(kind: str):
    if kind not in (CALL, PUT):
        raise ValueError(f"kind must be {CALL} or {PUT}")


def intrinsic(kind: str, s: float, k: float) -> float:
    _check(kind)
    return max(0.0, s - k) if kind == CALL else max(0.0, k - s)


def _d1d2(s, k, t, r, q, sigma):
    v = sigma * math.sqrt(t)
    d1 = (math.log(s / k) + (r - q + 0.5 * sigma * sigma) * t) / v
    return d1, d1 - v


def price(kind: str, s: float, k: float, t: float, r: float, q: float, sigma: float) -> float:
    """BSM value of a European option; t in years. At or past expiry (t <= 0) or with no volatility: intrinsic
    (discounted forward value for sigma = 0)."""
    _check(kind)
    if s <= 0 or k <= 0:
        raise ValueError("price and strike must be positive")
    if t <= 0:
        return intrinsic(kind, s, k)
    if sigma <= 0:
        fwd = s * math.exp(-q * t) - k * math.exp(-r * t)
        return max(0.0, fwd) if kind == CALL else max(0.0, -fwd)
    d1, d2 = _d1d2(s, k, t, r, q, sigma)
    if kind == CALL:
        return s * math.exp(-q * t) * _cdf(d1) - k * math.exp(-r * t) * _cdf(d2)
    return k * math.exp(-r * t) * _cdf(-d2) - s * math.exp(-q * t) * _cdf(-d1)


@dataclass(frozen=True)
class Greeks:
    delta: float
    gamma: float
    vega: float  # per 1.00 of volatility (divide by 100 for a vol point)
    theta: float  # per year (divide by 365 for a calendar day)


def greeks(kind: str, s: float, k: float, t: float, r: float, q: float, sigma: float) -> Greeks:
    _check(kind)
    if t <= 0 or sigma <= 0:
        itm = (s > k) if kind == CALL else (s < k)
        return Greeks(delta=(1.0 if kind == CALL else -1.0) if itm else 0.0, gamma=0.0, vega=0.0, theta=0.0)
    d1, d2 = _d1d2(s, k, t, r, q, sigma)
    eq, er, sq = math.exp(-q * t), math.exp(-r * t), math.sqrt(t)
    gamma = eq * _pdf(d1) / (s * sigma * sq)
    vega = s * eq * _pdf(d1) * sq
    common = -s * eq * _pdf(d1) * sigma / (2 * sq)
    if kind == CALL:
        return Greeks(delta=eq * _cdf(d1), gamma=gamma, vega=vega,
                      theta=common - r * k * er * _cdf(d2) + q * s * eq * _cdf(d1))
    return Greeks(delta=-eq * _cdf(-d1), gamma=gamma, vega=vega,
                  theta=common + r * k * er * _cdf(-d2) - q * s * eq * _cdf(-d1))


def implied_vol(kind: str, value: float, s: float, k: float, t: float, r: float, q: float,
                lo: float = 1e-4, hi: float = 5.0, tol: float = 1e-8) -> float | None:
    """The volatility that prices the option at `value` (bisection); None when no volatility in [lo, hi] does
    (a quote below intrinsic, or absurdly rich)."""
    if t <= 0:
        return None
    f = lambda v: price(kind, s, k, t, r, q, v) - value  # noqa: E731
    a, b = f(lo), f(hi)
    if a > 0 or b < 0:
        return None
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        m = f(mid)
        if abs(m) < tol:
            return mid
        lo, hi = (mid, hi) if m < 0 else (lo, mid)
    return 0.5 * (lo + hi)


# --- listed contracts ----------------------------------------------------------------------------------------

def third_friday(year: int, month: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(4 - first.weekday()) % 7 + 14)


def monthly_expiries(after: date, months: int = 14) -> list[date]:
    """The monthly expiries (third Fridays) strictly after `after`, for the next `months` months."""
    out, y, m = [], after.year, after.month
    while len(out) < months:
        d = third_friday(y, m)
        if d > after:
            out.append(d)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def pick_expiry(on: date, dte: int, min_dte: int = 7) -> date:
    """The monthly expiry closest to `dte` calendar days away, at least `min_dte` days out."""
    options = [e for e in monthly_expiries(on) if (e - on).days >= min_dte]
    return min(options, key=lambda e: (abs((e - on).days - dte), e))


def strike_step(s: float) -> float:
    """Listed strike spacing by price level (a simplification of exchange rules)."""
    return 1.0 if s < 25 else 2.5 if s < 100 else 5.0 if s < 200 else 10.0


def strike_grid(s: float, width: float = 0.5) -> list[float]:
    """Listed strikes within ±width (a share of the price) of s."""
    step = strike_step(s)
    lo, hi = max(step, math.floor(s * (1 - width) / step) * step), math.ceil(s * (1 + width) / step) * step
    n = int(round((hi - lo) / step))
    return [round(lo + i * step, 4) for i in range(n + 1)]


def strike_by_moneyness(kind: str, s: float, otm: float) -> float:
    """The listed strike nearest to `otm` out of the money (0.05 = 5% above the price for a call, below for a
    put; negative = in the money)."""
    target = s * (1 + otm) if kind == CALL else s * (1 - otm)
    return min(strike_grid(s, width=max(0.5, abs(otm) + 0.1)), key=lambda k: (abs(k - target), k))


# --- modeled quotes ------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class QuoteModel:
    """How modeled option quotes are made from an at-the-money implied volatility (#326)."""
    skew: float = 0.2  # IV rises by skew × ln(S/K) below the money (a put skew), falls above it
    min_iv_ratio: float = 0.5  # the skew never takes IV below this share of the ATM IV …
    max_iv_ratio: float = 3.0  # … or above this multiple
    spread: float = 0.04  # bid/ask spread as a share of the mid
    min_tick: float = 0.05  # and at least this wide (0.01 under $3)


def skewed_iv(atm_iv: float, s: float, k: float, model: QuoteModel = QuoteModel()) -> float:
    iv = atm_iv * (1.0 + model.skew * math.log(s / k))
    return min(max(iv, atm_iv * model.min_iv_ratio), atm_iv * model.max_iv_ratio)


@dataclass(frozen=True)
class Quote:
    bid: float
    ask: float
    mid: float
    iv: float
    delta: float


def quote(kind: str, s: float, k: float, t: float, r: float, q: float, atm_iv: float,
          model: QuoteModel = QuoteModel()) -> Quote:
    iv = skewed_iv(atm_iv, s, k, model)
    mid = price(kind, s, k, t, r, q, iv)
    tick = 0.01 if mid < 3 else model.min_tick
    half = max(tick, mid * model.spread) / 2
    bid = max(0.0, round(mid - half, 4))
    return Quote(bid=bid, ask=round(mid + half, 4), mid=mid, iv=iv, delta=greeks(kind, s, k, t, r, q, iv).delta)


def strike_by_delta(kind: str, s: float, t: float, r: float, q: float, atm_iv: float, target: float,
                    model: QuoteModel = QuoteModel()) -> float:
    """The listed strike whose |delta| is closest to `target` (0.30 = a 30-delta option), on the skewed IV."""
    if not 0 < target < 1:
        raise ValueError("target delta is between 0 and 1 (its absolute value)")
    grid = strike_grid(s, width=0.6)
    return min(grid, key=lambda k: (abs(abs(quote(kind, s, k, t, r, q, atm_iv, model).delta) - target), k))


def years(on: date, expiry: date) -> float:
    """Time to expiry in years (calendar days / 365, at the close)."""
    return max(0, (expiry - on).days) / 365.0


def early_assignment(kind: str, s: float, k: float, t: float, r: float, q: float, iv: float,
                     dividend: float) -> bool:
    """A short call is assigned on the day before an ex-dividend date when it is in the money and its time
    value is less than the dividend (the holder exercises to collect it). Puts are not assigned early here."""
    if kind != CALL or dividend <= 0 or s <= k:
        return False
    time_value = price(CALL, s, k, t, r, q, iv) - (s - k)
    return time_value < dividend
