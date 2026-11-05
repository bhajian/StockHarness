---
name: judge-checklist
description: The Judge's checklist for StockHarness theories. Pre-code review (testability, lookahead, novelty, plausibility) and post-result review (overfitting, factor in disguise, caveats), with how review_theory and set_verdict decide. Use whenever you review a theory or give a verdict (Judge).
---

# Judge checklist

You decide whether a theory is worth coding, and afterwards whether its result holds. Success is mechanical: the
gates decide `successful`, and you may only **downgrade** a passing theory, with reasons. Every decision you make
is stored with your reasoning and shown to people later, so be specific.

## Pre-code review (`review_theory`)

Read the theory with `get_theory`, and check its data with `describe_collection`. Then decide:

1. **Testable.** The signal logic names real collections and fields and a clear ranking rule, horizon and
   direction, and the falsification condition is measurable. If not: `revise`, saying exactly what is missing.
2. **No lookahead.** Every input is known by the rebalance date: filing or acceptance dates, not event dates; no
   current-only fields used historically; no future-dated filters. Fix it with `revise`.
3. **Novel.** `search_theories` for the idea. A near-duplicate of an earlier theory (failed ones included) must say
   what is different (`differs_from`). If it adds nothing: `reject`.
4. **Plausible.** There is a reason it could work (risk premium, behavioral bias, structural flow), and it is not
   data mining a lucky pattern.
5. **Backtestable.** The history exists (check `coverage`). Theories that depend on estimate or consensus
   snapshots are `forward_only`: approve them for paper tracking, not a backtest.

`approve` when all five hold. `reject` (untestable) when it cannot be made testable. Revisions are capped at 3 per
theory; at the cap you must decide.

## Post-result review (`set_verdict`)

Read the evaluation with `get_theory` (and `get_evaluation`). The gates (`GET /research/gates`) are, by default:

- Sharpe ≥ 0.5, deflated Sharpe ≥ 0.95, and ≥ 60% of years with positive excess;
- holdout excess > 0 with Sharpe ≥ 0.3, ≥ 100 trades, ≥ 10 names, and alpha t ≥ 2;
- no blocking warnings.

- **`successful`** is refused unless every gate passes. When the exploration gates pass, your request runs the
  theory's one-shot holdout first.
- **`failed`** is always allowed. Overriding passing gates needs a clear reason, from this list:
  - **Overfitting:** the edge comes from one year, one sector or a handful of names (check by year, by sector and
    trade stats); parameters were tuned across many trials.
  - **A factor in disguise:** high betas to momentum, value, quality or low volatility, with alpha t barely above 2. It is a known factor, not a new idea.
  - **Caveats:** survivorship, backfilled sectors, short history, `extreme_returns` or other warnings that make
    the number unreliable.
  - **Implementation:** turnover too high for its edge, or concentration in illiquid names.
- **`revise`** sends it back to the Coder with a concrete change (one change, stated precisely). It uses one of
  the theory's revisions.

Cite numbers from the evaluation (Sharpe, excess, alpha t, the year or sector you mean) in every verdict.
