# StockHarness: Product Guide

This guide describes the **finished StockHarness product**: what data it stores and where, what the agents research and how, and what each layer does in the app.

- **Building order and status:** see [ROADMAP.md](ROADMAP.md) (milestones M1–M8, tracked in [#139](https://github.com/bhajian/StockHarness/issues/139)).
- **The underlying engine** (agents, harnesses, runner, API): see [docs/platform.md](docs/platform.md).

> **What is real and what is planned.** Every Layer 1 example below is a **real row** from the live workspace (Nov 2026), and so are the five existing Layer 2 collections. Collections and records from later milestones are marked **(planned)**. Their examples are illustrative, with the exact shape each milestone will produce.

## Contents

1. [StockHarness in one page](#1-stockharness-in-one-page)
2. [A day in the life](#2-a-day-in-the-life)
3. [Shared data conventions](#3-shared-data-conventions)
4. [Layer 1: Data Sync (42 datasets)](#4-layer-1-data-sync)
5. [Layer 2: Data Prep (clean, flat, point-in-time collections)](#5-layer-2-data-prep)
6. [The Schema Catalog](#6-the-schema-catalog)
7. [Layer 3: Research agents, skills and strategy ideas](#7-layer-3-research-agents)
8. [Layer 4: Ideas and simulations](#8-layer-4-ideas-and-simulations)
9. [Layer 5: Live signals and the paper book](#9-layer-5-live-signals-and-the-paper-book)
10. [Every collection at a glance](#10-every-collection-at-a-glance)
11. [Data caveats you must know](#11-data-caveats-you-must-know)

---

## 1. StockHarness in one page

StockHarness is a research system for finding, proving and running stock strategies on your own infrastructure. It has five layers:

| Layer                       | What it does                                                                                                                                                | Where in the app                       | Main collections                                                      | Status                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **1 · Data Sync**           | Pulls 5–10 years of history plus scheduled updates from FMP into MongoDB, one raw collection per dataset                                                    | **Datasets → Syncs**, **Health**       | 42 raw collections (`eod_prices`, `income_statement`, …)              | ✅ works today; history depth, backfill, priorities and events come in M1 |
| **2 · Data Prep**           | _Optional:_ Python transforms turn raw data into clean, flat, point-in-time collections **only where needed**. Simple Layer 1 collections are used directly | **Datasets → Transforms**, **Catalog** | `securities`, `prices_daily`, `fundamentals_pit`, `features_daily`, … | 🟡 5 transforms exist as pipeline modules; the Transforms tab comes in M2 |
| **3 · Research agents**     | Agents read the catalog, propose theories, write strategy code, and a trusted evaluator backtests it                                                        | **Research Lab**                       | `theories`, `evaluations`, `trials`                                   | ⏳ M3–M4                                                                  |
| **4 · Ideas & simulations** | People review the proof packs, approve ideas and run full historical simulations                                                                            | **Ideas**, **Simulations**             | `sim_orders`, `sim_trades`, `sim_portfolio_daily`                     | ⏳ M5–M6                                                                  |
| **5 · Live**                | Approved strategies produce daily signals and trade a paper (dry-run) book; live results are tracked against what the backtest expected                     | **Signals**                            | `signals`, `live_strategies`, `alerts`                                | ⏳ M7                                                                     |

Four rules make the results trustworthy and recoverable:

1. **Point in time.** Every row records when it became known (`known_at`, `as_of_date`). The platform filters every read by agents, backtests and live runs "as of" a date, so nothing can see the future.
2. **Schema Catalog.** Every collection is described for the agents: what each field means, its unit, time rule, coverage and caveats.
3. **Trusted evaluator.** Agents write only the strategy logic (a small plugin). A fixed, tested engine runs the backtest and computes every metric, so agents never grade their own work.
4. **Everything is a YAML object.** Every sync, transform (with its Python code), harness, agent, skill, catalog doc, gate, plugin, simulation config and live strategy, plus records such as theories and evaluations, can be exported and imported as YAML (`apiVersion: stockharness/v1`). The repo keeps an always-current copy for backup and recovery (#152, #149).

```
FMP ──► Layer 1 raw collections ──► Layer 2 transforms ──► clean, flat collections ──► Schema Catalog
                                                                      │                      │
                                                                      ▼                      ▼
                                      Layer 3  Theorist → Judge → Coder → Evaluator → Judge → verdict
                                                                      │
                                                                      ▼
                                      Layer 4  Ideas (proof packs) → human approval → Simulations
                                                                      │
                                                                      ▼
                                      Layer 5  live signals → paper book → live vs expected → alerts
```

---

## 1b. Pipelines tie the layers together

Every scheduled flow is a **pipeline**: a DAG that runs once per period, where each step starts only after its upstream steps have finished **and passed a completeness gate** (e.g. 95% of universe symbols present, every trading day of the period present). If Layer 1 is incomplete, Layers 2–5 wait, and you get an alert instead of research and signals built on half the data. In the app, **Data → Pipelines** shows the DAG in layer swimlanes with live status per node, run history, a Gantt timeline, and retry / re-run-from-here controls (#156, #157).

```
weekly-research · 2026-W45
 L1  estimates ✓97% ─┐   statements ✓ ─┐
                     ▼                 ▼
 L2  estimates_snapshots ✓   fundamentals_pit ✓ ──► features_daily ✓ ──► features_ranked ✓
                                                                             │
 L3                                                          research loop (on W45 data) ⟳
 L5                                                          live signals ✓ ──► brief ✓
```

**Layer 2 is optional.** A Layer 1 collection with a simple schema (e.g. `insider_trades`, `treasury_rates`) is read directly, using the known-at rule its dataset declares. Transforms exist only where the data needs cleaning, joining or versioning.

## 2. A day in the life

All times are US Eastern on a trading day, once the product is finished.

| Time         | What happens                                                                                                                                                          | Layer | Where you see it                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------- |
| 06:00        | Hourly feeds (news, price-target changes, grades) keep updating through the day                                                                                       | 1     | Datasets → Syncs                               |
| 18:49        | `eod_prices` and `eod_index` sync today's bars for about 2,400 symbols, including delisted names in their history                                                     | 1     | Syncs list: **ok 18:58**; Health: fresh        |
| 18:58        | The sync emits `dataset.sync.completed`; the **daily pipeline** checks its completeness gate (symbol coverage, today's bar present) before anything downstream starts | 1 → 2 | Sync detail → Runs                             |
| 19:00        | Transforms triggered by that event run: `corporate_actions` → `prices_daily` → `macro_daily`                                                                          | 2     | Transforms list: running / ok                  |
| 19:31        | `features_daily` → `features_ranked` → `universe_daily` update; the catalog entries refresh                                                                           | 2     | Catalog: fresh · 19:31                         |
| 19:45        | Live strategies (approved ideas with pinned code) run against today's data                                                                                            | 5     | Signals: generated 19:52                       |
| 19:52        | Signals are written, and the paper book queues orders for the next close                                                                                              | 5     | Signals → By stock / Paper book                |
| 20:00        | The daily brief email lists today's signals with links to each idea's proof pack                                                                                      | 5     | Inbox / email                                  |
| All night    | The research loop runs: about 40 theories proposed, reviewed, coded and evaluated                                                                                     | 3     | Research Lab board and activity feed           |
| Next morning | You review new successful ideas, approve one, and schedule a 10-year simulation                                                                                       | 4     | Ideas → T-0233 → Approve → Schedule simulation |
| Saturday     | Weekly snapshot datasets (estimates, consensus, scores) **append** a new snapshot; statement syncs run "after earnings + 1 day"                                       | 1     | Health: weekly gap strip                       |

---

## 3. Shared data conventions

| Convention                                                                                         | Applies to               | Meaning                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `symbol`                                                                                           | Layer 1                  | The FMP ticker as returned. Tickers change and get reused, so Layer 2 never joins on them.                                                                               |
| `security_id`                                                                                      | Layer 2+                 | An immutable id (`SEC_000008` = Apple). Tickers, CIK, CUSIP and ISIN map to it over time in `securities.identifiers`.                                                    |
| `_syncedAt`                                                                                        | Layer 1                  | When StockHarness pulled the row (UTC). Present on every Layer 1 row.                                                                                                    |
| `snapshot_date`                                                                                    | weekly snapshot datasets | Part of the key, so each weekly pull **adds** rows. FMP keeps no history for these, so StockHarness builds it.                                                           |
| `acceptedDate`                                                                                     | statements               | When the SEC accepted the filing. It's part of the key, so a restatement adds a row instead of overwriting the original. It's also the `known_at` for fundamentals.      |
| `known_at`                                                                                         | Layer 2+                 | The moment the information was public and usable. Prices: 16:00 ET close. Filings: `acceptedDate`. Insider trades: `filingDate`. Congress: `disclosureDate`.             |
| `as_of_date`                                                                                       | Layer 2+                 | The trading date from which a row may be used. Every agent, backtest and live read filters `as_of_date <= D`.                                                            |
| Lineage (`source_collection`, `source_ids`, `transform_name`, `transform_version`, `processed_at`) | Layer 2+                 | Which raw rows and which code version produced the row.                                                                                                                  |
| `dq_flags` / `dq_issues`                                                                           | Layer 2                  | Data-quality problems are flagged and logged, never silently dropped.                                                                                                    |
| Money and percentages                                                                              | Layer 2+                 | Money is in USD (converted from `reportedCurrency` when needed). Percentages are decimals (`0.0123` = 1.23%). Layer 1 keeps FMP's units (some feeds use percent points). |

---

## 4. Layer 1: Data Sync

### How it works in the app

**Datasets → Syncs**:

- **Syncs list:** KPI cards, filters, columns (dataset, cadence, priority, history, coverage, last and next run), and a bulk toolbar: Run, Enable, Disable, Reset cursor, Purge records, Delete, Export/Import YAML, Backfill.
- **Adding a sync:** choose a dataset, the FMP connection, the symbols (universe, screener preset or list), the history start, the schedule (interval, daily, weekly, or event: "after earnings + N days" / "after sync X"), a priority (P0/P1/P2) and the target collection.
- **Sync detail tabs:**
  - **Source** and **Symbols**: the resolved count, e.g. "2,412 incl. 98 delisted".
  - **History & backfill**: a chunked, resumable backfill with pause, resume and retry.
  - **Schedule**: the next 5 runs.
  - **Runs**: rows, FMP calls, per-symbol errors.
  - **Schema**: the catalog view.
- **Datasets → Health:** freshness, coverage, a gap strip for the last 90 trading days, drift alerts, and editable plan caveats.
- The **top-bar indicator** reads "Data fresh as of Nov 3 close" (green), "2 syncs late" (amber) or "Layer 2 blocked" (red).

How a sync runs:

1. It resolves its symbols.
2. It calls FMP with a shared rate limiter (P0 first), retrying on throttling.
3. It checks each page against the expected fields.
4. It upserts on the dataset's unique key.
5. It updates the catalog entry (types, null %, min/max, coverage).
6. It emits `dataset.sync.completed`.

One failing symbol never fails the whole dataset.

**Sync modes** (from the catalog definition):

- **Time series:** dated history with a cursor; each run pulls from the last synced date to today.
- **Rolling window:** calendars, where a moving date window is re-pulled.
- **Snapshot:** current values upserted in place. With `snapshot_date` they're appended per run instead.
- **Feed:** the latest items across the market, paged. Note: a feed only has history from the day its sync started.

**Screener presets** for per-symbol datasets: Mega-cap (> $200B), Large-cap, S&P 500-like, Nasdaq-100-like, All NYSE, All Nasdaq. The **universe** default is the survivorship-aware sync universe (active names above $2B plus delisted companies).

### The 42 datasets

The datasets are grouped as in the app. Each entry shows what it stores, how it syncs, every data point (field) in the live collection, and a real example row.

### Reference (8)

#### 1. Universe (screener) → `universe`

Survivorship-free SYNC universe: active screener names plus all delisted companies, so per-symbol datasets also pull the history of names that later died. The point-in-time cap/tradeable filter is a separate RESEARCH universe applied in Layer 3 (universe_daily), never at sync time.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `company-screener`                          |
| Scope               | market-wide                                 |
| Unique key          | `symbol`                                    |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | weekly                                      |
| Rows today (live)   | 2,249                                       |

**Data points (7):** `symbol`, `companyName`, `exchange`, `industry`, `is_delisted`, `marketCap`, `sector`

Example (real row from the live workspace):

```json
{
  "symbol": "DNN",
  "companyName": "Denison Mines Corp.",
  "exchange": "AMEX",
  "industry": "Uranium",
  "is_delisted": false,
  "marketCap": 2000527360,
  "sector": "Energy"
}
```

#### 2. Company profiles → `company_profiles`

Company profile per symbol.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `profile`                                   |
| Scope               | per symbol (universe, preset or list)       |
| Unique key          | `symbol`                                    |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | weekly                                      |
| Rows today (live)   | 2,189                                       |

**Data points (36):** `symbol`, `address`, `averageVolume`, `beta`, `ceo`, `change`, `changePercentage`, `cik`, `city`, `companyName`, `country`, `currency`, `cusip`, `defaultImage`, `description`, `exchange`, `exchangeFullName`, `fullTimeEmployees`, `image`, `industry`, `ipoDate`, `isActivelyTrading`, `isAdr`, `isEtf`, `isFund`, `isin`, `lastDividend`, `marketCap`, `phone`, `price`, `range`, `sector`, `state`, `volume`, `website`, `zip`

Example (real row from the live workspace):

```json
{
  "symbol": "ATIIU",
  "address": "2093 Philadelphia Pike #1968",
  "averageVolume": 1473,
  "beta": 0.409,
  "ceo": "Long Long",
  "change": -0.81,
  "changePercentage": -8.99001,
  "cik": "0002028516",
  "city": "Claymont",
  "companyName": "Archimedes Tech SPAC Partners II Co. Unit",
  "country": "US",
  "currency": "USD",
  "cusip": "G04537117",
  "defaultImage": false,
  "description": "Archimedes Tech SPAC Partners II Co. operates as a special purpose acq\u2026",
  "exchange": "NASDAQ",
  "…": "20 more fields"
}
```

#### 3. Shares float → `shares_float`

Free float and shares outstanding per symbol.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `shares-float`                              |
| Scope               | per symbol (universe, preset or list)       |
| Unique key          | `symbol`                                    |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | weekly                                      |
| Rows today (live)   | 2,174                                       |

**Data points (6):** `symbol`, `date`, `floatShares`, `freeFloat`, `outstandingShares`, `source`

Example (real row from the live workspace):

```json
{
  "symbol": "ATIIU",
  "date": "2026-10-26 11:14:55",
  "floatShares": 23310114,
  "freeFloat": 90.47201,
  "outstandingShares": 25765000,
  "source": "https://www.sec.gov/Archives/edgar/data/2028516/000143774926027710/ati\u2026"
}
```

#### 4. Market capitalization → `market_cap`

Current market capitalization per symbol.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `market-capitalization`                     |
| Scope               | per symbol (universe, preset or list)       |
| Unique key          | `symbol`, `date`                            |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | daily                                       |
| Rows today (live)   | 73                                          |

**Data points (3):** `date`, `symbol`, `marketCap`

Example (real row from the live workspace):

```json
{
  "date": "2026-10-23",
  "symbol": "MRVL",
  "marketCap": 200121385320
}
```

#### 5. Historical market cap → `historical_market_cap`

Daily market-cap history per symbol.

|                     |                                                        |
| ------------------- | ------------------------------------------------------ |
| FMP endpoint        | `historical-market-capitalization` with { limit: 500 } |
| Scope               | per symbol (universe, preset or list)                  |
| Unique key          | `symbol`, `date`                                       |
| Sync mode           | Snapshot: current values, upserted in place            |
| Recommended cadence | weekly                                                 |
| Rows today (live)   | 153,084                                                |

**Data points (3):** `date`, `symbol`, `marketCap`

Example (real row from the live workspace):

```json
{
  "date": "2026-07-31",
  "symbol": "ATIIU",
  "marketCap": 244950000
}
```

#### 6. Stock peers → `stock_peers`

Peer companies per symbol.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `stock-peers`                               |
| Scope               | per symbol (universe, preset or list)       |
| Unique key          | `symbol`                                    |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | weekly                                      |
| Rows today (live)   | 2,127                                       |

**Data points (4):** `symbol`, `companyName`, `mktCap`, `price`

Example (real row from the live workspace):

```json
{
  "symbol": "ATIIU",
  "companyName": "Vine Hill Capital Investment Corp.",
  "mktCap": 322666685,
  "price": 11
}
```

#### 7. Key executives → `key_executives`

Named executives and compensation per symbol.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `key-executives`                            |
| Scope               | per symbol (universe, preset or list)       |
| Unique key          | `symbol`, `name`, `title`                   |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | weekly                                      |
| Rows today (live)   | 21,511                                      |

**Data points (9):** `name`, `symbol`, `title`, `active`, `currencyPay`, `gender`, `pay`, `titleSince`, `yearBorn`

Example (real row from the live workspace):

```json
{
  "name": "Long Long",
  "symbol": "ATIIU",
  "title": "Chief Executive Officer & Director",
  "active": true,
  "currencyPay": "USD",
  "gender": "male",
  "pay": null,
  "titleSince": null,
  "yearBorn": 1985
}
```

#### 8. Employee count → `employee_count`

Reported employee counts per symbol.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `employee-count` with { limit: 20 }         |
| Scope               | per symbol (universe, preset or list)       |
| Unique key          | `symbol`, `periodOfReport`                  |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | weekly                                      |
| Rows today (live)   | 30,269                                      |

**Data points (9):** `periodOfReport`, `symbol`, `acceptanceTime`, `cik`, `companyName`, `employeeCount`, `filingDate`, `formType`, `source`

Example (real row from the live workspace):

```json
{
  "periodOfReport": "2024-12-31",
  "symbol": "ATIIU",
  "acceptanceTime": "2025-03-31 16:32:31",
  "cik": "0002028516",
  "companyName": "Archimedes Tech SPAC Partners II Co. Unit",
  "employeeCount": 2,
  "filingDate": "2025-03-31",
  "formType": "10-K",
  "source": "https://www.sec.gov/Archives/edgar/data/2028516/000143774925010221/000\u2026"
}
```

### Prices (2)

#### 9. EOD prices (OHLCV) → `eod_prices`

Daily open/high/low/close/volume per symbol.

|                     |                                                                      |
| ------------------- | -------------------------------------------------------------------- |
| FMP endpoint        | `historical-price-eod/full`                                          |
| Scope               | per symbol (universe, preset or list)                                |
| Unique key          | `symbol`, `date`                                                     |
| Sync mode           | Time series: dated history with a moving cursor; history is appended |
| Recommended cadence | daily                                                                |
| Rows today (live)   | 2,444,189                                                            |

**Data points (10):** `date`, `symbol`, `change`, `changePercent`, `close`, `high`, `low`, `open`, `volume`, `vwap`

Example (real row from the live workspace):

```json
{
  "date": "2026-10-23",
  "symbol": "AAPL",
  "change": -1.39,
  "changePercent": -0.39814,
  "close": 347.73,
  "high": 351.73,
  "low": 345.75,
  "open": 349.12,
  "volume": 39323315,
  "vwap": 348.5825
}
```

#### 10. Index & VIX levels → `eod_index`

Daily levels for ^GSPC, ^VIX, ^DJI, ^IXIC.

|                     |                                                                      |
| ------------------- | -------------------------------------------------------------------- |
| FMP endpoint        | `historical-price-eod/full` for ['^GSPC', '^VIX', '^DJI', '^IXIC']   |
| Scope               | market-wide                                                          |
| Unique key          | `symbol`, `date`                                                     |
| Sync mode           | Time series: dated history with a moving cursor; history is appended |
| Recommended cadence | daily                                                                |
| Rows today (live)   | 5,043                                                                |

**Data points (10):** `symbol`, `date`, `change`, `changePercent`, `close`, `high`, `low`, `open`, `volume`, `vwap`

Example (real row from the live workspace):

```json
{
  "symbol": "^IXIC",
  "date": "2021-10-25",
  "change": 83.7869,
  "changePercent": 0.55331,
  "close": 15226.7062,
  "high": 15259.6317,
  "low": 15070.7497,
  "open": 15142.9193,
  "volume": 5750200000,
  "vwap": 15175.00173
}
```

### Market (7)

#### 11. Treasury rates → `treasury_rates`

US Treasury par yield curve.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `treasury-rates`                            |
| Scope               | market-wide                                 |
| Unique key          | `date`                                      |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | daily                                       |
| Rows today (live)   | 63                                          |

**Data points (13):** `date`, `month1`, `month2`, `month3`, `month6`, `year1`, `year10`, `year2`, `year20`, `year3`, `year30`, `year5`, `year7`

Example (real row from the live workspace):

```json
{
  "date": "2026-07-23",
  "month1": 3.82,
  "month2": 3.95,
  "month3": 3.95,
  "month6": 4.09,
  "year1": 4.15,
  "year10": 4.71,
  "year2": 4.37,
  "year20": 5.2,
  "year3": 4.4,
  "year30": 5.17,
  "year5": 4.46,
  "year7": 4.58
}
```

#### 12. Sector performance → `sector_performance`

Daily sector performance snapshot by exchange.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `sector-performance-snapshot`               |
| Scope               | market-wide                                 |
| Unique key          | `date`, `sector`, `exchange`                |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | daily                                       |
| Rows today (live)   | 11                                          |

**Data points (4):** `date`, `exchange`, `sector`, `averageChange`

Example (real row from the live workspace):

```json
{
  "date": "2026-10-23",
  "exchange": "NASDAQ",
  "sector": "Utilities",
  "averageChange": -0.3080071051487221
}
```

#### 13. Stock news → `news_stocks`

Latest stock news across the market.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `news/stock-latest`                         |
| Scope               | market-wide feed (latest items, paged)      |
| Unique key          | `symbol`, `publishedDate`, `title`          |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | daily                                       |
| Rows today (live)   | 939                                         |

**Data points (8):** `title`, `symbol`, `publishedDate`, `image`, `publisher`, `site`, `text`, `url`

Example (real row from the live workspace):

```json
{
  "title": "XRP vs Cardano: Which Has the Better Path to Recovery in 2026?",
  "symbol": "XRP",
  "publishedDate": "2026-10-23 16:00:24",
  "image": "https://images.financialmodelingprep.com/news/xrp-vs-cardano-which-has\u2026",
  "publisher": "247 Wallst",
  "site": "247wallst.com",
  "text": "XRP and Cardano both surged in late summer before losing much of those\u2026",
  "url": "https://247wallst.com/investing/cryptocurrency/2026/10/23/xrp-vs-carda\u2026"
}
```

#### 14. Biggest gainers → `biggest_gainers`

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `biggest-gainers`                           |
| Scope               | market-wide                                 |
| Unique key          | `symbol`                                    |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | daily                                       |
| Rows today (live)   | 99                                          |

**Data points (6):** `symbol`, `change`, `changesPercentage`, `exchange`, `name`, `price`

Example (real row from the live workspace):

```json
{
  "symbol": "RDHL",
  "change": 0.0538,
  "changesPercentage": 13.87313,
  "exchange": "NASDAQ",
  "name": "RedHill Biopharma Ltd.",
  "price": 0.4416
}
```

#### 15. Most active → `most_actives`

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `most-actives`                              |
| Scope               | market-wide                                 |
| Unique key          | `symbol`                                    |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | daily                                       |
| Rows today (live)   | 70                                          |

**Data points (6):** `symbol`, `change`, `changesPercentage`, `exchange`, `name`, `price`

Example (real row from the live workspace):

```json
{
  "symbol": "KPTI",
  "change": -0.55,
  "changesPercentage": -83.08157,
  "exchange": "NASDAQ",
  "name": "Karyopharm Therapeutics Inc.",
  "price": 0.112
}
```

#### 16. Economic — GDP → `economic_gdp`

US GDP economic indicator.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `economic-indicators` with { name: 'GDP' }  |
| Scope               | market-wide                                 |
| Unique key          | `name`, `date`                              |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | weekly                                      |
| Rows today (live)   | 3                                           |

**Data points (3):** `date`, `name`, `value`

Example (real row from the live workspace):

```json
{
  "date": "2026-01-01",
  "name": "GDP",
  "value": 31906.274
}
```

#### 17. Economic — CPI → `economic_cpi`

US Consumer Price Index economic indicator.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `economic-indicators` with { name: 'CPI' }  |
| Scope               | market-wide                                 |
| Unique key          | `name`, `date`                              |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | weekly                                      |
| Rows today (live)   | 2                                           |

**Data points (3):** `date`, `name`, `value`

Example (real row from the live workspace):

```json
{
  "date": "2026-08-01",
  "name": "CPI",
  "value": 334.131
}
```

### Calendars (5)

#### 18. Earnings calendar → `earnings_calendar`

Scheduled and reported earnings across the market.

|                     |                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| FMP endpoint        | `earnings-calendar`                                                                                   |
| Scope               | market-wide                                                                                           |
| Unique key          | `symbol`, `date`                                                                                      |
| Sync mode           | Rolling window: a date window is re-pulled each run (about −7 to +14 days, or the configured from/to) |
| Recommended cadence | daily                                                                                                 |
| Rows today (live)   | 4,769                                                                                                 |

**Data points (7):** `date`, `symbol`, `epsActual`, `epsEstimated`, `lastUpdated`, `revenueActual`, `revenueEstimated`

Example (real row from the live workspace):

```json
{
  "date": "2026-10-29",
  "symbol": "TROO",
  "epsActual": null,
  "epsEstimated": null,
  "lastUpdated": "2026-10-23",
  "revenueActual": null,
  "revenueEstimated": null
}
```

#### 19. Dividends calendar → `dividends_calendar`

Upcoming and recent dividend events.

|                     |                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| FMP endpoint        | `dividends-calendar`                                                                                  |
| Scope               | market-wide                                                                                           |
| Unique key          | `symbol`, `date`                                                                                      |
| Sync mode           | Rolling window: a date window is re-pulled each run (about −7 to +14 days, or the configured from/to) |
| Recommended cadence | daily                                                                                                 |
| Rows today (live)   | 1,565                                                                                                 |

**Data points (9):** `date`, `symbol`, `adjDividend`, `declarationDate`, `dividend`, `frequency`, `paymentDate`, `recordDate`, `yield`

Example (real row from the live workspace):

```json
{
  "date": "2026-10-29",
  "symbol": "SURVF",
  "adjDividend": 0.01577697,
  "declarationDate": "",
  "dividend": 0.01577697,
  "frequency": "Quarterly",
  "paymentDate": "2026-11-27",
  "recordDate": "2026-10-30",
  "yield": 5.6408008928571425
}
```

#### 20. Splits calendar → `splits_calendar`

Upcoming and recent stock splits.

|                     |                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| FMP endpoint        | `splits-calendar`                                                                                     |
| Scope               | market-wide                                                                                           |
| Unique key          | `symbol`, `date`                                                                                      |
| Sync mode           | Rolling window: a date window is re-pulled each run (about −7 to +14 days, or the configured from/to) |
| Recommended cadence | daily                                                                                                 |
| Rows today (live)   | 63                                                                                                    |

**Data points (5):** `date`, `symbol`, `denominator`, `numerator`, `splitType`

Example (real row from the live workspace):

```json
{
  "date": "2026-10-26",
  "symbol": "SXTC",
  "denominator": 100,
  "numerator": 1,
  "splitType": null
}
```

#### 21. Dividends history → `dividends_history`

Dividend history per symbol.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `dividends` with { limit: 100 }             |
| Scope               | per symbol (universe, preset or list)       |
| Unique key          | `symbol`, `date`                            |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | weekly                                      |
| Rows today (live)   | 91,932                                      |

**Data points (9):** `date`, `symbol`, `adjDividend`, `declarationDate`, `dividend`, `frequency`, `paymentDate`, `recordDate`, `yield`

Example (real row from the live workspace):

```json
{
  "symbol": "AAPL",
  "date": "2026-08-10",
  "adjDividend": 0.27,
  "declarationDate": "2026-07-30",
  "dividend": 0.27,
  "frequency": "Quarterly",
  "paymentDate": "2026-08-13",
  "recordDate": "2026-08-10",
  "yield": 0.3438655680269902
}
```

#### 22. Splits history → `splits_history`

Stock-split history per symbol.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `splits` with { limit: 100 }                |
| Scope               | per symbol (universe, preset or list)       |
| Unique key          | `symbol`, `date`                            |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | weekly                                      |
| Rows today (live)   | 4,541                                       |

**Data points (5):** `date`, `symbol`, `denominator`, `numerator`, `splitType`

Example (real row from the live workspace):

```json
{
  "date": "2026-11-09",
  "symbol": "SNDK",
  "denominator": 1,
  "numerator": 8,
  "splitType": "stock-split"
}
```

### Fundamentals (11)

#### 23. Financial scores → `financial_scores`

Altman Z, Piotroski and related scores per symbol.

|                     |                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| FMP endpoint        | `financial-scores`                                                                                                    |
| Scope               | per symbol (universe, preset or list)                                                                                 |
| Unique key          | `symbol`, `snapshot_date`                                                                                             |
| Sync mode           | Snapshot: current values, upserted in place; plus one appended row per weekly `snapshot_date`, so the history is kept |
| Recommended cadence | weekly                                                                                                                |
| Rows today (live)   | 7,274                                                                                                                 |

**Data points (12):** `symbol`, `snapshot_date`, `altmanZScore`, `ebit`, `marketCap`, `piotroskiScore`, `reportedCurrency`, `retainedEarnings`, `revenue`, `totalAssets`, `totalLiabilities`, `workingCapital`

Example (real row from the live workspace):

```json
{
  "symbol": "AAPL",
  "snapshot_date": "2026-10-31",
  "altmanZScore": 13.5472762328235,
  "ebit": 155906000000,
  "marketCap": 5029592253400,
  "piotroskiScore": 9,
  "reportedCurrency": "USD",
  "retainedEarnings": 11326000000,
  "revenue": 466823000000,
  "totalAssets": 383266000000,
  "totalLiabilities": 275746000000,
  "workingCapital": 492000000
}
```

#### 24. Key metrics (annual) → `key_metrics`

Key metrics per symbol, annual (quarterly not on Premium).

|                     |                                                    |
| ------------------- | -------------------------------------------------- |
| FMP endpoint        | `key-metrics` with { period: 'annual', limit: 10 } |
| Scope               | per symbol (universe, preset or list)              |
| Unique key          | `symbol`, `date`                                   |
| Sync mode           | Snapshot: current values, upserted in place        |
| Recommended cadence | weekly                                             |
| Rows today (live)   | 19,863                                             |

**Data points (47):** `date`, `symbol`, `averageInventory`, `averagePayables`, `averageReceivables`, `capexToDepreciation`, `capexToOperatingCashFlow`, `capexToRevenue`, `cashConversionCycle`, `currentRatio`, `daysOfInventoryOutstanding`, `daysOfPayablesOutstanding`, `daysOfSalesOutstanding`, `earningsYield`, `enterpriseValue`, `evToEBITDA`, `evToFreeCashFlow`, `evToOperatingCashFlow`, `evToSales`, `fiscalYear`, `freeCashFlowToEquity`, `freeCashFlowToFirm`, `freeCashFlowYield`, `grahamNetNet`, `grahamNumber`, `incomeQuality`, `intangiblesToTotalAssets`, `interestBurden`, `investedCapital`, `marketCap`, `netCurrentAssetValue`, `netDebtToEBITDA`, `operatingCycle`, `operatingReturnOnAssets`, `period`, `reportedCurrency`, `researchAndDevelopementToRevenue`, `returnOnAssets`, `returnOnCapitalEmployed`, `returnOnEquity`, `returnOnInvestedCapital`, `returnOnTangibleAssets`, `salesGeneralAndAdministrativeToRevenue`, `stockBasedCompensationToRevenue`, `tangibleAssetValue`, `taxBurden`, `workingCapital`

Example (real row from the live workspace):

```json
{
  "date": "2024-12-31",
  "symbol": "ATIIU",
  "averageInventory": 0,
  "averagePayables": 0,
  "averageReceivables": 0,
  "capexToDepreciation": 0,
  "capexToOperatingCashFlow": 0,
  "capexToRevenue": 0,
  "cashConversionCycle": 0,
  "currentRatio": 0,
  "daysOfInventoryOutstanding": 0,
  "daysOfPayablesOutstanding": 0,
  "daysOfSalesOutstanding": 0,
  "earningsYield": -1.5787362086258778e-6,
  "enterpriseValue": 50042033,
  "evToEBITDA": 371.1345100281603,
  "…": "31 more fields"
}
```

#### 25. Financial ratios (annual) → `ratios`

Financial ratios per symbol, annual (quarterly not on Premium).

|                     |                                               |
| ------------------- | --------------------------------------------- |
| FMP endpoint        | `ratios` with { period: 'annual', limit: 10 } |
| Scope               | per symbol (universe, preset or list)         |
| Unique key          | `symbol`, `date`                              |
| Sync mode           | Snapshot: current values, upserted in place   |
| Recommended cadence | weekly                                        |
| Rows today (live)   | 19,863                                        |

**Data points (66):** `date`, `symbol`, `assetTurnover`, `bookValuePerShare`, `bottomLineProfitMargin`, `capexPerShare`, `capitalExpenditureCoverageRatio`, `cashPerShare`, `cashRatio`, `continuousOperationsProfitMargin`, `currentRatio`, `debtServiceCoverageRatio`, `debtToAssetsRatio`, `debtToCapitalRatio`, `debtToEquityRatio`, `debtToMarketCap`, `dividendPaidAndCapexCoverageRatio`, `dividendPayoutRatio`, `dividendPerShare`, `dividendYield`, `dividendYieldPercentage`, `ebitMargin`, `ebitdaMargin`, `ebtPerEbit`, `effectiveTaxRate`, `enterpriseValueMultiple`, `financialLeverageRatio`, `fiscalYear`, `fixedAssetTurnover`, `forwardPriceToEarningsGrowthRatio`, `freeCashFlowOperatingCashFlowRatio`, `freeCashFlowPerShare`, `grossProfitMargin`, `interestCoverageRatio`, `interestDebtPerShare`, `inventoryTurnover`, `longTermDebtToCapitalRatio`, `netIncomePerEBT`, `netIncomePerShare`, `netProfitMargin`, `operatingCashFlowCoverageRatio`, `operatingCashFlowPerShare`, `operatingCashFlowRatio`, `operatingCashFlowSalesRatio`, `operatingProfitMargin`, `payablesTurnover`, `period`, `pretaxProfitMargin`, `priceToBookRatio`, `priceToEarningsDilutedGrowthRatio`, `priceToEarningsDilutedRatio`, `priceToEarningsGrowthRatio`, `priceToEarningsRatio`, `priceToFairValue`, `priceToFreeCashFlowRatio`, `priceToOperatingCashFlowRatio`, `priceToSalesRatio`, `quickRatio`, `receivablesTurnover`, `reportedCurrency`, `revenuePerShare`, `shareholdersEquityPerShare`, `shortTermOperatingCashFlowCoverageRatio`, `solvencyRatio`, `tangibleBookValuePerShare`, `workingCapitalTurnoverRatio`

Example (real row from the live workspace):

```json
{
  "date": "2024-12-31",
  "symbol": "ATIIU",
  "assetTurnover": 0,
  "bookValuePerShare": -0.01074,
  "bottomLineProfitMargin": 0,
  "capexPerShare": 0,
  "capitalExpenditureCoverageRatio": 0,
  "cashPerShare": 0,
  "cashRatio": 0,
  "continuousOperationsProfitMargin": 0,
  "currentRatio": 0,
  "debtServiceCoverageRatio": 0.7021465060692693,
  "debtToAssetsRatio": 0.4469095233551552,
  "debtToCapitalRatio": 1.388193706490859,
  "debtToEquityRatio": -3.576033519553073,
  "debtToMarketCap": 0.0038522166499498495,
  "…": "50 more fields"
}
```

#### 26. Financial growth (quarterly) → `financial_growth`

Period-over-period growth per symbol.

|                     |                                                         |
| ------------------- | ------------------------------------------------------- |
| FMP endpoint        | `financial-growth` with { period: 'quarter', limit: 8 } |
| Scope               | per symbol (universe, preset or list)                   |
| Unique key          | `symbol`, `date`, `period`                              |
| Sync mode           | Snapshot: current values, upserted in place             |
| Recommended cadence | weekly                                                  |
| Rows today (live)   | 17,384                                                  |

**Data points (44):** `symbol`, `date`, `period`, `assetGrowth`, `bookValueperShareGrowth`, `debtGrowth`, `dividendsPerShareGrowth`, `ebitdaGrowth`, `ebitgrowth`, `epsdilutedGrowth`, `epsgrowth`, `fiscalYear`, `fiveYBottomLineNetIncomeGrowthPerShare`, `fiveYDividendperShareGrowthPerShare`, `fiveYNetIncomeGrowthPerShare`, `fiveYOperatingCFGrowthPerShare`, `fiveYRevenueGrowthPerShare`, `fiveYShareholdersEquityGrowthPerShare`, `freeCashFlowGrowth`, `grossProfitGrowth`, `growthCapitalExpenditure`, `inventoryGrowth`, `netIncomeGrowth`, `operatingCashFlowGrowth`, `operatingIncomeGrowth`, `rdexpenseGrowth`, `receivablesGrowth`, `reportedCurrency`, `revenueGrowth`, `sgaexpensesGrowth`, `tenYBottomLineNetIncomeGrowthPerShare`, `tenYDividendperShareGrowthPerShare`, `tenYNetIncomeGrowthPerShare`, `tenYOperatingCFGrowthPerShare`, `tenYRevenueGrowthPerShare`, `tenYShareholdersEquityGrowthPerShare`, `threeYBottomLineNetIncomeGrowthPerShare`, `threeYDividendperShareGrowthPerShare`, `threeYNetIncomeGrowthPerShare`, `threeYOperatingCFGrowthPerShare`, `threeYRevenueGrowthPerShare`, `threeYShareholdersEquityGrowthPerShare`, `weightedAverageSharesDilutedGrowth`, `weightedAverageSharesGrowth`

Example (real row from the live workspace):

```json
{
  "symbol": "ATIIU",
  "date": "2024-09-30",
  "period": "Q3",
  "assetGrowth": 5.924191727394026,
  "bookValueperShareGrowth": -1.631056381187654,
  "debtGrowth": 3557.139534883721,
  "dividendsPerShareGrowth": 0,
  "ebitdaGrowth": -1.001305755404116,
  "ebitgrowth": -0.3044496487119438,
  "epsdilutedGrowth": 0.7411764705882352,
  "epsgrowth": 0.7411764705882352,
  "fiscalYear": "2024",
  "fiveYBottomLineNetIncomeGrowthPerShare": 0,
  "fiveYDividendperShareGrowthPerShare": 0,
  "fiveYNetIncomeGrowthPerShare": 0,
  "fiveYOperatingCFGrowthPerShare": 0,
  "…": "28 more fields"
}
```

#### 27. Income statement (quarterly) → `income_statement`

Quarterly income statements per symbol.

|                     |                                                         |
| ------------------- | ------------------------------------------------------- |
| FMP endpoint        | `income-statement` with { period: 'quarter', limit: 8 } |
| Scope               | per symbol (universe, preset or list)                   |
| Unique key          | `symbol`, `date`, `acceptedDate`                        |
| Sync mode           | Snapshot: current values, upserted in place             |
| Recommended cadence | weekly                                                  |
| Rows today (live)   | 17,442                                                  |

**Data points (39):** `acceptedDate`, `date`, `symbol`, `bottomLineNetIncome`, `cik`, `costAndExpenses`, `costOfRevenue`, `depreciationAndAmortization`, `ebit`, `ebitda`, `eps`, `epsDiluted`, `filingDate`, `fiscalYear`, `generalAndAdministrativeExpenses`, `grossProfit`, `incomeBeforeTax`, `incomeTaxExpense`, `interestExpense`, `interestIncome`, `netIncome`, `netIncomeDeductions`, `netIncomeFromContinuingOperations`, `netIncomeFromDiscontinuedOperations`, `netInterestIncome`, `nonOperatingIncomeExcludingInterest`, `operatingExpenses`, `operatingIncome`, `otherAdjustmentsToNetIncome`, `otherExpenses`, `period`, `reportedCurrency`, `researchAndDevelopmentExpenses`, `revenue`, `sellingAndMarketingExpenses`, `sellingGeneralAndAdministrativeExpenses`, `totalOtherIncomeExpensesNet`, `weightedAverageShsOut`, `weightedAverageShsOutDil`

Example (real row from the live workspace):

```json
{
  "acceptedDate": "2026-07-31 06:01:02",
  "date": "2026-06-27",
  "symbol": "AAPL",
  "bottomLineNetIncome": 29789000000,
  "cik": "0000320193",
  "costAndExpenses": 73722000000,
  "costOfRevenue": 54647000000,
  "depreciationAndAmortization": 3320000000,
  "ebit": 36267000000,
  "ebitda": 39587000000,
  "eps": 2.03,
  "epsDiluted": 2.02,
  "filingDate": "2026-07-31",
  "fiscalYear": "2026",
  "generalAndAdministrativeExpenses": 2312000000,
  "grossProfit": 54770000000,
  "…": "23 more fields"
}
```

#### 28. Balance sheet (quarterly) → `balance_sheet`

Quarterly balance sheets per symbol.

|                     |                                                                |
| ------------------- | -------------------------------------------------------------- |
| FMP endpoint        | `balance-sheet-statement` with { period: 'quarter', limit: 8 } |
| Scope               | per symbol (universe, preset or list)                          |
| Unique key          | `symbol`, `date`, `acceptedDate`                               |
| Sync mode           | Snapshot: current values, upserted in place                    |
| Recommended cadence | weekly                                                         |
| Rows today (live)   | 17,403                                                         |

**Data points (61):** `acceptedDate`, `date`, `symbol`, `accountPayables`, `accountsReceivables`, `accruedExpenses`, `accumulatedOtherComprehensiveIncomeLoss`, `additionalPaidInCapital`, `capitalLeaseObligations`, `capitalLeaseObligationsCurrent`, `capitalLeaseObligationsNonCurrent`, `cashAndCashEquivalents`, `cashAndShortTermInvestments`, `cik`, `commonStock`, `deferredRevenue`, `deferredRevenueNonCurrent`, `deferredTaxLiabilitiesNonCurrent`, `filingDate`, `fiscalYear`, `goodwill`, `goodwillAndIntangibleAssets`, `intangibleAssets`, `inventory`, `longTermDebt`, `longTermInvestments`, `minorityInterest`, `netDebt`, `netReceivables`, `otherAssets`, `otherCurrentAssets`, `otherCurrentLiabilities`, `otherLiabilities`, `otherNonCurrentAssets`, `otherNonCurrentLiabilities`, `otherPayables`, `otherReceivables`, `otherTotalStockholdersEquity`, `period`, `preferredStock`, `prepaids`, `propertyPlantEquipmentNet`, `reportedCurrency`, `retainedEarnings`, `shortTermDebt`, `shortTermInvestments`, `taxAssets`, `taxPayables`, `totalAssets`, `totalCurrentAssets`, `totalCurrentLiabilities`, `totalDebt`, `totalEquity`, `totalInvestments`, `totalLiabilities`, `totalLiabilitiesAndTotalEquity`, `totalNonCurrentAssets`, `totalNonCurrentLiabilities`, `totalPayables`, `totalStockholdersEquity`, `treasuryStock`

Example (real row from the live workspace):

```json
{
  "acceptedDate": "2024-09-30 00:00:00",
  "date": "2024-09-30",
  "symbol": "ATIIU",
  "accountPayables": 0,
  "accountsReceivables": 0,
  "accruedExpenses": 224192,
  "accumulatedOtherComprehensiveIncomeLoss": 0,
  "additionalPaidInCapital": 24425,
  "capitalLeaseObligations": 0,
  "capitalLeaseObligationsCurrent": 0,
  "capitalLeaseObligationsNonCurrent": 0,
  "cashAndCashEquivalents": 0,
  "cashAndShortTermInvestments": 0,
  "cik": "0002028516",
  "commonStock": 575,
  "deferredRevenue": 0,
  "…": "45 more fields"
}
```

#### 29. Cash flow (quarterly) → `cash_flow`

Quarterly cash-flow statements per symbol.

|                     |                                                            |
| ------------------- | ---------------------------------------------------------- |
| FMP endpoint        | `cash-flow-statement` with { period: 'quarter', limit: 8 } |
| Scope               | per symbol (universe, preset or list)                      |
| Unique key          | `symbol`, `date`, `acceptedDate`                           |
| Sync mode           | Snapshot: current values, upserted in place                |
| Recommended cadence | weekly                                                     |
| Rows today (live)   | 17,389                                                     |

**Data points (47):** `acceptedDate`, `date`, `symbol`, `accountsPayables`, `accountsReceivables`, `acquisitionsNet`, `capitalExpenditure`, `cashAtBeginningOfPeriod`, `cashAtEndOfPeriod`, `changeInWorkingCapital`, `cik`, `commonDividendsPaid`, `commonStockIssuance`, `commonStockRepurchased`, `deferredIncomeTax`, `depreciationAndAmortization`, `effectOfForexChangesOnCash`, `filingDate`, `fiscalYear`, `freeCashFlow`, `incomeTaxesPaid`, `interestPaid`, `inventory`, `investmentsInPropertyPlantAndEquipment`, `longTermNetDebtIssuance`, `netCashProvidedByFinancingActivities`, `netCashProvidedByInvestingActivities`, `netCashProvidedByOperatingActivities`, `netChangeInCash`, `netCommonStockIssuance`, `netDebtIssuance`, `netDividendsPaid`, `netIncome`, `netPreferredStockIssuance`, `netStockIssuance`, `operatingCashFlow`, `otherFinancingActivities`, `otherInvestingActivities`, `otherNonCashItems`, `otherWorkingCapital`, `period`, `preferredDividendsPaid`, `purchasesOfInvestments`, `reportedCurrency`, `salesMaturitiesOfInvestments`, `shortTermNetDebtIssuance`, `stockBasedCompensation`

Example (real row from the live workspace):

```json
{
  "acceptedDate": "2024-09-30 00:00:00",
  "date": "2024-09-30",
  "symbol": "ATIIU",
  "accountsPayables": 0,
  "accountsReceivables": 0,
  "acquisitionsNet": 0,
  "capitalExpenditure": 0,
  "cashAtBeginningOfPeriod": 0,
  "cashAtEndOfPeriod": 0,
  "changeInWorkingCapital": 13000,
  "cik": "0002028516",
  "commonDividendsPaid": 0,
  "commonStockIssuance": 0,
  "commonStockRepurchased": 0,
  "deferredIncomeTax": 0,
  "depreciationAndAmortization": 0,
  "…": "31 more fields"
}
```

#### 30. Enterprise values → `enterprise_values`

Enterprise value and components per symbol (annual).

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `enterprise-values` with { limit: 10 }      |
| Scope               | per symbol (universe, preset or list)       |
| Unique key          | `symbol`, `date`                            |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | weekly                                      |
| Rows today (live)   | 19,861                                      |

**Data points (8):** `symbol`, `date`, `addTotalDebt`, `enterpriseValue`, `marketCapitalization`, `minusCashAndCashEquivalents`, `numberOfShares`, `stockPrice`

Example (real row from the live workspace):

```json
{
  "symbol": "ATIIU",
  "date": "2024-12-31",
  "addTotalDebt": 192033,
  "enterpriseValue": 50042033,
  "marketCapitalization": 49850000,
  "minusCashAndCashEquivalents": 0,
  "numberOfShares": 5000000,
  "stockPrice": 9.97
}
```

#### 31. Revenue by product → `revenue_product_segmentation`

Revenue segmentation by product per symbol.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `revenue-product-segmentation`              |
| Scope               | per symbol (universe, preset or list)       |
| Unique key          | `symbol`, `fiscalYear`, `period`            |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | weekly                                      |
| Rows today (live)   | 16,164                                      |

**Data points (6):** `fiscalYear`, `period`, `symbol`, `data`, `date`, `reportedCurrency`

Example (real row from the live workspace):

```json
{
  "fiscalYear": 2026,
  "period": "FY",
  "symbol": "WDFC",
  "data": "{\"Homecare And Cleaning Products\":22051000,\"Other Maintenance Products\":34208000,\"WD-40 Mu",
  "date": "2026-08-31",
  "reportedCurrency": "USD"
}
```

#### 32. Revenue by geography → `revenue_geo_segmentation`

Revenue segmentation by region per symbol.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `revenue-geographic-segmentation`           |
| Scope               | per symbol (universe, preset or list)       |
| Unique key          | `symbol`, `fiscalYear`, `period`            |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | weekly                                      |
| Rows today (live)   | 12,030                                      |

**Data points (6):** `symbol`, `fiscalYear`, `period`, `data`, `date`, `reportedCurrency`

Example (real row from the live workspace):

```json
{
  "symbol": "WDFC",
  "fiscalYear": 2026,
  "period": "FY",
  "data": "{\"Americas Segment\":326177000,\"Asia Pacific Segment\":102526000,\"Europe, India, Middle East",
  "date": "2026-08-31",
  "reportedCurrency": "USD"
}
```

#### 33. Owner earnings → `owner_earnings`

Owner earnings per symbol.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `owner-earnings` with { limit: 10 }         |
| Scope               | per symbol (universe, preset or list)       |
| Unique key          | `symbol`, `fiscalYear`, `period`            |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | weekly                                      |
| Rows today (live)   | 21,324                                      |

**Data points (10):** `symbol`, `fiscalYear`, `period`, `averagePPE`, `date`, `growthCapex`, `maintenanceCapex`, `ownersEarnings`, `ownersEarningsPerShare`, `reportedCurrency`

Example (real row from the live workspace):

```json
{
  "symbol": "IMOS",
  "fiscalYear": "2024",
  "period": "Q4",
  "averagePPE": 0.87904,
  "date": "2024-12-31",
  "growthCapex": 286414087,
  "maintenanceCapex": -1648030087,
  "ownersEarnings": 444127913,
  "ownersEarningsPerShare": 0.6099,
  "reportedCurrency": "TWD"
}
```

### Estimates (6)

#### 34. Analyst grade changes → `analyst_grades`

Latest analyst up/downgrades (news feed).

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `grades-latest-news`                        |
| Scope               | market-wide feed (latest items, paged)      |
| Unique key          | `symbol`, `publishedDate`, `newsURL`        |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | daily                                       |
| Rows today (live)   | 172                                         |

**Data points (11):** `symbol`, `publishedDate`, `newsURL`, `action`, `gradingCompany`, `newGrade`, `newsBaseURL`, `newsPublisher`, `newsTitle`, `previousGrade`, `priceWhenPosted`

Example (real row from the live workspace):

```json
{
  "symbol": "EFSC",
  "publishedDate": "2026-10-23T23:13:09.000Z",
  "newsURL": "https://thefly.com/ajax/news_get.php?id=4448453",
  "action": "upgrade",
  "gradingCompany": "Piper Sandler",
  "newGrade": "Overweight",
  "newsBaseURL": "thefly.com",
  "newsPublisher": "TheFly",
  "newsTitle": "Enterprise Financial upgraded to Overweight from Neutral at Piper Sand\u2026",
  "previousGrade": "Neutral",
  "priceWhenPosted": 61.35
}
```

#### 35. Price target changes → `price_target_changes`

Latest analyst price-target changes (news feed).

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `price-target-latest-news`                  |
| Scope               | market-wide feed (latest items, paged)      |
| Unique key          | `symbol`, `publishedDate`, `newsURL`        |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | daily                                       |
| Rows today (live)   | 200                                         |

**Data points (11):** `newsURL`, `publishedDate`, `symbol`, `adjPriceTarget`, `analystCompany`, `analystName`, `newsBaseURL`, `newsPublisher`, `newsTitle`, `priceTarget`, `priceWhenPosted`

Example (real row from the live workspace):

```json
{
  "newsURL": "https://www.streetinsider.com/Analyst+Comments/Estee+Lauder+%28EL%29+P\u2026",
  "publishedDate": "2026-10-23T12:21:00.000Z",
  "symbol": "EL",
  "adjPriceTarget": 125,
  "analystCompany": "Scotiabank",
  "analystName": "",
  "newsBaseURL": "streetinsider.com",
  "newsPublisher": "StreetInsider",
  "newsTitle": "Estee Lauder (EL) PT Raised to $125 at Piper Sandler; 'Innovation Pipe\u2026",
  "priceTarget": 125,
  "priceWhenPosted": 107.99
}
```

#### 36. Analyst estimates (annual) → `analyst_estimates`

Consensus analyst estimates, annual (quarterly not on Premium).

|                     |                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| FMP endpoint        | `analyst-estimates` with { period: 'annual', limit: 10 }                                                              |
| Scope               | per symbol (universe, preset or list)                                                                                 |
| Unique key          | `symbol`, `date`, `snapshot_date`                                                                                     |
| Sync mode           | Snapshot: current values, upserted in place; plus one appended row per weekly `snapshot_date`, so the history is kept |
| Recommended cadence | weekly                                                                                                                |
| Rows today (live)   | 78,652                                                                                                                |

**Data points (24):** `date`, `snapshot_date`, `symbol`, `ebitAvg`, `ebitHigh`, `ebitLow`, `ebitdaAvg`, `ebitdaHigh`, `ebitdaLow`, `epsAvg`, `epsHigh`, `epsLow`, `netIncomeAvg`, `netIncomeHigh`, `netIncomeLow`, `numAnalystsEps`, `numAnalystsRevenue`, `period`, `revenueAvg`, `revenueHigh`, `revenueLow`, `sgaExpenseAvg`, `sgaExpenseHigh`, `sgaExpenseLow`

Example (real row from the live workspace):

```json
{
  "date": "2026-09-27",
  "symbol": "AAPL",
  "snapshot_date": "2026-10-31",
  "ebitAvg": 160561462251,
  "ebitHigh": 161011073492,
  "ebitLow": 160111851010,
  "ebitdaAvg": 172608825964,
  "ebitdaHigh": 173058437205,
  "ebitdaLow": 172159214723,
  "epsAvg": 8.83686,
  "epsHigh": 8.85681,
  "epsLow": 8.80694,
  "netIncomeAvg": 132519608325,
  "netIncomeHigh": 132893750445,
  "netIncomeLow": 132145466205,
  "numAnalystsEps": 30,
  "…": "8 more fields"
}
```

#### 37. Price target consensus → `price_target_consensus`

Consensus price target per symbol.

|                     |                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| FMP endpoint        | `price-target-consensus`                                                                                              |
| Scope               | per symbol (universe, preset or list)                                                                                 |
| Unique key          | `symbol`, `snapshot_date`                                                                                             |
| Sync mode           | Snapshot: current values, upserted in place; plus one appended row per weekly `snapshot_date`, so the history is kept |
| Recommended cadence | weekly                                                                                                                |
| Rows today (live)   | 5,968                                                                                                                 |

**Data points (6):** `snapshot_date`, `symbol`, `targetConsensus`, `targetHigh`, `targetLow`, `targetMedian`

Example (real row from the live workspace):

```json
{
  "snapshot_date": "2026-10-31",
  "symbol": "AAPL",
  "targetConsensus": 340.88,
  "targetHigh": 400,
  "targetLow": 245,
  "targetMedian": 355
}
```

#### 38. Grades consensus → `grades_consensus`

Analyst buy/hold/sell consensus per symbol.

|                     |                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| FMP endpoint        | `grades-consensus`                                                                                                    |
| Scope               | per symbol (universe, preset or list)                                                                                 |
| Unique key          | `symbol`, `snapshot_date`                                                                                             |
| Sync mode           | Snapshot: current values, upserted in place; plus one appended row per weekly `snapshot_date`, so the history is kept |
| Recommended cadence | weekly                                                                                                                |
| Rows today (live)   | 6,851                                                                                                                 |

**Data points (8):** `snapshot_date`, `symbol`, `buy`, `consensus`, `hold`, `sell`, `strongBuy`, `strongSell`

Example (real row from the live workspace):

```json
{
  "snapshot_date": "2026-10-31",
  "symbol": "AAPL",
  "buy": 69,
  "consensus": "Buy",
  "hold": 33,
  "sell": 9,
  "strongBuy": 1,
  "strongSell": 0
}
```

#### 39. Price target summary → `price_target_summary`

Price-target counts and averages per symbol.

|                     |                                             |
| ------------------- | ------------------------------------------- |
| FMP endpoint        | `price-target-summary`                      |
| Scope               | per symbol (universe, preset or list)       |
| Unique key          | `symbol`                                    |
| Sync mode           | Snapshot: current values, upserted in place |
| Recommended cadence | weekly                                      |
| Rows today (live)   | 1,944                                       |

**Data points (10):** `symbol`, `allTimeAvgPriceTarget`, `allTimeCount`, `lastMonthAvgPriceTarget`, `lastMonthCount`, `lastQuarterAvgPriceTarget`, `lastQuarterCount`, `lastYearAvgPriceTarget`, `lastYearCount`, `publishers`

Example (real row from the live workspace):

```json
{
  "symbol": "BL",
  "allTimeAvgPriceTarget": 58.33,
  "allTimeCount": 30,
  "lastMonthAvgPriceTarget": 0,
  "lastMonthCount": 0,
  "lastQuarterAvgPriceTarget": 29,
  "lastQuarterCount": 2,
  "lastYearAvgPriceTarget": 42.88,
  "lastYearCount": 16,
  "publishers": "[\"StreetInsider\",\"Benzinga\",\"Investing\"]"
}
```

### Ownership (3)

#### 40. Insider trades → `insider_trades`

Latest Form 4 insider transactions across the market.

|                     |                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------- |
| FMP endpoint        | `insider-trading/latest`                                                              |
| Scope               | market-wide feed (latest items, paged)                                                |
| Unique key          | `symbol`, `filingDate`, `transactionDate`, `reportingCik`, `transactionType`, `price` |
| Sync mode           | Snapshot: current values, upserted in place                                           |
| Recommended cadence | daily                                                                                 |
| Rows today (live)   | 588                                                                                   |

**Data points (16):** `reportingCik`, `filingDate`, `price`, `symbol`, `transactionDate`, `transactionType`, `acquisitionOrDisposition`, `companyCik`, `directOrIndirect`, `formType`, `reportingName`, `securitiesOwned`, `securitiesTransacted`, `securityName`, `typeOfOwner`, `url`

Example (real row from the live workspace):

```json
{
  "price": 0.8901,
  "symbol": "UXIN",
  "transactionDate": "2026-10-22",
  "reportingCik": "0001764279",
  "filingDate": "2026-10-23",
  "transactionType": "P-Purchase",
  "acquisitionOrDisposition": "A",
  "companyCik": "0001729173",
  "directOrIndirect": "I",
  "formType": "4",
  "reportingName": "Dai Kun",
  "securitiesOwned": 117231,
  "securitiesTransacted": 7000,
  "securityName": "American depositary shares",
  "typeOfOwner": "director, officer: Chief Executive Officer",
  "url": "https://www.sec.gov/Archives/edgar/data/1729173/000149315226048181/0001493152-26-048181-index.htm"
}
```

#### 41. Congress trades — Senate → `congress_senate`

Latest US Senate trading disclosures.

|                     |                                                                                  |
| ------------------- | -------------------------------------------------------------------------------- |
| FMP endpoint        | `senate-latest`                                                                  |
| Scope               | market-wide feed (latest items, paged)                                           |
| Unique key          | `symbol`, `disclosureDate`, `transactionDate`, `firstName`, `lastName`, `amount` |
| Sync mode           | Snapshot: current values, upserted in place                                      |
| Recommended cadence | daily                                                                            |
| Rows today (live)   | 291                                                                              |

**Data points (15):** `firstName`, `amount`, `disclosureDate`, `lastName`, `symbol`, `transactionDate`, `assetDescription`, `assetType`, `comment`, `district`, `link`, `office`, `owner`, `senateID`, `type`

Example (real row from the live workspace):

```json
{
  "firstName": "Alan",
  "amount": "$15,001 - $50,000",
  "disclosureDate": "2026-07-21",
  "lastName": "Armstrong",
  "symbol": "MFG",
  "transactionDate": "2026-03-30",
  "assetDescription": "Mizuho Financial Group, Inc. Sponosred ADR (Japan)",
  "assetType": "Stock",
  "comment": "",
  "district": "",
  "link": "https://efdsearch.senate.gov/search/view/ptr/fda235b3-bad7-4637-8fa1-0\u2026",
  "office": "Armstrong, Alan (Senator)",
  "owner": "Self",
  "senateID": "A000383",
  "type": "Purchase"
}
```

#### 42. Congress trades — House → `congress_house`

Latest US House trading disclosures.

|                     |                                                                                  |
| ------------------- | -------------------------------------------------------------------------------- |
| FMP endpoint        | `house-latest`                                                                   |
| Scope               | market-wide feed (latest items, paged)                                           |
| Unique key          | `symbol`, `disclosureDate`, `transactionDate`, `firstName`, `lastName`, `amount` |
| Sync mode           | Snapshot: current values, upserted in place                                      |
| Recommended cadence | daily                                                                            |
| Rows today (live)   | 482                                                                              |

**Data points (16):** `firstName`, `amount`, `disclosureDate`, `symbol`, `transactionDate`, `lastName`, `assetDescription`, `assetType`, `capitalGainsOver200USD`, `comment`, `district`, `link`, `office`, `owner`, `senateID`, `type`

Example (real row from the live workspace):

```json
{
  "firstName": "Ro",
  "amount": "$1,001 - $15,000",
  "disclosureDate": "2026-10-09",
  "symbol": "MCK",
  "transactionDate": "2026-09-04",
  "lastName": "Khanna",
  "assetDescription": "McKesson Corp",
  "assetType": "Stock",
  "capitalGainsOver200USD": "False",
  "comment": "",
  "district": "CA17",
  "link": "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/9116376.\u2026",
  "office": "Ro Khanna",
  "owner": "Spouse",
  "senateID": "K000389",
  "type": "Purchase"
}
```

### Leftover raw collections (to be removed)

The live workspace also holds collections from the earlier harness-based sync. M1.03 ([#75](https://github.com/bhajian/StockHarness/issues/75)) archives and drops them. The exception is `earnings_surprises`, which stays until `earnings_calendar` has been backfilled.

| Collection                                                                                 | What it is                                                                                                                                          | Replaced by                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fin_income`, `fin_balance`, `fin_cashflow`, `fin_growth`, `fin_key_metrics`, `fin_ratios` | Old statement and metric pulls (about 3–4k rows each)                                                                                               | `income_statement`, `balance_sheet`, `cash_flow`, `financial_growth`, `key_metrics`, `ratios`                                                                  |
| `earnings_surprises`                                                                       | Old earnings actual-versus-estimate pull (65,584 rows, **long history**)                                                                            | **Keep** until `earnings_calendar` is backfilled: it's the only earnings history today, used by S24–S26. Then it's replaced by the `earnings_events` transform |
| `stock_list`                                                                               | Old full symbol list (40,088 rows)                                                                                                                  | `universe`                                                                                                                                                     |
| `delisted_companies`                                                                       | Written by the **universe** sync: delisted names (`symbol`, `companyName`, `exchange`, `ipoDate`, `delistedDate`), limited to about 100 by the plan | Kept; feeds `universe` and `securities`                                                                                                                        |

---

## 5. Layer 2: Data Prep

### How it works in the app

**Datasets → Transforms**:

- **List:** each transform's inputs, outputs, trigger, last run, rows and duration.
- **"+ New transform" templates:** Blank, Join, **Flatten**, Feature, Snapshot diff.
- **Editor:** three panes.
  - **Inputs** (left): the input collections with their fields. Clicking one inserts an `oh.read_df(...)` snippet.
  - **Python code** (center).
  - **Outputs** (right): one or more collections, each with its key, write mode and `known_at`/`as_of` fields. There are also the trigger (a schedule and/or "after dataset/transform X"), incremental mode with its lookback, params, secrets and field docs.
- **Preview** runs on a sample (20 symbols, 1 year) without writing. It shows the first 100 rows of each output, plus a validation bar: key unique, `known_at` present, schema stable.
- **Saving** creates a version, with diff and restore. Saving is rejected if a non-static output has no `known_at` field.
- **Runs:** logs, rows written per output, and data-quality counts.
- **Catalog → Graph:** the lineage from syncs to collections to transforms to collections to agent tools.

**Layer 2 is optional.** Simple Layer 1 collections are used directly through their declared known-at rule; a transform is created only when it's needed.

**Layer 2 means many flat collections, not one.** A complex Layer 1 dataset is broken into several simple collections, each with one grain and one key. For example, a single fundamentals transform can write `fundamentals_pit`, `fundamentals_lines` and `revenue_segments_pit`. Each collection has exactly one producing transform.

A transform is a small piece of Python that calls the `pipeline` library:

```python
import oh
from pipeline.layer2.prices_logic import compute_symbol_rows

w = oh.window                                    # start, end, lookback_start (lookback 10 trading days)
bars = oh.read_df("eod_prices", {"date": {"$gte": w.lookback_start, "$lte": w.end}})
actions = oh.read_df("corporate_actions", {"ex_date": {"$lte": w.end}})
rows, issues = compute_symbol_rows(bars, actions, window=w)   # adjusted prices, returns, DQ flags
oh.output("prices_daily").upsert_df(rows[rows.date >= w.start])  # write only [start, end]
for i in issues:
    oh.dq(i.type, i.severity, security_id=i.security_id, date=i.date)
```

### Layer 2 datasets that exist today

These run today as pipeline modules. They become Transforms in M2. The examples are real rows.

#### `trading_calendar`: NYSE trading days (static)

**Data points:** `date`, `is_trading_day`, `open_utc`, `close_utc`, `is_early_close`, `prev_trading_day`, `next_trading_day` · **Rows:** 9,569 (extends to 2027)

```json
{
  "date": "2027-12-31",
  "is_trading_day": true,
  "open_utc": "2027-12-31T14:30:00Z",
  "close_utc": "2027-12-31T21:00:00Z",
  "is_early_close": false,
  "prev_trading_day": "2027-12-30",
  "next_trading_day": null
}
```

#### `securities`: one row per security, with identity over time

**Data points:**

- `security_id`, `name`, `security_type`, `country`, `currency`,
- `identifiers[]` (ticker, cik, cusip, isin, each with `valid_from`/`valid_to`),
- `sector_history[]`, `industry_history[]`, `exchange_history[]`,
- `ipo_date`, `is_active`, `delisted_date`, `_lineage`.

**Rows:** 2,161

```json
{
  "security_id": "SEC_000008",
  "name": "Apple Inc.",
  "security_type": "common",
  "country": "US",
  "currency": "USD",
  "identifiers": [
    { "type": "ticker", "value": "AAPL", "valid_from": "1980-12-12", "valid_to": null },
    { "type": "cik", "value": "0000320193", "valid_from": "1980-12-12", "valid_to": null },
    { "type": "cusip", "value": "037833100", "valid_from": "1980-12-12", "valid_to": null }
  ],
  "sector_history": [{ "value": "Technology", "valid_from": "2026-10-23T20:35:26Z", "valid_to": null }],
  "ipo_date": "1980-12-12",
  "is_active": true
}
```

The M2.10 migration fixes three problems here:

- sector, industry and exchange bounds become ISO dates instead of timestamps (H4),
- backfilled sectors are flagged with `sector_is_backfilled` (H5),
- a ticker's `valid_from` becomes the first date it was observed, not the IPO date (H6).

#### `corporate_actions`: deduplicated splits and dividends, full history

**Data points:** `security_id`, `action_type` (`split` / `cash_dividend` / `special_dividend`), `ex_date`, `record_date`, `pay_date`, `declaration_date`, `dividend_amount`, `currency`, `split_ratio`, `split_type`, `known_at`, `_lineage` · **Rows:** 95,744

```json
{ "security_id": "SEC_000008", "action_type": "cash_dividend", "ex_date": "2026-08-10", "record_date": "2026-08-10",
  "pay_date": "2026-08-13", "declaration_date": "2026-07-30", "dividend_amount": 0.27, "currency": "USD", "known_at": "2026-07-30" }
{ "security_id": "SEC_000008", "action_type": "split", "ex_date": "2020-08-31", "split_ratio": 4, "split_type": "stock-split", "known_at": "2020-08-30" }
```

#### `prices_daily`: adjusted daily prices and total returns, one row per security per trading day

**Data points:**

- `security_id`, `ticker`, `date`,
- `open`, `high`, `low`, `close`, `volume`, `vwap`,
- `adj_factor`, `adj_open`, `adj_high`, `adj_low`, `adj_close`, `dollar_volume`,
- `ret_1d` (price return), `tr_1d` (total return including dividends), `dq_flags[]`,
- `known_at`, `as_of_date`, plus the lineage fields.

**Rows:** 2,372,732

```json
{
  "security_id": "SEC_000008",
  "ticker": "AAPL",
  "date": "2026-10-23",
  "open": 349.12,
  "high": 351.73,
  "low": 345.75,
  "close": 347.73,
  "volume": 39323315,
  "vwap": 348.58,
  "adj_factor": 1,
  "adj_close": 347.73,
  "dollar_volume": 13673896324.95,
  "ret_1d": -0.00141,
  "tr_1d": -0.00141,
  "dq_flags": [],
  "known_at": "2026-10-23T20:00:00Z",
  "as_of_date": "2026-10-23",
  "source_collection": "eod_prices",
  "transform_name": "build_prices_daily",
  "transform_version": "1"
}
```

#### `macro_daily`: one row per trading day of market and macro context

**Data points:** `date`, `ust_3m`, `ust_2y`, `ust_10y`, `ust_30y`, `curve_10y_2y`, `curve_10y_3m`, `vix`, `spx_close`, `ndx_close`, `rut_close`, `spx_ret_1d`, `sector_returns{}`, `known_at`, `as_of_date`, `transform_name`, `transform_version` · **Rows:** 1,278

```json
{
  "date": "2026-10-23",
  "ust_3m": 4.25,
  "ust_2y": 4.81,
  "ust_10y": 5.13,
  "ust_30y": 5.42,
  "curve_10y_2y": 0.32,
  "curve_10y_3m": 0.88,
  "vix": 19.45,
  "spx_close": 7623.68,
  "ndx_close": 25955.34,
  "spx_ret_1d": -0.00519,
  "sector_returns": {
    "Energy": 3.09,
    "Technology": 0.76,
    "Consumer Defensive": -1.34,
    "…": "8 more sectors"
  },
  "known_at": "2026-10-23T20:00:00Z",
  "as_of_date": "2026-10-23"
}
```

#### `dq_issues`: the data-quality log

**Data points:** `collection`, `transform_name`, `severity`, `issue_type`, `security_id`, `date`, `detected_at`, `resolved` · **Rows:** 73,155. By type: `zero_volume` 41,761 · `jump_no_action` (a price jump with no split or dividend) 28,619 · `stale_price` 2,775. M2.03 and M2.11 make these writes idempotent (H2).

```json
{
  "collection": "prices_daily",
  "transform_name": "build_prices_daily",
  "severity": "warn",
  "issue_type": "jump_no_action",
  "security_id": "SEC_002072",
  "date": "2025-08-14",
  "detected_at": "2026-11-04T00:02:45Z",
  "resolved": false
}
```

### Layer 2 datasets to come (planned)

| Collection                    | Grain / key                                                                            | Built from                                                           | Main data points                                                                                                                                                                                                | Milestone |
| ----------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `fundamentals_pit`            | security × fiscal period × version · `[security_id, period_end, period_type, version]` | `income_statement`, `balance_sheet`, `cash_flow`                     | revenue, gross profit, operating income, net income, EPS (diluted), shares, total assets/equity/debt, cash, operating cash flow, capex, FCF, the TTM versions of each, `is_latest`, `known_at` = `acceptedDate` | M2.12     |
| `fundamentals_lines`          | security × period × line item × version                                                | the same statements                                                  | every statement line as one row (`line`, `value_usd`, `statement`), for flexible queries                                                                                                                        | M2.12     |
| `revenue_segments_pit`        | security × period × segment × kind                                                     | the two segmentation datasets                                        | `segment`, `kind` (`product`/`geo`), `revenue_usd`, `share_of_total`, `known_at`                                                                                                                                | M2.12     |
| `universe_daily`              | security × date                                                                        | `prices_daily`, `securities`, `historical_market_cap`                | `in_universe`, `market_cap`, `adv_20d_usd`, `price`, `exchange`, `reason_excluded`. The market-cap floor is applied **as of each date**                                                                         | M2.13     |
| `features_daily`              | security × date                                                                        | `prices_daily`, `fundamentals_pit`, events, `macro_daily`            | ≈ 80 features in the families below                                                                                                                                                                             | M2.14     |
| `features_ranked`             | security × date                                                                        | `features_daily`                                                     | sector rank, cross-sectional z-score and percentile per feature; composites (`value_score`, `quality_score`, `momentum_score`, `growth_score`, `revisions_score`)                                               | M2.14     |
| `regime_daily`                | date                                                                                   | `macro_daily`, `prices_daily`                                        | `trend_regime` (SPX vs its 200-day), `vol_regime` (VIX bucket), `curve_regime` (10y–2y sign), `breadth` (% of names above their 50-day)                                                                         | M2.14     |
| `estimates_snapshots`         | security × fiscal year × snapshot_date                                                 | `analyst_estimates`                                                  | `eps_avg/high/low`, `revenue_avg`, `num_analysts`, `eps_rev_4w`, `eps_rev_12w`, `dispersion`                                                                                                                    | M8.01     |
| `analyst_consensus_snapshots` | security × snapshot_date                                                               | `grades_consensus`, `price_target_consensus`, `price_target_summary` | `buy/hold/sell` counts, `consensus`, `pt_consensus`, `pt_upside`, `pt_change_4w`                                                                                                                                | M8.01     |
| `analyst_events`              | security × event                                                                       | `analyst_grades`, `price_target_changes`                             | `firm`, `from_grade` → `to_grade` (normalized −2…+2), `action`, `pt_old/pt_new`, `known_at` = `publishedDate`                                                                                                   | M8.01     |
| `earnings_events`             | security × report date                                                                 | `earnings_calendar`, SEC 8-K Item 2.02                               | `eps_actual`, `eps_est`, `sue` (standardized surprise), `rev_surprise`, `announce_timing` (BMO/AMC/unknown), `reaction_date`                                                                                    | M8.01     |
| `insider_trades_pit`          | security × filing × reporter × transaction                                             | `insider_trades`                                                     | `role` (CEO/CFO/director/10% owner), `code` (P/S/A/F/M), `shares`, `value_usd`, `ownership_change_pct`, `is_open_market`, `known_at` = `filingDate`                                                             | M8.01     |
| `congress_trades`             | security × disclosure × member                                                         | `congress_senate`, `congress_house`                                  | `chamber`, `member`, `side`, `amount_low/high`, `owner`, `lag_days`, `known_at` = `disclosureDate`                                                                                                              | M8.01     |
| `holdings_13f`, `filers_13f`  | filer × security × quarter                                                             | SEC EDGAR + OpenFIGI                                                 | shares, value, put/call, change versus the prior quarter, number of holders                                                                                                                                     | M8.02     |
| `index_membership`            | security × index × interval                                                            | needs a data upgrade                                                 | `index`, `valid_from`, `valid_to`                                                                                                                                                                               | M8.04     |

#### `features_daily` feature families (planned)

| Family                                                              | Example features (all computed from data with `as_of_date <= D`)                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Momentum / trend                                                    | `mom_12_1` (12-month return skipping the last month), `mom_6_1`, `ret_1m`, `ret_1w`, `pct_from_52w_high`, `above_sma200`, `industry_mom_6m` |
| Risk                                                                | `vol_60d`, `beta_252d` vs SPX, `idio_vol_60d`, `max_drawdown_252d`, `downside_vol_60d`                                                      |
| Liquidity / size                                                    | `log_mcap`, `adv_20d_usd`, `amihud_illiq_60d`, `turnover_60d`                                                                               |
| Value                                                               | `earnings_yield_ttm`, `fcf_yield_ttm`, `ev_ebitda_ttm`, `book_to_market`, `sales_to_ev`, sector-relative versions                           |
| Quality                                                             | `gross_profitability` (GP/assets), `roic_ttm`, `accruals_ratio`, `piotroski_f`, `altman_z`, `net_debt_to_ebitda`                            |
| Growth                                                              | `rev_growth_yoy`, `rev_accel` (change in YoY growth), `eps_growth_yoy`, `gross_margin_chg_yoy`, `asset_growth_yoy`                          |
| Capital actions                                                     | `net_share_issuance_12m`, `dividend_yield`, `div_growth_3y`, `days_since_div_increase`                                                      |
| Events                                                              | `days_since_earnings`, `last_sue`, `sue_streak`, `days_to_next_earnings`                                                                    |
| Estimates & analysts _(forward-only until snapshot history builds)_ | `eps_rev_4w`, `eps_rev_12w`, `est_dispersion`, `pt_upside`, `net_upgrades_30d`                                                              |
| Ownership _(forward-only until feed history builds)_                | `insider_net_buy_usd_90d`, `insider_buyers_90d`, `congress_net_buys_90d`                                                                    |

Example `features_daily` row (planned, illustrative values):

```json
{
  "security_id": "SEC_000008",
  "date": "2026-10-23",
  "mom_12_1": 0.214,
  "pct_from_52w_high": -0.031,
  "vol_60d": 0.244,
  "beta_252d": 1.12,
  "log_mcap": 29.25,
  "earnings_yield_ttm": 0.026,
  "fcf_yield_ttm": 0.029,
  "gross_profitability": 0.42,
  "roic_ttm": 0.51,
  "piotroski_f": 9,
  "altman_z": 13.5,
  "rev_growth_yoy": 0.061,
  "rev_accel": 0.012,
  "last_sue": 1.8,
  "days_to_next_earnings": 6,
  "known_at": "2026-10-23T20:00:00Z",
  "as_of_date": "2026-10-23",
  "transform_version": "1"
}
```

---

## 6. The Schema Catalog

`dataset_catalog` (planned, M1.12) holds one document per collection, auto-refreshed after every sync or transform run. It's what agents read through `describe_collection`, and it's shown in **Datasets → Catalog**.

```json
{
  "collection": "prices_daily",
  "layer": 2,
  "produced_by": { "type": "transform", "name": "prices_daily", "version": "3" },
  "description": "Split/dividend-adjusted daily prices with total returns.",
  "grain": "one row per security_id per trading date",
  "primary_key": ["security_id", "date"],
  "time_semantics": {
    "event_date": "date",
    "known_at": "known_at",
    "as_of": "as_of_date",
    "rule": "EOD: known at 16:00 ET close, usable same day"
  },
  "fields": [
    {
      "name": "adj_close",
      "type": "float",
      "unit": "USD",
      "description": "Close adjusted for splits and dividends",
      "null_pct": 0.0,
      "min": 0.01,
      "max": 6500.0,
      "example": 347.73
    }
  ],
  "coverage": {
    "rows": 2372732,
    "symbols": 2081,
    "universe_coverage_pct": 92.5,
    "date_min": "2021-10-25",
    "date_max": "2026-10-23",
    "missing_days_pct": 0.4
  },
  "freshness": { "cadence": "daily after eod_prices", "last_updated": "2026-11-04T00:02:48Z" },
  "caveats": ["Delisted coverage limited to ~100 names on current FMP plan (survivorship bias)"],
  "joins": [
    { "to": "securities", "on": "security_id" },
    { "to": "features_daily", "on": ["security_id", "date"] }
  ]
}
```

In the app, **Catalog** shows:

- the collections by layer, each with a documentation-completeness %,
- per collection, the tabs Fields (descriptions editable inline), Coverage (charts and a gap heatmap), Time semantics, Caveats, Sample, Joins, and **Agent view** (exactly what agents receive, with its token size),
- **Export for agents**, which produces Markdown for prompts and skills.

---

## 7. Layer 3: Research agents

### How it works in the app

**Research Lab** is the control room:

- **KPIs:** theories today, in flight, success rate, total trials, tokens and cost.
- **Pipeline board:** Draft → Pre-review → Coding → Evaluating → Post-review → Verdict.
- **Live activity feed** and charts.
- **Settings:**
  - models per role: the Theorist and the Judge use **different** models,
  - focus and steering, e.g. "explore insider and earnings families this week",
  - versioned success gates, which are locked while the loop runs,
  - budget alerts and the schedule.

The loop runs as one OpenHarness workflow, N theories in parallel, continuously or in a nightly window.

```
Theorist ──submit_theory──► Judge (pre-code) ──approved──► Coder ──evaluate_strategy──► trusted Evaluator
   ▲                           │ revise (≤3)                  │ code_error → fix                 │
   └──── human "Send back" ────┘                              ▼                                  ▼
                                  Judge (post-result) ◄──── evaluation record (numbers + series)
                                        │
                     FAILED / SUCCESSFUL (mechanical gates) ──► Ideas (Layer 4)
```

### The agents

| Agent                                       | Reads                                                                                       | Writes                                                                                 | Tools                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Theorist**                                | the catalog, seed skills, theory memory (past successes and failures), human steering notes | a testable theory                                                                      | `list_collections`, `describe_collection`, `sample_collection`, `query_collection` (as_of), `search_theories`, `submit_theory` |
| **Judge**                                   | the theory, the catalog and caveats, similar past theories, evaluation records              | a critique, revision requests, a verdict (it can only **downgrade** a mechanical pass) | `describe_collection`, `search_theories`, `get_theory`, `review_theory`, `set_verdict`                                         |
| **Coder**                                   | the approved theory, the catalog, the plugin skill                                          | a versioned strategy plugin                                                            | `run_python` (exploration, parallel `params_list`), `query_collection`, `submit_code`, `evaluate_strategy`                     |
| **Evaluator** (platform code, not an agent) | the plugin and as_of-filtered data                                                          | the evaluation record and the trial count                                              | runs in the Python executor                                                                                                    |

### Skills the agents load

Skills are the platform's reusable instructions. The agent sees each skill's one-line "when to use", and loads the full text with `load_skill`.

| Skill                                                                           | Used by                | When to use                                                                                    | What it contains                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **strategy-library** ([skills/strategy-library.md](skills/strategy-library.md)) | Theorist, Coder, Judge | "Use when proposing a theory, turning one into a plugin, or checking testability and novelty." | **42 strategy cards (S01–S42):** how each works, the exact signal formula, the real collections and field names it uses today (and the Layer 2 equivalents), default parameters, what to explore, point-in-time traps and status. Also the point-in-time rules for every data source, a plugin template, and how to derive a new theory from a card. Importable via `deploy/config-io/exports/skills.yaml`. |
| **read-the-catalog**                                                            | all                    | "Use before reading any collection or writing code against data."                              | How to call `list/describe/sample/query_collection`, the point-in-time rules (`known_at`/`as_of_date`), the meaning of the fields that recur, joining on `security_id`, and how to read caveats.                                                                                                                                                                                                            |
| **write-a-strategy-plugin**                                                     | Coder                  | "Use when turning an approved theory into code."                                               | The plugin contract (`universe`, `signal`, `META`), `ctx.read_df` usage, worked examples (momentum, value, event-driven), common errors and how to fix them, and what's forbidden (no raw database access, no IO, no future dates).                                                                                                                                                                         |
| **judge-checklist**                                                             | Judge                  | "Use for every pre-code and post-result review."                                               | The checklists below, the meaning of each gate, how to cite evaluation numbers, and when to downgrade.                                                                                                                                                                                                                                                                                                      |
| **propose-a-theory**                                                            | Theorist               | "Use when writing a theory record."                                                            | The required fields, a good example and a bad one, how to state a falsification condition, and how to check novelty with `search_theories`.                                                                                                                                                                                                                                                                 |
| **diagnose-a-failed-evaluation**                                                | Coder, Judge           | "Use when an evaluation fails gates or errors."                                                | How to read fold tables, factor exposures and the by-year breakdown, and how to tell a code bug from a real lack of edge without p-hacking.                                                                                                                                                                                                                                                                 |

**Judge checklist (pre-code):**

1. Is it testable with the data that exists, over enough history?
2. Is every input point-in-time (no lookahead)?
3. Is it novel? The `search_theories` cosine similarity must be below 0.9, or the theory must state what's different.
4. Is it economically plausible?
5. Is it falsifiable?
6. Do caveats affect it (survivorship, short history, forward-only data)?

**Judge checklist (post-result):**

1. Are the out-of-sample folds consistent?
2. Does it survive costs?
3. Is the edge spread across years and sectors, rather than concentrated in a few?
4. Is it a known factor in disguise (check the factor exposures and alpha t-stat)?
5. Is the holdout positive?
6. Is the trade count large enough?
7. Do any caveats block it?

### Strategy ideas the agents explore

The full cards are in the **strategy-library** skill, [skills/strategy-library.md](skills/strategy-library.md). Each one gives the exact signal, the fields, parameters, traps and status. The table below summarizes them.

**Backtestable** means the data has history today. After the M1 backfill that's 10 years of prices and 40 quarters of statements. **Forward-only** means FMP keeps no history for the data, so the idea is paper-tracked live (Layer 5) until enough history builds up. **Blocked** means it needs data the current plan doesn't provide.

| Card | Family           | Idea                            | Hypothesis / signal sketch                                                        | Data used                                     | Horizon · side             | Status                                                                                                       |
| ---- | ---------------- | ------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| S01  | Momentum         | 12-1 momentum                   | Past 12-month winners (skipping the last month) keep outperforming                | `prices_daily`                                | 1–3 m · long or long/short | Backtestable now (from 2022); 10y after M1                                                                   |
| S02  | Momentum         | 52-week-high proximity          | Stocks near their 52-week high under-react to good news                           | `prices_daily`                                | 1–6 m · long               | Backtestable now                                                                                             |
| S03  | Momentum         | Industry momentum               | Industries that rose most over 6 months keep rising                               | `prices_daily`, `securities` (industry)       | 1–3 m · long/short         | Backtestable now (with the caveat)                                                                           |
| S04  | Momentum         | Residual momentum               | Momentum after removing market and sector beta crashes less                       | `prices_daily`, `macro_daily`                 | 1–3 m · long/short         | After M1 backfill (needs ≥ 3y of warm-up)                                                                    |
| S05  | Trend            | Trend filter                    | Hold only names above their 200-day average; cut exposure when SPX < 200-day      | `prices_daily`, `regime_daily`                | weekly · long              | Backtestable now                                                                                             |
| S06  | Reversal         | Short-term reversal             | The worst 1-week losers among liquid large caps bounce                            | `prices_daily`                                | 1–2 w · long               | Backtestable now (without the news filter)                                                                   |
| S07  | Reversal         | Long-term reversal              | 3–5 year losers outperform                                                        | `prices_daily`                                | 1 y · long                 | After M1 backfill                                                                                            |
| S08  | Low risk         | Low volatility                  | The lowest-volatility names deliver similar returns with less risk                | `prices_daily`                                | 1–3 m · long               | Backtestable now                                                                                             |
| S09  | Low risk         | Betting against beta            | Low-beta names beat high-beta names on a risk-adjusted basis                      | `prices_daily`, `macro_daily`                 | 1–3 m · long/short         | Backtestable now (long-only, or long/short with the caveat)                                                  |
| S10  | Value            | Earnings yield                  | High TTM E/P within each sector outperforms                                       | `fundamentals_pit`, `prices_daily`            | 6–12 m · long              | After M1 backfill (quarterly); backtestable now on annual data with a 90-day lag                             |
| S11  | Value            | Free-cash-flow yield            | High FCF/EV with positive FCF outperforms                                         | `fundamentals_pit`, `enterprise_values`       | 6–12 m · long              | After M1 backfill                                                                                            |
| S12  | Value            | EV/EBITDA, sector-relative      | The cheapest third of each sector beats the most expensive                        | `fundamentals_pit`                            | 6–12 m · long/short        | After M1 backfill                                                                                            |
| S13  | Quality          | Gross profitability             | High gross profit / assets outperforms                                            | `fundamentals_pit`                            | 6–12 m · long              | After M1 backfill; backtestable now on annual `ratios.grossProfitMargin` × `ratios.assetTurnover` with a lag |
| S14  | Quality          | Piotroski F-score               | F-score 8–9 among cheap stocks beats F-score 0–2                                  | `fundamentals_pit` (recomputed point-in-time) | 6–12 m · long/short        | After M1 backfill (forward-only if using `financial_scores`)                                                 |
| S15  | Quality          | Low accruals                    | Earnings backed by cash (low accruals) outperform                                 | `fundamentals_pit`                            | 6–12 m · long              | After M1 backfill                                                                                            |
| S16  | Quality          | Distress avoidance              | Low Altman Z names underperform, so avoid or short them                           | `fundamentals_pit`                            | 6–12 m · short or filter   | After M1 backfill (best used as a filter)                                                                    |
| S17  | Investment       | Asset growth                    | Firms growing assets fastest underperform                                         | `fundamentals_pit`                            | 12 m · long/short          | After M1 backfill; backtestable now on annual data with a lag                                                |
| S18  | Capital actions  | Net share buybacks              | Shrinking share count (buybacks) outperforms; heavy issuers lag                   | `fundamentals_pit` (shares)                   | 12 m · long/short          | After M1 backfill                                                                                            |
| S19  | Capital actions  | Dividend initiation or increase | Prices drift up after a dividend initiation or raise                              | `corporate_actions`, `dividends_history`      | 1–6 m · long               | Backtestable now (dividend history back to 1977; price history is the binding constraint)                    |
| S20  | Capital actions  | Post-split drift                | Stocks drift up after a forward split                                             | `corporate_actions`                           | 1–6 m · long               | Backtestable now                                                                                             |
| S21  | Growth           | Revenue acceleration            | Accelerating YoY revenue growth with expanding margins outperforms                | `fundamentals_pit`                            | 3–12 m · long              | After M1 backfill                                                                                            |
| S22  | Growth           | Margin expansion                | A rising gross margin year over year predicts outperformance                      | `fundamentals_pit`                            | 3–12 m · long              | After M1 backfill                                                                                            |
| S23  | Growth           | Segment concentration shift     | A fast-growing segment taking share of revenue drives re-rating                   | `revenue_segments_pit`                        | 6–12 m · long              | Backtestable now on annual (FY) rows with a lag; coverage-limited                                            |
| S24  | Earnings         | Post-earnings drift (PEAD)      | Large positive surprises keep drifting for about 60 days                          | `earnings_events`                             | 40–60 d · long/short       | Backtestable now (via `earnings_surprises` plus 5y of prices)                                                |
| S25  | Earnings         | Surprise streaks                | 3+ consecutive beats predict another beat and drift                               | `earnings_events`                             | 40–60 d · long             | Backtestable now                                                                                             |
| S26  | Earnings         | Pre-earnings run-up             | High-attention names drift up into earnings                                       | `earnings_calendar`, `prices_daily`           | 5–10 d · long              | Backtestable now (with the caveat)                                                                           |
| S27  | Estimates        | EPS revision momentum           | Upward consensus EPS revisions over 4–12 weeks predict returns                    | `estimates_snapshots`                         | 1–3 m · long/short         | **Forward-only**                                                                                             |
| S28  | Estimates        | Estimate dispersion             | High analyst disagreement predicts underperformance                               | `estimates_snapshots`                         | 1–3 m · short or filter    | **Forward-only** (best used as a filter)                                                                     |
| S29  | Analysts         | Price-target upside             | Large, rising consensus price-target upside, filtered by quality                  | `analyst_consensus_snapshots`                 | 3–6 m · long               | **Forward-only**                                                                                             |
| S30  | Analysts         | Upgrade drift                   | Prices drift after upgrades by top firms                                          | `analyst_events`                              | 1–2 m · long               | **Forward-only**                                                                                             |
| S31  | Insiders         | Insider cluster buys            | 3+ insiders buying on the open market within 30 days, especially after a drawdown | `insider_trades_pit`, `prices_daily`          | 1–6 m · long               | **Forward-only**                                                                                             |
| S32  | Insiders         | CEO/CFO purchases               | Open-market buys by the CEO or CFO above $100k                                    | `insider_trades_pit`                          | 3–6 m · long               | **Forward-only**                                                                                             |
| S33  | Congress         | Congressional buys              | Net buying by members, accounting for disclosure lag                              | `congress_trades`                             | 1–6 m · long               | **Forward-only**                                                                                             |
| S34  | Ownership        | 13F crowding / new positions    | Rising institutional ownership and new high-conviction positions                  | `holdings_13f`                                | 1–2 q · long               | Blocked until M8.02                                                                                          |
| S35  | Index            | Index addition                  | Names likely to be added to the S&P 500                                           | `index_membership`                            | 1–3 m · long               | Blocked                                                                                                      |
| S36  | Size / liquidity | Illiquidity premium             | Less-liquid quality names earn a premium after costs                              | `prices_daily`, `fundamentals_pit`            | 3–12 m · long              | Backtestable now                                                                                             |
| S37  | Macro overlay    | VIX regime                      | Cut gross exposure when VIX is in its top quintile                                | `macro_daily`, `regime_daily`                 | daily · overlay            | Backtestable now                                                                                             |
| S38  | Macro overlay    | Yield-curve regime              | Rotate toward quality and low volatility when 10y–2y inverts                      | `macro_daily`                                 | monthly · overlay          | Backtestable now (few regime changes in 5 years, so the evidence is thin; say so)                            |
| S39  | Sector rotation  | Rate-sensitive rotation         | Sector tilts based on a rising or falling 10-year yield                           | `macro_daily`, `prices_daily`                 | 1–3 m · long/short         | Backtestable now (short history)                                                                             |
| S40  | Seasonality      | Turn-of-month / January         | Returns concentrate around month turns, and small caps in January                 | `prices_daily`                                | days · long                | Backtestable now                                                                                             |
| S41  | Combination      | Quality + value + momentum      | A composite of `quality_score`, `value_score` and `momentum_score`                | `features_ranked`                             | 1–3 m · long               | After M1 backfill (fundamental components)                                                                   |
| S42  | News             | Abnormal news volume            | News spikes without a price move precede a move                                   | `news_stocks`                                 | 1–5 d · long/short         | **Forward-only**                                                                                             |

The Theorist combines and refines these, for example "insider cluster buys **after** a 20% drawdown in quality names". The Judge rejects near-duplicates of theories already tested.

### A worked example, end to end

**1. The Theorist submits a theory** (`theories` collection, planned M4.01):

```json
{
  "id": "T-0233",
  "status": "pre_review",
  "family": "earnings",
  "title": "Post-earnings drift in profitable mid caps",
  "hypothesis": "Mid caps with SUE > 2 and positive gross profitability keep outperforming their sector for 40 trading days.",
  "rationale": "Investors under-react to earnings news in less-covered names; profitability filters out low-quality beats.",
  "data_needed": ["earnings_events", "fundamentals_pit", "prices_daily", "universe_daily"],
  "universe": "universe_daily, market cap $2B–$20B",
  "signal_logic": "rank by last_sue among names reported in last 5 days, gross_profitability > 0",
  "horizon_days": 40,
  "side": "long",
  "falsification": "OOS excess vs sector ≤ 0 or holdout negative",
  "similar_theories": [
    { "id": "T-0118", "cosine": 0.81, "difference": "adds profitability filter and mid-cap universe" }
  ]
}
```

**2. The Judge reviews it before any code** (`review_theory`):

```json
{
  "theory_id": "T-0233",
  "stage": "pre_code",
  "decision": "approved_for_code",
  "checks": {
    "testable": "yes, earnings_events 2016+",
    "lookahead": "use reaction_date, not report date",
    "novelty": "0.81 vs T-0118, difference stated",
    "caveats": ["delisted coverage limited (survivorship)"]
  },
  "notes": "Enter at reaction_date close; announce_timing unknown → next session (conservative)."
}
```

**3. The Coder writes, tests and fixes the plugin.** It runs `test_strategy`, a dry run on a small sample, reads any error (traceback with line numbers, and the real column names when a field is wrong), fixes it, and re-tests up to about 5 times. Only then does it call `evaluate_strategy` (M3.09). Here's the plugin (`submit_code`, version 2 after one fixed error):

```python
META = {"side": "long", "horizon_days": 40, "rebalance": "daily", "top_n": 30}

def universe(ctx):
    u = ctx.read_df("universe_daily", {"date": ctx.date, "in_universe": True}, columns=["security_id", "market_cap"])
    return u[(u.market_cap > 2e9) & (u.market_cap < 2e10)].security_id.tolist()

def signal(ctx):
    ev = ctx.read_df("earnings_events", {"reaction_date": {"$gte": ctx.days_ago(5)}}, columns=["security_id", "sue"])
    q = ctx.read_df("features_daily", {"date": ctx.date}, columns=["security_id", "gross_profitability"])
    df = ev.merge(q, on="security_id")
    df = df[(df.sue > 2) & (df.gross_profitability > 0)]
    return dict(zip(df.security_id, df.sue))   # ctx.read_df never returns rows with as_of_date > ctx.date
```

**4. The trusted evaluator runs it** (`evaluations` record, planned M3.02–M3.04; a summary of the record is shown here):

```json
{
  "theory_id": "T-0233",
  "code_version": 2,
  "code_hash": "9f2c…",
  "evaluator_version": "1.4.0",
  "data_snapshot": "2026-11-02",
  "costs": { "commission_bps": 1, "slippage_bps": 5 },
  "trials_total": 1412,
  "metrics": {
    "oos_sharpe": 0.71,
    "deflated_sharpe_prob": 0.97,
    "cagr": 0.118,
    "excess_vs_sector_ann": 0.041,
    "max_drawdown": -0.14,
    "hit_rate": 0.56,
    "trades": 1240,
    "avg_holdings": 22,
    "pct_years_positive": 0.78,
    "alpha_tstat": 2.6,
    "turnover_ann": 9.1
  },
  "folds": [{ "train": "2016–2019", "test": "2020", "is_sharpe": 0.9, "oos_sharpe": 0.62 }],
  "holdout": {
    "period": "2025-05..2026-10",
    "excess": 0.022,
    "sharpe": 0.48,
    "evaluated_once_at": "2026-11-02"
  },
  "factor_exposures": { "market": 0.92, "size": 0.31, "value": 0.05, "momentum": 0.12, "quality": 0.18 },
  "series": { "equity": { "dates": ["…"], "series": { "strategy": ["…"], "spx": ["…"] } } }
}
```

**5. The Judge reviews the result, and the verdict is set.** The gates are mechanical (OOS Sharpe ≥ 0.5, DSR ≥ 0.95, ≥ 60% positive years, holdout positive, ≥ 100 trades, alpha t ≥ 2, no blocking caveats). All pass, so the verdict is **SUCCESSFUL**, with the Judge's summary: _"Edge concentrated in mid caps; survives costs; not explained by value or momentum. Caveat: delisted coverage limited."_ The idea now appears in **Ideas** for a human to review.

---

## 8. Layer 4: Ideas and simulations

### Ideas: how it works in the app

**Ideas** lists every theory. The default view shows Successful and Approved, sorted by deflated Sharpe. Failed ideas are one filter away and never hidden. Opening an idea shows its **proof pack**:

| Tab      | Shows                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header   | The verdict gate checklist (value against threshold), KPI cards, the Judge's summary, and the actions **Approve · Schedule simulation · Send back… · Park · Reject**                                                                  |
| Overview | Thesis, rationale, falsification condition, universe, horizon, and the data used (chips linking to catalog entries, with caveats inline)                                                                                              |
| Results  | Equity against SPX and the sector with drawdown; returns by year, regime and sector; rolling Sharpe with the gate line; the walk-forward fold table; the holdout panel ("evaluated once"); factor exposures; a trade-return histogram |
| Debate   | A timeline of every turn by the Theorist, Judge, Coder, Evaluator and humans. Cited numbers link to their evaluation; a number with no source is flagged **unsourced**                                                                |
| Code     | The plugin with its versions and diffs, and the evaluator version; "Open as transform" reuses the signal as a Layer 2 feature                                                                                                         |
| Runs     | Every evaluation, with **Reproduce** and a match/mismatch badge                                                                                                                                                                       |
| Comments | Human feedback. **Send back** returns the idea to the Theorist with your comment in its context                                                                                                                                       |

**Compare** (2–4 ideas) overlays their equity curves, puts their metrics side by side, and shows return correlation and holdings overlap.

### Simulations: how it works in the app

From an approved idea, or from Compare, choose **Schedule simulation**:

- the ideas to include and the period (e.g. 2016-01-04 → 2026-11-03),
- capital and benchmark,
- allocation (equal / risk parity / custom) and sizing (quarter-Kelly with a cap, or equal weight),
- constraints (maximum positions, sector cap, gross and net), costs, and a seed.

The shared **paper broker** replays the period day by day:

- it fills at the next close, with commission and slippage,
- shorts pay borrow,
- it applies exits (stop, take-profit, horizon, invalidation) with reasons,
- it handles corporate actions.

**Simulation detail** has these tabs:

- **Performance:** equity, drawdown, exposure and a monthly returns heatmap.
- **Trades:** a blotter with exit reasons.
- **Positions:** a time scrubber.
- **Attribution:** by idea, sector, side and exit reason.
- **Config:** with clone and edit.

A completed simulation of an approved idea shows **Go live (paper)**.

Simulation records (planned, M6.01):

```json
// sim_trades
{ "sim_id": "SIM-0042", "idea_id": "T-0233", "security_id": "SEC_000123", "ticker": "JNJ", "side": "long",
  "entry_date": "2021-03-02", "entry_price": 157.10, "qty": 1910, "exit_date": "2021-04-28", "exit_price": 166.42,
  "exit_reason": "horizon", "pnl_usd": 17801.2, "return": 0.0593, "excess_vs_sector": 0.0211, "costs_usd": 180.4,
  "signal_at_entry": { "sue": 2.7, "gross_profitability": 0.31 } }
// sim_portfolio_daily
{ "sim_id": "SIM-0042", "date": "2021-04-28", "cash": 212450.1, "market_value": 838120.6, "nav": 1050570.7,
  "gross": 0.80, "net": 0.80, "positions": 24, "nav_reconciles": true }
```

---

## 9. Layer 5: Live signals and the paper book

### How it works in the app

- **Go live (paper)** promotes an approved simulation to a **live strategy**, with its code version and params pinned.
- Each trading day, after its data events (e.g. after `features_daily`), the live runner executes the **same plugin through the same as_of reader**, with as_of = today, and writes **signals**.
- If the inputs are stale, no signals are produced. A red banner explains why, and yesterday's signals are never shown as today's.
- The paper broker trades the signals at the next close, both per strategy and in a combined **paper book**.

**Signals** has four tabs:

- **By stock:** net score, the strategies that agree, target weight, and the top reasons.
- **By strategy:** live Sharpe against the expected band, hit rate, and a decay pill.
- **Strategy live detail:** the backtest's P10–P90 outcome fan from the go-live date, with the live paper equity on top.
- **Paper book** and **Alerts:** decay outside the band for N weeks leads to an auto-park; also stale data and run failures.

```json
// signals (planned, M7.01)
{ "date": "2026-11-03", "strategy_id": "LS-0007", "idea_id": "T-0233", "code_version": 2, "security_id": "SEC_000123",
  "ticker": "JNJ", "score": 2.71, "rank": 3, "side": "long", "target_weight": 0.03,
  "reasons": ["SUE 2.7 (reported Oct 30)", "gross profitability 0.31", "mid cap $41B"], "inputs_as_of": "2026-11-03" }
// live_strategies
{ "id": "LS-0007", "idea_id": "T-0233", "code_version": 2, "params": { "top_n": 30 }, "status": "live",
  "went_live": "2026-09-15", "days_live": 35, "live_sharpe": 0.62, "expected_band": { "p10": -0.2, "p90": 1.4 }, "decay_alert": false }
// alerts
{ "type": "decay", "strategy_id": "LS-0003", "message": "Live return below P10 band for 4 weeks", "action": "auto_parked", "ack": false }
```

**Daily brief** (an email at 20:00): _"5 live strategies · 41 signals · paper NAV $1,041,220 (+0.42% today). New longs: NVDA (revenue acceleration 98th percentile; T-0187), JNJ (PEAD, SUE 2.7; T-0233). One decay alert: LS-0003 auto-parked."_ Every name links to its proof pack. The existing stock-analyst skill reads `signals` and the paper positions, so the text brief and the research engine are one product.

---

## 10. Every collection at a glance

| Layer                 | Collections                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · raw (42 datasets) | `universe`, `company_profiles`, `shares_float`, `market_cap`, `historical_market_cap`, `stock_peers`, `key_executives`, `employee_count`, `eod_prices`, `eod_index`, `treasury_rates`, `sector_performance`, `news_stocks`, `biggest_gainers`, `most_actives`, `economic_gdp`, `economic_cpi`, `earnings_calendar`, `dividends_calendar`, `splits_calendar`, `dividends_history`, `splits_history`, `income_statement`, `balance_sheet`, `cash_flow`, `key_metrics`, `ratios`, `financial_growth`, `financial_scores`, `enterprise_values`, `owner_earnings`, `revenue_product_segmentation`, `revenue_geo_segmentation`, `analyst_estimates`, `price_target_consensus`, `grades_consensus`, `price_target_summary`, `analyst_grades`, `price_target_changes`, `insider_trades`, `congress_senate`, `congress_house` (+ `delisted_companies` written by the universe sync) |
| 2 · clean (today)     | `trading_calendar`, `securities`, `corporate_actions`, `prices_daily`, `macro_daily`, `dq_issues`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2 · clean (planned)   | `fundamentals_pit`, `fundamentals_lines`, `revenue_segments_pit`, `universe_daily`, `features_daily`, `features_ranked`, `regime_daily`, `estimates_snapshots`, `analyst_consensus_snapshots`, `analyst_events`, `earnings_events`, `insider_trades_pit`, `congress_trades`, `holdings_13f`, `filers_13f`, `index_membership`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Catalog & platform    | `dataset_catalog`, `dataset_syncs`, `dataset_sync_runs`, `transforms`, `transform_versions`, `transform_runs`, events                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3 · research          | `theories` (+ Weaviate embeddings), `evaluations`, `trials`, `research_gates`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 4 · ideas & sims      | `idea_comments`, `simulations`, `sim_orders`, `sim_positions`, `sim_portfolio_daily`, `sim_trades`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 5 · live              | `live_strategies`, `signals`, the paper book (the same `sim_*` collections in live mode), `alerts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

---

## 11. Data caveats you must know

These are recorded in the catalog (M1.13), so agents and judges see them on every backtest.

| Caveat                                                                                                                                          | Effect                                                                      | Fix                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| Delisted companies: only about 100 names on the current FMP plan (page ≥ 1 returns 402)                                                         | Some survivorship bias remains in backtests                                 | M8.04 (plan upgrade or SEC/exchange lists) |
| Index constituents return 402                                                                                                                   | No `index_membership` or `in_spx` features; the screener universe stands in | M8.04                                      |
| Quarterly estimates and key metrics aren't on the plan                                                                                          | Annual estimates only                                                       | Plan upgrade                               |
| Estimate, consensus and score history starts at the first weekly snapshot (2026-10)                                                             | Estimate-based ideas are forward-only                                       | Time; `analyst_events` proxies             |
| Feeds (insider, congress, grades, price-target changes, news) hold only items since their sync started                                          | These ideas are forward-only until history accumulates                      | Per-symbol historical endpoints (to add)   |
| Earnings BMO/AMC timing is unknown                                                                                                              | The conservative next-session reaction date is used                         | M8.01 (SEC 8-K acceptance times)           |
| Current history: EOD prices 2021-10-25 → 2026-10-23 (5y, 2,081 symbols; the universe price syncs are currently disabled); statements 8 quarters | Not yet enough for the 10y / 40q targets                                    | M1.05 + M1.16 backfill                     |
