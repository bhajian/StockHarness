---
name: read-the-catalog
description: How to find and read StockHarness data with the research data tools (list_collections, describe_collection, sample_collection, query_collection), what as_of means for each collection, and which caveats change a result. Use before proposing, coding or judging anything that touches data.
---

# Read the catalog

Every collection in the workspace has a Schema Catalog entry: what it is, its grain and key, when each row
became known, its coverage and its caveats. Read it before you use the data.

## The tools

- `list_collections()`: every collection with its layer, size, point-in-time status and whether you can read
  it. It also shows the session `as_of` and the date the locked holdout starts.
- `describe_collection(name)`: the full entry. It gives the description, grain, key and point-in-time rule;
  coverage (rows, symbols, date range); caveats; joins; and every field with its type, unit and meaning. **Use
  these field names exactly.**
- `sample_collection(name, n)`: the latest rows known by the session as_of.
- `query_collection(name, filter, fields, sort, limit, as_of)`: rows known by the session as_of, at most 500 and
  256 KB. `as_of` can only move earlier. Every row carries its `as_of_date`.

## What as_of means

- **The session as_of** is the latest trading date, or the connection's fixed date, and never past the day before
  the locked holdout. Nobody can read holdout data during research.
- **Layer 2** tables (`prices_daily`, `features_daily`, `features_ranked`, `fundamentals_pit`, `universe_daily`,
  `macro_daily`) have `as_of_date` on every row: the first trading date the row may be acted on.
- **Layer 1** tables are read directly with their known-at rule: `insider_trades.filingDate`, the congress tables'
  `disclosureDate`, statements' `acceptedDate` (period end + 45/90 days when it is a placeholder), end-of-day
  prices on their own date, weekly snapshots by `snapshot_date`.
- **Static** reference data (`securities`, `trading_calendar`) is not cut.
- **Current-only** tables (`company_profiles`, `universe`, `shares_float`, `price_target_summary`, …) and
  undocumented ones are refused: they hold today's values and would leak the future.

## Caveats that change results

- **Survivorship:** delisted coverage is limited (about 100 names on the current plan). Say so in any long-only
  result over many years.
- **Backfilled sectors:** `securities.sector_history` and `industry_history` hold today's classification backfilled
  over the whole history. Sector-relative results are an approximation.
- **Snapshots:** `analyst_estimates`, `price_target_consensus`, `grades_consensus` and `financial_scores` start at
  their first weekly snapshot (October 2026). Theories that need them are `forward_only`: no backtest, paper
  tracking only.
- **Short histories:** `earnings_calendar` covers about a year; insider, congress, analyst-grade and news feeds
  start in October 2026. Check `coverage` before relying on one.
- **Units:** `ret_1d` / `tr_1d` are decimals; Layer 1 percentage fields (`changePercent`, `changesPercentage`,
  dividend `yield`) are percent points; treasury yields are in percent.
- **Odd securities:** a few thin non-common securities have absurd daily moves. The default universe
  (`universe_daily`) excludes them, and the evaluator warns with `extreme_returns`.

## Habits

1. `list_collections` once, then `describe_collection` for each collection you will use.
2. `sample_collection` to see real rows before writing a filter.
3. Query narrowly: filter by `security_id` or `symbol` and a date range, project only the fields you need, and
   keep limits small.
4. Cite what you used: collection, key fields and `as_of_date`.
