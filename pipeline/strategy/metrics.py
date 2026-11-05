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


def folds(dates: list[str], returns, min_days: int = 20, periods: int = DAYS_PER_YEAR) -> list[dict]:
    """Walk-forward results per calendar year (#105): each year is scored on its own returns only."""
    by_year: dict[str, list[int]] = {}
    for i, d in enumerate(dates):
        by_year.setdefault(d[:4], []).append(i)
    out = []
    r = list(returns)
    for year in sorted(by_year):
        idx = by_year[year]
        seg = [r[i] for i in idx]
        out.append({"fold": year, "start": dates[idx[0]], "end": dates[idx[-1]], "partial": len(idx) < min_days,
                    **summary(seg, periods)})
    return out


# --- #106: the full set ----------------------------------------------------------------------------------------
def sortino(returns, periods: int = DAYS_PER_YEAR) -> float:
    """Annualized mean over annualized downside deviation (target 0), as empyrical.sortino_ratio."""
    a = _arr(returns)
    if len(a) < 2:
        return 0.0
    dd = math.sqrt(float(np.mean(np.minimum(a, 0.0) ** 2))) * math.sqrt(periods)
    return float(np.mean(a) * periods / dd) if dd > 0 else 0.0


def calmar(returns, periods: int = DAYS_PER_YEAR) -> float:
    mdd = max_drawdown(returns)
    return cagr(returns, periods) / abs(mdd) if mdd < 0 else 0.0


def hit_rate(returns) -> float:
    """Share of non-zero days that were positive."""
    a = _arr(returns)
    a = a[a != 0]
    return float(np.mean(a > 0)) if len(a) else 0.0


def _moments(a: np.ndarray) -> tuple[float, float]:
    """Skewness and (non-excess) kurtosis, population moments."""
    sd = np.std(a)
    if sd == 0 or len(a) < 3:
        return 0.0, 3.0
    z = (a - np.mean(a)) / sd
    return float(np.mean(z ** 3)), float(np.mean(z ** 4))


def excess(returns, bench, periods: int = DAYS_PER_YEAR) -> dict:
    """Against a benchmark on the same days: CAGR difference, tracking error, information ratio."""
    r = np.asarray(returns, dtype=float)
    b = np.asarray(bench, dtype=float)
    ok = np.isfinite(r) & np.isfinite(b)
    r, b = r[ok], b[ok]
    if len(r) < 2:
        return {"excess_cagr": 0.0, "tracking_error": 0.0, "information_ratio": 0.0, "days": int(len(r))}
    d = r - b
    te = float(np.std(d, ddof=1) * math.sqrt(periods))
    return {"excess_cagr": cagr(r, periods) - cagr(b, periods), "tracking_error": te,
            "information_ratio": float(np.mean(d) / np.std(d, ddof=1) * math.sqrt(periods)) if te > 0 else 0.0,
            "days": int(len(r))}


def ols(y, X: dict, lags: int = 5, periods: int = DAYS_PER_YEAR) -> dict:
    """y on an intercept + the named factors, with Newey-West (HAC) t-stats.

    alpha_annual is (1 + alpha_daily)^periods - 1, as empyrical.alpha_beta.
    """
    names = list(X)
    y = np.asarray(y, dtype=float)
    cols = [np.asarray(X[n], dtype=float) for n in names]
    ok = np.isfinite(y)
    for c in cols:
        ok &= np.isfinite(c)
    y = y[ok]
    A = np.column_stack([np.ones(len(y))] + [c[ok] for c in cols])
    if len(y) <= A.shape[1] + 2:
        return {"alpha_daily": 0.0, "alpha_annual": 0.0, "alpha_t": 0.0, "betas": {}, "t": {}, "r2": 0.0, "days": int(len(y))}
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    resid = y - A @ coef
    n, k = A.shape
    XtX_inv = np.linalg.pinv(A.T @ A)
    S = (A * resid[:, None]).T @ (A * resid[:, None])
    for lag in range(1, min(lags, n - 1) + 1):
        w = 1 - lag / (lags + 1)
        G = (A[lag:] * resid[lag:, None]).T @ (A[:-lag] * resid[:-lag, None])
        S += w * (G + G.T)
    cov = XtX_inv @ S @ XtX_inv * n / max(1, n - k)
    se = np.sqrt(np.maximum(np.diag(cov), 0))
    t = [float(c / s) if s > 0 else 0.0 for c, s in zip(coef, se)]
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    return {
        "alpha_daily": float(coef[0]), "alpha_annual": float((1 + coef[0]) ** periods - 1), "alpha_t": t[0],
        "betas": {nm: float(c) for nm, c in zip(names, coef[1:])}, "t": {nm: tv for nm, tv in zip(names, t[1:])},
        "r2": 1 - float(np.sum(resid ** 2)) / ss_tot if ss_tot > 0 else 0.0, "days": int(n),
    }


# Deflated Sharpe ratio (Bailey & López de Prado, 2014). Sharpe ratios here are per period (not annualized).
_EULER = 0.5772156649015329


def _norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _norm_ppf(p: float) -> float:
    from statistics import NormalDist

    return NormalDist().inv_cdf(p)


def expected_max_sharpe(n_trials: int, sr_variance: float) -> float:
    """E[max SR] of n independent trials whose Sharpe ratios have this variance (the false-discovery bar)."""
    if n_trials < 2 or sr_variance <= 0:
        return 0.0
    return math.sqrt(sr_variance) * ((1 - _EULER) * _norm_ppf(1 - 1 / n_trials)
                                     + _EULER * _norm_ppf(1 - 1 / (n_trials * math.e)))


def probabilistic_sharpe(sr: float, sr0: float, t: int, skew: float, kurt: float) -> float:
    """P(true SR > sr0) given an observed per-period SR over t observations with these moments."""
    if t < 2:
        return 0.0
    denom = 1 - skew * sr + (kurt - 1) / 4 * sr ** 2
    return _norm_cdf((sr - sr0) * math.sqrt(t - 1) / math.sqrt(denom)) if denom > 0 else 0.0


def deflated_sharpe(returns, n_trials: int, sr_variance: float | None) -> dict:
    """DSR: the probabilistic Sharpe against the expected maximum of all trials run so far."""
    a = _arr(returns)
    sd = np.std(a, ddof=1) if len(a) > 1 else 0.0
    sr = float(np.mean(a) / sd) if sd > 0 else 0.0
    skew, kurt = _moments(a)
    sr0 = expected_max_sharpe(n_trials, sr_variance or 0.0)
    return {"dsr": probabilistic_sharpe(sr, sr0, len(a), skew, kurt), "sr_per_period": sr, "sr0": sr0,
            "trials": int(n_trials), "sr_variance": sr_variance, "skew": skew, "kurtosis": kurt, "t": int(len(a))}


def rolling_sharpe(returns, window: int = 126, periods: int = DAYS_PER_YEAR) -> list[float | None]:
    a = np.nan_to_num(np.asarray(returns, dtype=float))
    out: list[float | None] = []
    for i in range(len(a)):
        if i + 1 < window:
            out.append(None)
            continue
        seg = a[i + 1 - window: i + 1]
        sd = np.std(seg, ddof=1)
        out.append(float(np.mean(seg) / sd * math.sqrt(periods)) if sd > 0 else 0.0)
    return out


def histogram(values, edges: list[float]) -> dict:
    """Counts per bin; values below / above the edges go into the first / last bin."""
    v = np.clip(np.asarray(values, dtype=float), edges[0], edges[-1])
    counts, _ = np.histogram(v, bins=edges)
    return {"edges": edges, "counts": [int(c) for c in counts]}
