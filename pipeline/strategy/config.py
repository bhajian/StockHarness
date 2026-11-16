"""Evaluator settings from pipeline/config/backtest.yaml (costs, execution lag, holdout, sizing)."""
from __future__ import annotations

from pathlib import Path

DEFAULTS = {
    "execution_lag_days": 1,
    "commission_bps": 1.0,
    "slippage_bps": 5.0,
    "borrow_cost_bps_default": 50.0,
    "delisting_return": -0.30,  # the old flat value; `delisting` replaces it (#448)
    "delisting": {"merger": 0.0, "distress": -0.55, "unknown": -0.30, "short": 0.0},
    # #452: market impact at an assumed book size (pipeline/strategy/costs.py).
    "impact": {"aum": 10_000_000.0, "coef": 1.0, "max_impact": 0.05, "max_participation": 0.1, "vol_days": 21},
    # #465: every book is capped per name and per sector (the excess stays in cash).
    "evaluation_caps": {"max_weight": 0.10, "sector_cap": 0.30},
    # #466: turnover controls (pipeline/strategy/costs.py TURNOVER).
    "turnover": {"rank_buffer": 1.5, "reentry_cooldown_days": 10},
    "holdout_months": 18,
    "trading_days_per_year": 252,
    "sizing": {"gross_limit": 1.0},
    "walk_forward": {"fold": "year", "min_days": 20},
    # Long-short factors for the exposure regression (#106): name -> features_ranked field.
    "factors": {"momentum": "mom_12_1_pct", "value": "value_score", "quality": "quality_score", "low_vol": "low_vol_score"},
    "benchmark_max_names": 600,
}
_PATH = Path(__file__).resolve().parent.parent / "config" / "backtest.yaml"


def load_config(overrides: dict | None = None) -> dict:
    """backtest.yaml merged over the defaults (PyYAML is in the executor; tests may pass a dict instead)."""
    cfg = {**DEFAULTS, "sizing": dict(DEFAULTS["sizing"]), "walk_forward": dict(DEFAULTS["walk_forward"]),
           "delisting": dict(DEFAULTS["delisting"]), "impact": dict(DEFAULTS["impact"]),
           "turnover": dict(DEFAULTS["turnover"]), "evaluation_caps": dict(DEFAULTS["evaluation_caps"])}
    try:
        import yaml

        loaded = yaml.safe_load(_PATH.read_text()) or {}
    except (ImportError, OSError):
        loaded = {}
    for src in (loaded, overrides or {}):
        for k, v in src.items():
            if k in ("sizing", "walk_forward", "factors", "delisting", "impact", "turnover", "evaluation_caps") and isinstance(v, dict):
                cfg[k] = {**cfg[k], **v}
            elif k in DEFAULTS or k == "benchmark_max_names":
                cfg[k] = v
    return cfg
