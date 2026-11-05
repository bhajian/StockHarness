---
name: write-a-strategy-plugin
description: How to write, test and fix a StockHarness strategy plugin (META, signal(ctx), ctx.read_df) for the trusted evaluator, with worked examples and the submit_code / test_strategy / evaluate_strategy loop. Use whenever you write or fix strategy code (Coder).
---

# Write a strategy plugin

A plugin is short Python that the trusted evaluator runs. You write the logic; the platform reads the data
point-in-time, builds the book, trades at the next close, charges costs and scores it. You never compute
returns, costs or weights yourself.

## The contract

```python
import numpy as np

META = {"side": "long", "horizon_days": 21, "rebalance": "monthly", "top_n": 10}

def universe(ctx):        # optional: security_ids to consider on ctx.date (default: ctx.universe_ids)
    ...

def signal(ctx):          # required: {security_id: score} on ctx.date; higher = more bullish
    ...
```

- `META`: `side` is `long`, `short` or `long_short` (half the book each side); `horizon_days`; `rebalance` is
  `daily`, `weekly` (first session of the week) or `monthly`; `top_n`. Optional: `description`, and `params`
  (defaults you read as `ctx.params`).
- `ctx.date` is the rebalance date (YYYY-MM-DD). `ctx.universe_ids` are the in-universe names that day.
  `ctx.days_ago(n)` and `ctx.trading_days_ago(n)` give earlier dates.
- `ctx.read_df(collection, filter=None, columns=None, lookback_days=None)` returns a pandas DataFrame of the rows
  **known by ctx.date**, each with an `as_of_date` column. `lookback_days` keeps only rows that became known in
  the last N calendar days. It is the only way to read data.
- Imports: `math`, `statistics`, `numpy`, `pandas`, `datetime`, `collections`, `itertools`, `functools`, `random`,
  `re`, `typing`, `dataclasses`, `bisect`, `heapq`, `operator`. No files, no network, no `eval`/`exec`/`open`/
  `getattr`, and no private (`_x`) attributes. Every violation is reported with its line.
- Return scores, not weights. Only names you would hold need a score; NaN and non-numeric scores are ignored.

## Worked examples

**Layer 2 feature (12-1 momentum):**

```python
META = {"side": "long", "horizon_days": 21, "rebalance": "monthly", "top_n": 10}

def signal(ctx):
    f = ctx.read_df("features_ranked", columns=["security_id", "mom_12_1_pct"], lookback_days=7)
    last = f.dropna().sort_values("as_of_date").groupby("security_id").tail(1)
    return dict(zip(last.security_id, last.mom_12_1_pct))
```

**Prices (40-day trend, long/short):**

```python
import numpy as np

META = {"side": "long_short", "horizon_days": 20, "rebalance": "weekly", "top_n": 20}

def signal(ctx):
    px = ctx.read_df("prices_daily", columns=["security_id", "tr_1d"], lookback_days=60)
    return {s: float(np.prod(1 + g.tr_1d.tail(40)) - 1) for s, g in px.groupby("security_id") if len(g) >= 35}
```

**Layer 1 read directly (insider buying, by symbol), mapped to security_id with prices_daily's ticker:**

```python
META = {"side": "long", "horizon_days": 60, "rebalance": "monthly", "top_n": 15}

def signal(ctx):
    ins = ctx.read_df("insider_trades", {"acquisitionOrDisposition": "A"},
                      columns=["symbol", "securitiesTransacted", "price"], lookback_days=90)
    if ins.empty:
        return {}
    ins["value"] = ins.securitiesTransacted * ins.price
    by_symbol = ins.groupby("symbol").value.sum()
    px = ctx.read_df("prices_daily", columns=["security_id", "ticker"], lookback_days=5)
    ticker_to_id = dict(zip(px.ticker, px.security_id))
    return {ticker_to_id[s]: float(v) for s, v in by_symbol.items() if s in ticker_to_id}
```

**Fundamentals point-in-time (gross profitability):**

```python
META = {"side": "long", "horizon_days": 63, "rebalance": "monthly", "top_n": 20}

def signal(ctx):
    f = ctx.read_df("fundamentals_pit", {"is_latest": True},
                    columns=["security_id", "gross_profit", "total_assets", "period_end"], lookback_days=200)
    last = f.dropna().sort_values(["as_of_date", "period_end"]).groupby("security_id").tail(1)
    last = last[last.total_assets > 0]
    return dict(zip(last.security_id, last.gross_profit / last.total_assets))
```

## The loop

1. **Check the columns first.** Call `describe_collection` for every collection you read, and use its exact field
   names. Layer 2 tables are keyed by `security_id`; Layer 1 tables use `symbol`.
2. **Use the known-at field.** Filter and sort on `as_of_date`, not on an event date such as `date` or `period_end`.
   Never ask for dates after `ctx.date`: such a read returns nothing and is flagged as a blocked lookahead.
3. **Test on one date first.** In the research loop use `submit_code(theory_id, code)`; outside it, use
   `test_strategy(code, plugin=<name>, dates=[<one date>])`. Read the error (type, message, your line number,
   and the real columns for a missing one) or the warnings (`empty_signal`, `missing_columns`, `nan_scores`,
   `unknown_names`, `constant_scores`, `lookahead_blocked`).
4. **Fix and repeat.** Change only what the error points at. Every attempt is saved as a version with its
   outcome. After 5 failed attempts in a row, stop: the theory goes to the Judge with the last error.
5. **Then evaluate once.** When the test passes, call `evaluate_strategy` (with the `theory_id` in the research
   loop). Every evaluation is a trial that lowers the deflated Sharpe of every idea, so never tune the code to
   the metrics. A failing gate is not a bug: it goes to the Judge, not back into the fix loop.
