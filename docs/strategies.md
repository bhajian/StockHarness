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

## Walk-forward folds and the locked holdout (#105)

- **Folds:** every record has `folds`, the metrics of each calendar year of the evaluation window scored on its
  own returns (`walk_forward` in `backtest.yaml`; short years are marked `partial`). Plugins are rules, not fitted
  models, so a fold is an out-of-sample year rather than a refit.
- **Holdout:** the last `holdout_months` (18) of price history are locked. The boundary is set per workspace on
  first use from the latest `prices_daily` date and then stays fixed (`GET /api/evaluator/settings`), so data
  never drifts out of the holdout. Exploration evaluations must end before it, and their reads are cut at the
  day before it (fundamentals and every other collection included).
- **One shot:** `POST /api/evaluations/holdout { plugin, version?, theoryId? }` scores the holdout period once per
  theory (or plugin) and code version. The claim is recorded before the run starts, so a second attempt is refused
  (409) even if the first one failed. A new code version is a new shot. The holdout length can change only until
  the first holdout run.

## Metrics (#106)

`pipeline/strategy/metrics.py` (numpy only; checked against empyrical and the published deflated-Sharpe example):

- **summary:** total return, CAGR, volatility, Sharpe, Sortino, max drawdown, Calmar, daily hit rate, turnover per
  rebalance and per year, costs and borrow paid.
- **excess:** against the S&P 500 and against a sector benchmark (the same weights earning their sector's
  equal-weight return): excess CAGR, tracking error, information ratio.
- **by year** (`folds`) and **by regime:** trend (S&P 500 above / below its 200-day average) and volatility
  (VIX ≥ 25).
- **factors:** the daily returns regressed on the market and long-short factors built from `features_ranked`
  (`factors` in `backtest.yaml`): betas, Newey-West t-stats, alpha (annualized like empyrical) and its t-stat.
- **by sector** contributions, **trade stats** (each holding from entry to exit: count, win rate, mean,
  median, histogram).
- **series:** equity, S&P 500 equity, drawdown, rolling 126-day Sharpe, returns, gross, turnover.
- **trial_context:** the deflated Sharpe ratio (Bailey & López de Prado) against the expected maximum Sharpe of
  all trials the workspace has run (the global trial count and the variance of their Sharpe ratios). It changes
  as the swarm runs more trials, so it sits outside `record_hash`.

## Research data tools over MCP (#108)

Add **Connections → Connect an MCP server → StockHarness research data (built in)**. The installation serves it at
`/mcp/research` (Streamable HTTP); the runtime authenticates with a token that names the connection and is signed
for its workspace. Tools:

- `list_collections`: collections with layer, size, point-in-time status and whether they are readable.
- `describe_collection`: the Schema Catalog agent view (the same text as Catalog → Agent view).
- `sample_collection`: the latest rows known by the session as_of.
- `query_collection(collection, filter, fields, sort, limit, as_of)`: at most 500 rows and 256 KB. Every row
  carries its `as_of_date`.

The **session as_of** is the connection's fixed date (optional), else the latest trading date, and never later than
the day before the locked holdout. It is applied on the server: a call may pass an earlier `as_of`, never a later
one. Collections are cut by the same policy as `ctx.read_df`, so Layer 1 collections are served directly with
their known-at rule. Current-only and undocumented collections are refused (current-only only opens when the session
is at the latest date and there is no holdout). `$where`, `$function` and `$accumulator` are refused. The fuzz
test (`tests/integration/data-tools.test.ts`) checks that no tool returns a row known after the session as_of.

## evaluate_strategy and the evaluation page (#109)

The research MCP connection also serves:

- `evaluate_strategy(plugin, version?, theory_id?, params)`: runs the trusted evaluator in the executor on a saved
  plugin version (exploration only, before the holdout), counts a trial, stores the full record and returns a
  compact summary: summary metrics, by year, excess, factor exposures, the deflated Sharpe and warnings, with
  `page: /evaluations/<id>`. It waits up to 50 s; if the run is still going, call `get_evaluation(evaluation_id)`.
- `get_evaluation(evaluation_id)`.

`/evaluations` (dev view, not in the navigation) lists evaluations, and `/evaluations/<id>` renders one: KPIs,
equity against the S&P 500, drawdown, rolling Sharpe, return by year, trade returns, folds, factor exposures,
regimes, sector contributions and provenance.

**`Evaluation` objects** export (Objects API `?kinds=Evaluation&names=<id>`, or the page's Export) for audit and
sharing. Import restores the record with its provenance (code hash, data snapshot, evaluator version) and never
re-runs anything. Existing records are immutable, and a record whose `plugin.hash` disagrees with its `codeHash`
is refused. Evaluations are records, not configuration, so they are not part of the repo config backup.
