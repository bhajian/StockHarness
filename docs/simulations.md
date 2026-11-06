# Simulations (M6)

A simulation runs one or more ideas as **one book** through the **paper broker**, with real shares and cash. The
same broker will run the live paper book in M7.

## The paper broker (#124)

`pipeline/strategy/broker.py` is a share-and-cash ledger, stepped one trading session at a time:

1. **Open the day.** Borrow is charged on yesterday's short value. Each held name then gets its split and
   dividend, and is marked to the close. A held name that stops trading and is no longer active is delisted: it
   closes at its last price times (1 + `delisting_return`).
2. **Exits.** An exit decided earlier fills at today's close.
3. **Rebalance.** Each idea that rebalances today trades to its target weights at today's close.
4. **Close the day.** Write the portfolio row and the positions.

**Prices** come from `prices_daily` (`close`, `ret_1d`, `tr_1d`). The day's split ratio and dividend per share are
recovered exactly as the prices transform computed them (`tr_1d = ((close + div) · ratio) / prev − 1`). So:

- splits adjust share counts;
- dividends credit cash, and debit cash for shorts. With `dividends: reinvest` (the default) a long lot's dividend
  then buys more of the stock at that close, at no cost (a fill with reason `dividend`), as the evaluator's
  `tr_1d` assumes. With `dividends: cash` it stays in cash until the next rebalance;
- the ledger follows the same total returns as the evaluator.

**Costs** follow the evaluator's rule: commission plus slippage on the traded value at the pre-trade NAV, with the
targets sized on the NAV after costs.

**Every day reconciles**, and each simulation reports the largest error of each check
(`reconciliation.max_nav_error`, `reconciliation.max_pnl_error`):

- NAV = cash + market value;
- the change in NAV = price P&L + dividends − costs − borrow.

### Parity with the evaluator

Each idea's books come from the evaluator's own signal walk (`engine.plan_books`). With the default settings
(equal weight, dividends reinvested, a name exits only when a rebalance replaces it), a one-idea simulation
reproduces the evaluation's equity curve:

- **Long-only books** match to 1e-9, dividends and splits included.
- **Books with shorts** match to about 1e-4. The evaluator normalises weights before borrow, which is a second-order
  difference.
- **`dividends: cash`** leaves a small, real gap: the dividend misses the stock's moves until the next rebalance.
  On live data that was 2e-4 to 5e-4 of equity over a year (#288).

### Settings

| Setting                     | Default              | Options                                                                                                                                                                                 |
| --------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capital`                   | 1,000,000            |                                                                                                                                                                                         |
| `allocation.mode`           | `equal`              | `risk_parity` (inverse trailing 63-day volatility of each idea's book), `custom` (`weights` by idea id; a total under 1 leaves cash)                                                    |
| `sizing.mode`               | `equal`              | `quarter_kelly`: 0.25 · shrunk mean / variance of the idea's own book returns up to the day before. The mean is shrunk by n / (n + 252); with fewer than 63 days the size is `fallback` |
| `constraints.position_cap`  | none                 | e.g. 0.05                                                                                                                                                                               |
| `constraints.sector_cap`    | none                 | e.g. 0.25                                                                                                                                                                               |
| `constraints.gross` / `net` | 1.0 / none           |                                                                                                                                                                                         |
| `exits.stop`                | none                 | e.g. 0.15: exit at −15% on the lot (price, dividends, costs and borrow)                                                                                                                 |
| `exits.take_profit`         | none                 | a return (0.25), or `"p90"`: the 90th percentile of the idea's trades closed so far (from 20 trades on)                                                                                 |
| `exits.horizon`             | off                  | exit after `META.horizon_days` sessions without a rebalance keeping the name                                                                                                            |
| `exits.review`              | on                   | calls the plugin's optional `review(ctx, held) → {security_id: "invalidation" \| "p_outperform"}` daily                                                                                 |
| `dividends`                 | `reinvest`           | `cash`: keep long dividends in cash until the next rebalance                                                                                                                            |
| `hard_to_borrow`            | `[]`                 | security ids never shorted (also `securities.hard_to_borrow: true`)                                                                                                                     |
| `costs`                     | from `backtest.yaml` | `commission_bps`, `slippage_bps`, `borrow_cost_bps_default`, `delisting_return`, `execution_lag_days`                                                                                   |
| `seed`                      | 0                    | part of the config and the ledger hash                                                                                                                                                  |

**Exits** are decided at a close and filled `execution_lag_days` later.

- A name that exits is not bought back until a signal dated after the exit.
- If a rebalance sells a name before its exit fills, the sale carries the exit's reason.

**Exit reasons:**

- `replaced`: the rebalance dropped the name.
- `rebalance`: a resize.
- `stop`, `take_profit`, `horizon`, `invalidation`, `p_outperform`: the exit rules above.
- `delisted`: the company is gone.
- `no_price`: no price at a rebalance, so sold at the last close.
- `open`: still held at the end, marked to market.

### The ledger

The ledger lives in the workspace database, keyed by `simulation_id`:

| Collection            | One row per                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `sim_orders`          | fill: idea, security, ticker, side, shares, price, notional, cost, reason, and the signal (date, score, rank of N) that led to it          |
| `sim_trades`          | round trip: entry and exit, P&L, return, dividends, costs, borrow, sessions held, exit reason, entry signal                                |
| `sim_portfolio_daily` | session: NAV, cash, long and short value, gross, net, return, and the reconciliation terms (price P&L, dividends, costs, borrow), turnover |
| `sim_positions`       | (session, idea, security): shares, price, value, weight, unrealized P&L, sector                                                            |

Each order and trade carries the idea's id, which links to the idea page (`/ideas/T-n`): its debate, code and
evaluations.

`ledger_hash` covers the whole ledger, so the same config and seed give the same hash.

The executor job is `pipeline.strategy.job` with `action: "simulate"`. Its tests are in
`pipeline/tests/test_paper_broker.py`.

## Simulation runs and the API (#125)

A **SimulationConfig** is a named, saved definition. A **run** freezes its config and starts the executor job.

When you save a config, each idea's plugin version is pinned (its latest version that passed its test). If no
symbols are given, the research settings' evaluation symbols are used. So a re-run, or a re-import, runs the same
code on the same scope, and the same config gives the same ledger (`ledger_hash`).

The period may not reach into the locked holdout unless `period.allowHoldout` is set. A run that does is marked
`usesHoldout`.

| Method and path                        | What it does                                                                                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /simulations/estimate`           | the resolved config (pinned versions, symbols) and the runtime estimate: time per session from this workspace's earlier simulations, or from the ideas' evaluations without the job start-up |
| `POST /simulations` (admin)            | save the config by name and start a run (202 with the id and estimate)                                                                                                                       |
| `GET /simulations`                     | runs, newest first: name, ideas, period, status, CAGR, Sharpe, max drawdown, final NAV, created, by                                                                                          |
| `GET /simulations/configs`             | saved configs                                                                                                                                                                                |
| `GET /simulations/:id`                 | the run: frozen config, status, result (summary, excess, series, monthly returns, attribution, reconciliation, counts, ledger hash)                                                          |
| `GET /simulations/:id/series?metric=`  | one series: `equity`, `nav`, `drawdown`, `rolling_sharpe_126`, `gross`, `net`, `long`, `short`, `cash`, `returns`, `spx_equity`                                                              |
| `GET /simulations/:id/trades`          | the blotter (`idea`, `reason`, `side`, `security`, `sort=recent\|oldest\|pnl\|worst\|return`, `limit`, `offset`)                                                                             |
| `GET /simulations/:id/trades/:n`       | one trade with its fills and the prices around it                                                                                                                                            |
| `GET /simulations/:id/orders`          | the fills (`idea`, `security`, `date`)                                                                                                                                                       |
| `GET /simulations/:id/positions?date=` | the book at the close of the last session on or before `date`                                                                                                                                |
| `GET /simulations/:id/export`          | the run and its config as YAML                                                                                                                                                               |
| `DELETE /simulations/:id` (admin)      | the run and its ledger                                                                                                                                                                       |

A config, as sent to `POST /simulations`:

```yaml
name: Momentum + reversal
ideas: [{ idea: T-1 }, { idea: T-2 }] # plugin and version are pinned when saved
period: { start: 2016-01-04, end: 2025-12-31, allowHoldout: false }
capital: 1000000
allocation: risk_parity # equal | risk_parity | custom (ideas[].weight)
sizing: { mode: quarter_kelly, kellyFraction: 0.25 } # or equal
constraints: { positionCap: 0.05, sectorCap: 0.3, gross: 1, net: null }
exits: { stop: 0.15, takeProfit: p90, horizon: true, review: true }
costs: { commissionBps: 1, slippageBps: 5, borrowBps: 50, executionLagDays: 1 }
hardToBorrow: []
dividends: reinvest # or cash
seed: 0
```

### YAML

- **`SimulationConfig`** is configuration. Its spec is the definition: ideas by `T-n` with plugin name and version,
  plus period, capital, allocation, sizing, constraints, exits, costs, hard-to-borrow and seed. It round-trips, and
  it is part of the config backup (`simulation-configs.yaml`).
- **`SimulationRun`** is a record: the config by value, the status and the result, restored as it was and never
  re-run. The ledger rows are not part of the export; re-running the config rebuilds them identically.

Both are covered by the round-trip test in `tests/integration/simulations.test.ts` (export, import into an empty
workspace, export again, identical YAML).
