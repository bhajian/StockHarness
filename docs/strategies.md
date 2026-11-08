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

## Results by name (#324)

Every record has `by_name`: for each security the book held, its contribution to the book's return (daily weight ×
return, before costs; the names add up to `by_sector`), its contribution by calendar year, days held long and
short, average weight, trades with their hit rate and average return, ticker and sector. Rows are sorted best
first; above 1,000 names only the best and worst 500 are kept (`truncated` says how many were left out). The
summary says how many names added to and took away from the return, and `top_decile_share_of_gains`: the share
of the gains made by the best 10% of names (near 1 means a few names carry the result).

`by_name` is derived from the same inputs but sits outside `record_hash`, so evaluations made before it existed
still reproduce. `get_evaluation` gives agents the five best and worst names; the evaluation and idea pages show
the full table (sortable, searchable). Picking the best names from this table is not a result by itself: name
subsets are picked and checked on different periods (#325).

## Name subsets (#325)

Which names of the scope does a strategy work for (say 20 of the S&P 500)? Picking the best names on the data
that scores them always finds some, so a subset search (`POST /api/evaluations/:id/subset`, or **Find the
names** on an evaluation or idea page) splits the evaluation's window:

1. **Pick** on the first part (`pick_fraction`, 2/3): the strategy runs on its whole scope; names held at least
   `min_days` (10) days with a positive contribution are ranked by `metric` (`contribution`, `avg_trade_return`
   or `hit_rate`) and the best `top_k` (20) are chosen.
2. **Check** on the rest: the same plugin runs on only the chosen names (holding at most half of them at a time,
   so the signal still chooses), and also on the whole scope and on `n_random` (40, at least 19) random sets of
   the same size drawn from the names the pick period held. Random sets are seeded from the plugin hash and
   params: the same inputs give the same record.
3. It is **shown** when the chosen names' Sharpe beats the random sets with p ≤ 0.05 (p = (1 + random sets at
   or above it) / (1 + n)) and is positive.

The record is the check run (out of sample), with `subset` saying how it was picked and how it compares. The
search is one trial. It must start from a succeeded exploration that ends before the holdout. A subset that is
shown can then become its own idea, checked once on the holdout on those names (#325, next step).

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

## Run–test–fix loop for agent code (#153)

- **Readable `run_python` errors:** a failed job comes back with `failure: { type, message, lines }`, the traceback
  trimmed to the agent's own `main.py` frames with the code on each line. On a `KeyError` or `AttributeError` it
  also lists the catalog fields of the collections the job read.
- **`test_strategy(code, plugin?, note?, symbols?, dates?)`** (research MCP): a dry run through the evaluator's
  as_of reader on about 20 symbols × 4 dates before the holdout. It returns the error (type, message, the
  plugin's line numbers, and the real columns for a missing one) or a sanity summary: names scored per date,
  NaNs, non-numeric and unknown names, and warnings (`empty_signal`, `lookahead_blocked`, `nan_scores`,
  `unknown_names`, `constant_scores`). It never returns performance numbers and is not a trial.
- **History:** with `plugin`, every attempt is saved as that plugin's next version with its outcome (`error` or
  `tested: passed`), so Ideas → Code can show the diffs. The response counts consecutive failed attempts; after
  5 it says to hand the plugin to the Judge.
- The loop and its rules are in the `strategy-library` skill: check columns, use the known-at field, test on one
  date first, fix, then `evaluate_strategy` once. A failing gate goes to the Judge, not back into the fix loop.

## Collection-scoped MongoDB tools for any harness (#148)

On the harness canvas, open a MongoDB tools resource and **Bind a collection**. Each binding has:

- **permissions:** `read` (find, aggregate, count, schema), `insert`, `update` and/or `delete`;
- optional **limits:** max rows per read, only these fields, and a fixed filter;
- **enforce as of:** reads are cut at the session as_of with the collection's known-at rule (conservatively, so a
  borderline row waits a day rather than leaking);
- **approve writes:** inserts, updates, deletes and `$out`/`$merge` wait for a human.

The runtime enforces bindings on every call:

- Only granted operations are offered. Admin tools (drop, rename, create or drop index, create collection) and
  database-wide tools (`list-collections`, `db-stats`) are never available through a binding.
- `collection` is an enum of the bound collections, and the tool description lists their fields.
- A call to an unbound collection, or above its permission, gets an error the agent can act on.
- `$lookup`, `$graphLookup` and `$unionWith` must stay in the bound set (and never join into a filtered or as-of
  binding), and `$out`/`$merge` need write.
- The fixed filter, projection, row cap and as_of cut go on the wire; the trace records the collection.

Bindings live on the agent's connection binding, so they are part of the run snapshot and of the Agent and Harness
YAML (connections by name). Without bindings, a MongoDB connection keeps its database-wide grant, and the canvas
warns about it. The **Data chatbot** template binds `prices_daily`, `features_daily`, `securities` and `signals`
read-only (200 rows a read).

## Sanity suite: the M3 exit gate (#107)

`sh scripts/check-evaluator.sh` runs the evaluator's unit tests and `python3 -m pipeline.strategy.sanity`
(`pipeline/strategy/sanity.py`):

1. **Random signal:** a random long-short book over 20 seeds has a mean Sharpe within ±0.5, and no seed beyond ±2.5.
2. **12-1 momentum shows the 2022 drawdown** (real data): `MOMENTUM_12_1` evaluated over 2021-07-01 → 2023-06-30
   must lose money in 2022 with a drawdown of at least 10% (`sanity.momentum_2022(record)`).
3. **Lookahead canary:** a plugin that asks for tomorrow's returns scores about 0 behind the reader. With the cut
   switched off the same plugin scores a Sharpe far above 5, so the check has teeth.
4. **Reproducibility:** re-running gives an identical record.

Hosted CI stays off unless enabled (#33); run it locally.
