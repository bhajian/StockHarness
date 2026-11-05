# Strategy plugins and the trusted evaluator (Layer 3)

Agents write the strategy logic; fixed platform code reads the data, walks the dates and scores the result.

## The plugin contract (#103)

A plugin is a short Python module (`pipeline/strategy/contract.py`):

```python
import numpy as np

META = {"side": "long", "horizon_days": 40, "rebalance": "weekly", "top_n": 30}

def universe(ctx):            # optional: security_ids to consider on ctx.date (default: universe_daily)
    ...

def signal(ctx):              # required: score per security_id on ctx.date; higher is better
    f = ctx.read_df("features_ranked", columns=["security_id", "mom_12_1_pct"], lookback_days=7)
    last = f.sort_values("as_of_date").groupby("security_id").tail(1)
    return dict(zip(last.security_id, last.mom_12_1_pct))
```

- `META`: `side` (`long`, `short`, `long_short`), `horizon_days`, `rebalance` (`daily`, `weekly`, `monthly`),
  `top_n`, and optionally `description` and default `params` (read as `ctx.params`).
- Imports are limited to `math`, `statistics`, `numpy`, `pandas`, `datetime`, `collections`, `itertools`,
  `functools`, `typing`, `dataclasses`, `random`, `re`, `bisect`, `heapq` and `operator`. No file or network IO,
  no `eval`/`exec`/`open`/`getattr`, and no private (`_x`) attributes. Every problem is reported with its line.
- The plugin sees data only through `ctx.read_df(collection, filter=None, columns=None, lookback_days=None)`.

## Point-in-time reads

`ctx.read_df` cuts every read at `ctx.date` using the collection's rule from the Schema Catalog
(`packages/core/src/pitPolicy.ts`, mirrored by `pipeline/strategy/known_at.py`):

| Collection                                                                    | Rule                                                                                                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layer 2 outputs (`prices_daily`, `features_ranked`, …)                        | `as_of_date <= ctx.date`                                                                                                                                 |
| `corporate_actions`                                                           | `known_at`, usable from the next session                                                                                                                 |
| Layer 1 collections                                                           | their known-at rule (#84), e.g. `insider_trades.filingDate`, statements' `acceptedDate` with the 45/90-day fallback, end-of-day prices on their own date |
| `trading_calendar`, `securities`                                              | static, uncut                                                                                                                                            |
| current-only (`company_profiles`, `universe`, …) and undocumented collections | refused                                                                                                                                                  |

Layer 2 is optional: a plugin may read Layer 1 collections directly and gets the same guarantee. Each returned
frame has an `as_of_date` column. A filter that asks for dates after `ctx.date` simply returns nothing (and is
counted as a lookahead attempt). `$where` and other server-side JavaScript are refused.

## StrategyPlugin objects

Plugins are stored as versioned `StrategyPlugin` objects (`/api/strategy-plugins`). Every saved change is a new
version, and the `sha256:` hash of the code pins what an evaluation ran. YAML export keeps the code verbatim
with its hash, optionally with the full version history (`?history=1`); import refuses a spec whose hash does not
match its code.

## The trusted evaluator (#104)

`pipeline/strategy/engine.py` is fixed, versioned platform code (`EVALUATOR_VERSION`). For a plugin version and
`params` (`start`, `end`, optional `symbols` scope, `side`/`top_n`/`rebalance` overrides, `plugin_params`):

1. It walks the rebalance dates (`daily`, the first session of each week, or of each month) and calls
   `signal(ctx)` with data cut at that date. The default universe is `universe_daily.in_universe` that day.
2. The book is equal weight: the `top_n` highest scores (long), the lowest (short) or both (`long_short`, half
   the gross each side). Gross is `sizing.gross_limit`.
3. Trades execute at the close `execution_lag_days` sessions later (the next day's close), paying
   `commission_bps + slippage_bps` on the traded weight. Only names with a price that day are traded.
4. Weights drift on daily total returns (`prices_daily.tr_1d`); shorts pay `borrow_cost_bps_default` a year; a
   held name whose prices stop and that is no longer active takes `delisting_return` once.

Costs come from `pipeline/config/backtest.yaml`. The result is an `evaluations` record: the plugin hash and
version, params, costs, data snapshot, evaluator version, summary numbers, series in the standard
`{ dates, series }` chart format, rebalances and the final holdings. `record_hash` covers all of it, so the same
inputs give an identical record. Every evaluation increments the workspace's global trial count.

Run one with `POST /api/evaluations` `{ plugin, version?, params }` (202; poll `GET /api/evaluations/:id`).
