"""Performance metrics on daily simple returns (#104 core; #106 adds the full set). numpy only."""
from __future__ import annotations

import math

import numpy as np

DAYS_PER_YEAR = 252


def _arr(returns) -> np.ndarray:
    a = np.asarray(returns, dtype=float)
    return a[np.isfinite(a)]


def total_return(returns) -> float:
    a = _arr(returns)
    return float(np.prod(1 + a) - 1) if len(a) else 0.0


def cagr(returns, periods: int = DAYS_PER_YEAR) -> float:
    a = _arr(returns)
    if not len(a):
        return 0.0
    growth = float(np.prod(1 + a))
    return growth ** (periods / len(a)) - 1 if growth > 0 else -1.0


def ann_vol(returns, periods: int = DAYS_PER_YEAR) -> float:
    a = _arr(returns)
    return float(np.std(a, ddof=1) * math.sqrt(periods)) if len(a) > 1 else 0.0


def sharpe(returns, periods: int = DAYS_PER_YEAR, rf: float = 0.0) -> float:
    """Annualized Sharpe ratio (mean / sample std of excess daily returns × √periods), as empyrical."""
    a = _arr(returns) - rf / periods
    if len(a) < 2:
        return 0.0
    sd = np.std(a, ddof=1)
    return float(np.mean(a) / sd * math.sqrt(periods)) if sd > 0 else 0.0


def drawdown_series(returns) -> np.ndarray:
    nav = np.cumprod(1 + np.nan_to_num(np.asarray(returns, dtype=float)))
    peak = np.maximum.accumulate(np.concatenate([[1.0], nav]))[1:]
    return nav / peak - 1


def max_drawdown(returns) -> float:
    dd = drawdown_series(returns)
    return float(dd.min()) if len(dd) else 0.0


def summary(returns, periods: int = DAYS_PER_YEAR) -> dict:
    return {
        "total_return": total_return(returns),
        "cagr": cagr(returns, periods),
        "ann_vol": ann_vol(returns, periods),
        "sharpe": sharpe(returns, periods),
        "max_drawdown": max_drawdown(returns),
        "days": int(len(_arr(returns))),
    }
