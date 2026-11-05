"""Evaluator settings from pipeline/config/backtest.yaml (costs, execution lag, holdout, sizing)."""
from __future__ import annotations

from pathlib import Path

DEFAULTS = {
    "execution_lag_days": 1,
    "commission_bps": 1.0,
    "slippage_bps": 5.0,
    "borrow_cost_bps_default": 50.0,
    "delisting_return": -0.30,
    "holdout_months": 18,
    "trading_days_per_year": 252,
    "sizing": {"gross_limit": 1.0},
    "walk_forward": {"fold": "year", "min_days": 20},
}
_PATH = Path(__file__).resolve().parent.parent / "config" / "backtest.yaml"


def load_config(overrides: dict | None = None) -> dict:
    """backtest.yaml merged over the defaults (PyYAML is in the executor; tests may pass a dict instead)."""
    cfg = {**DEFAULTS, "sizing": dict(DEFAULTS["sizing"]), "walk_forward": dict(DEFAULTS["walk_forward"])}
    try:
        import yaml

        loaded = yaml.safe_load(_PATH.read_text()) or {}
    except (ImportError, OSError):
        loaded = {}
    for src in (loaded, overrides or {}):
        for k, v in src.items():
            if k in ("sizing", "walk_forward") and isinstance(v, dict):
                cfg[k] = {**cfg[k], **v}
            elif k in DEFAULTS:
                cfg[k] = v
    return cfg
