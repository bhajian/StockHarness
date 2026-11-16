"""Daily reconciliation of the evaluator with the independent executor (#467).

Both returns are before costs (costs are a separate, shared rule; this checks the return math and the data). A day
breaches when the two differ by more than `day_bps`; the run breaches when their compounded growth drifts apart by
more than `drift_per_year` a year. A breach day lists the names whose contributions differ most, which is where a
data or return-math problem is (an as-paid dividend on a split-adjusted price, a split applied twice, a bad print).
"""
from __future__ import annotations

import math

TOLERANCES = {"day_bps": 5.0, "drift_per_year": 0.01}


def compare(eval_dates: list[str], eval_returns: list[float], executed: dict,
            eval_contrib: dict[str, dict[str, float]], periods: int = 252, tolerances: dict | None = None) -> dict:
    tol = {**TOLERANCES, **(tolerances or {})}
    if executed.get("unavailable"):  # nothing to compare against: say so, it is not a breach
        return {"status": "unavailable", "reason": executed["unavailable"], "days": len(eval_dates), "breach_days": 0,
                "max_daily_bps": None, "drift_per_year": None, "tolerances": tol, "breaches": [],
                "rules": executed.get("rules") or {}}
    ex = dict(zip(executed["dates"], executed["returns"]))
    breaches, worst = [], 0.0
    ge = gx = 1.0
    breach_days = 0
    for d, r in zip(eval_dates, eval_returns):
        x = ex.get(d)
        if x is None:
            breach_days += 1
            breaches.append({"date": d, "missing": "executor"})
            continue
        ge *= 1 + r
        gx *= 1 + x
        diff = x - r
        worst = max(worst, abs(diff))
        if abs(diff) * 1e4 > tol["day_bps"]:
            breach_days += 1
            if len(breaches) < 20:
                a, b = eval_contrib.get(d, {}), executed["contributions"].get(d, {})
                names = sorted(set(a) | set(b), key=lambda s: -abs(b.get(s, 0.0) - a.get(s, 0.0)))[:3]
                breaches.append({"date": d, "evaluator": round(r, 8), "executor": round(x, 8),
                                 "diff_bps": round(diff * 1e4, 2),
                                 "names": [{"security_id": s, "evaluator": round(a.get(s, 0.0), 8),
                                            "executor": round(b.get(s, 0.0), 8)} for s in names]})
    years = max(1.0, len(eval_dates) / periods)
    drift = abs(math.log(gx / ge)) / years if ge > 0 and gx > 0 else float("inf")
    rules = executed.get("rules") or {}
    ok = not breach_days and drift <= tol["drift_per_year"] and not rules.get("violation_count")
    return {"status": "reconciled" if ok else "not_reconciled", "days": len(eval_dates), "breach_days": breach_days,
            "max_daily_bps": round(worst * 1e4, 3), "drift_per_year": round(drift, 6) if math.isfinite(drift) else None,
            "growth": {"evaluator": round(ge, 8), "executor": round(gx, 8)}, "tolerances": tol,
            "breaches": breaches, "rules": rules, "dividends": executed.get("dividends") or {}}
