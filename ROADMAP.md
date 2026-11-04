# StockHarness: 5-Layer Architecture, Gaps and Roadmap

Reviewed against `bhajian/stockharness` at `ae32742` (2026-11-03). Implementation is tracked in GitHub issue
[#139](https://github.com/bhajian/StockHarness/issues/139) (ordered checklist) and milestones M1–M8. See
[§11](#11-implementation-plan-github-issues) for the issue-by-issue order.

## 0. The product in one picture

```
 Layer 1  DATA SYNC        FMP (later: other vendors) -> raw Mongo collections, historic + scheduled
              |  contract: Schema Catalog + point-in-time fields
 Layer 2  DATA PREP        Python transforms (UI, scheduled) -> many clean, flat, joined collections
              |  contract: Schema Catalog + Data Access tools (as_of enforced)
 Layer 3  RESEARCH AGENTS  Theorist -> Judge -> Coder -> trusted Evaluator -> Judge -> verdict loop
              |  contract: Theory record + Proof Pack
 Layer 4  IDEAS & SIMS     UI to review ideas, proofs, charts; human approves; full historical simulation
              |  contract: Approved Strategy (versioned code + params)
 Layer 5  LIVE             Daily signals on live data, paper (dry-run) portfolio, live vs expected tracking
```

The dataset product (Layers 1 and 2) and the agent product (Layers 3 to 5) are connected by three contracts. **Today none of the three exist.** That is the gap.

1. **Schema Catalog:** a machine-readable description of every collection, so agents know exactly what data exists, what each field means, its time semantics, coverage and caveats.
2. **Point-in-time and Data Access contract:** every row says when it became known, and the platform filters every agent and backtest read "as of" a date. The agent doesn't do the filtering.
3. **Trusted Evaluator contract:** agents write the strategy logic; a fixed, tested engine runs the backtest and produces the metrics. Agents never grade their own homework.

### Design principle: everything is a YAML object

Every object in every layer can be **exported and imported as YAML**, in one envelope (`apiVersion: stockharness/v1`, `kind`, `metadata`, `spec`). That includes:

- **definitions:**
  - Layer 1: dataset syncs.
  - Layer 2: **transforms, including their Python code verbatim**.
  - Layer 3: harnesses with their collection bindings, agents, skills, catalog docs and caveats, research settings, gates, strategy plugins.
  - Layers 4–5: simulation configs, live strategies, alert rules.
- **records:** theories with their debate, evaluations, simulation-run summaries, verdicts.

The rules:

- References are by name, never by id.
- There are no secrets (only secret names), and code is kept verbatim.
- Import previews first, then applies all-or-nothing, in merge or replace mode.
- Each kind has a round-trip test.

Definitions round-trip fully. Records can be exported for audit and imported to restore or migrate, without re-running anything. Bulk data rows aren't included; they're covered by MongoDB backups. The repo copy in `deploy/config-io/exports/` is kept current automatically. Framework: **M1.00 (#152)**; backup: **M1.17 (#149)**.

---

## 1. What already exists and should be reused

| Building block                                                                                        | Where                                                       | Used by layer                      |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------- |
| Dataset sync engine, 43 configured syncs, schedules, bulk actions, config export/import (YAML)        | `datasetSync.ts`, `datasetCatalog.ts`, Datasets tab         | 1                                  |
| Survivorship-aware sync universe, append-only snapshots and statements                                | C1/C2 fixes                                                 | 1                                  |
| Python executor with pandas, polars, duckdb, scipy, statsmodels, sklearn, lightgbm, TA-Lib, empyrical | `python-executor/`, `codeJobs.ts`                           | 2, 3, 4, 5                         |
| `oh` SDK: `read`, `read_df`, `write`, `write_df`, `params`, `result`                                  | `python-executor/oh.py`                                     | 2, 3                               |
| `run_python` agent tool, incl. parallel `params_list` up to 1000 runs                                 | `pythonTool.ts`                                             | 3                                  |
| MongoDB over MCP for agents                                                                           | `mongoMcp.ts`, `mongodb-mcp/`                               | 3                                  |
| Agent patterns (react, plan-execute, reflection, loop), unlimited budgets, model roles                | `patterns.ts`, `runtime.ts`                                 | 3                                  |
| Workflows with agent, code, condition, parallel, review (human) nodes, schedules                      | `schema.ts`, Workflow editor                                | 3, 5                               |
| Weaviate vector store                                                                                 | `deploy/k8s/base/weaviate.yaml`                             | 3 (theory dedupe)                  |
| PIT helpers, securities identity, prices adjustment logic, tests                                      | `pipeline/` package                                         | 2 (as a library)                   |
| Replay, paper broker and ledger design                                                                | `pipeline/docs/replay.md`, `pipeline/config/backtest.yaml`  | 4, 5                               |
| 100-strategy library and probability engine design                                                    | `openharness-strategy-library.md` (to be added to the repo) | 3 (seed skills, evaluator metrics) |

---

## 2. Layer 1: Data Sync (make it "perfect")

### Requirements

- Historic data for 5 to 10 years plus scheduled refresh.
- Per-dataset cadence: hourly (news, quotes), daily (prices), weekly (fundamentals), calendar-driven (statements after earnings).
- Clean, local, prioritized, and fully described by schema.
- Current FMP tier only, for now.

### Gaps

| #     | Gap                                                                                                                                                                                                                             | Fix                                                                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1-1  | **History depth.** EOD prices start 2021-10-24 (5y). Statements capped at `limit: 8` quarters (2y) in `datasetCatalog.ts`.                                                                                                      | Make history depth a per-sync setting (`from`, `statementQuarters`). Target 10y prices (2016+) and 40 quarters of statements. Verify the current plan returns that depth by test-pulling one symbol before the full backfill.     |
| L1-2  | **No backfill mode distinct from incremental.**                                                                                                                                                                                 | Add a "Backfill" action per sync: chunked by year and symbol batch, resumable, with a progress bar, and not blocking the daily schedule.                                                                                          |
| L1-3  | **Clock-only scheduling.** Downstream work starts on a timer, not on completion.                                                                                                                                                | Emit a `dataset.sync.completed` event (sync id, collection, date range, rows). Layer 2 transforms and Layer 5 jobs can subscribe to events.                                                                                       |
| L1-4  | **No calendar-driven syncs.**                                                                                                                                                                                                   | A new trigger type, "after earnings". It reads `earnings_calendar` and pulls statements and estimates for reporters N days after their report date.                                                                               |
| L1-5  | **Hourly cadence.** Schedules support `everyMinutes`, so hourly works mechanically, but EOD endpoints only change daily.                                                                                                        | Allow hourly for news, quotes and price-target feeds. Keep EOD daily. Add intraday later only if the plan includes it.                                                                                                            |
| L1-6  | **No coverage or health view.** You can't see if a collection is complete.                                                                                                                                                      | For each collection: row count, symbols covered versus the universe, min/max date, gaps of missing days, last sync status, error count. Shown in the Datasets tab and written into the Schema Catalog.                            |
| L1-7  | **No schema capture** (see §5, the biggest gap).                                                                                                                                                                                | The sync engine writes or updates the catalog entry after every sync.                                                                                                                                                             |
| L1-8  | **Plan limits not recorded as data caveats.** Delisted coverage is only about 100 names, index constituents return 402, quarterly estimates and key metrics are unavailable, and estimate history starts at the first snapshot. | Store caveats in the catalog (`caveats: [...]`) so agents and judges see them and account for them (e.g., survivorship warning on every backtest).                                                                                |
| L1-9  | **Ingest validation.** Bad payloads (empty, schema drift, error JSON) can land silently.                                                                                                                                        | Validate each page against the expected field set; record drift in the catalog; fail the sync item loudly.                                                                                                                        |
| L1-10 | **Dead code.** `deploy/stock-data-sync/flows/` is replaced by the dataset feature; `fin_*` collections are leftovers.                                                                                                           | Delete the old flows; drop or archive `fin_*`; fix `layer1_mapping.yaml` to the real collection names.                                                                                                                            |
| L1-11 | **Priority.** Syncs aren't prioritized today.                                                                                                                                                                                   | A priority field per sync: P0 for prices, corporate actions and calendar; P1 for fundamentals and estimates; P2 for news, segments and peers. The scheduler runs P0 first and never lets P2 starve P0 when the rate limit is hit. |
| L1-12 | **Config backup.** The repo copy of the configuration (`deploy/config-io/exports/`) is JSON for syncs, refreshed by hand, and was stale (14 syncs drifted by 2026-11-04).                                                       | YAML for every config, committed automatically to a `config-backup` branch/PR after each change, a drift indicator, and a tested restore (M1.17).                                                                                 |

### Exit criteria

- 10 years of prices for the full sync universe, including delisted names; 40 quarters of statements; the full history of corporate actions.
- Every collection has a catalog entry with coverage stats and caveats.
- A completed sync fires an event that a Layer 2 transform can subscribe to.

---

## 3. Layer 2: Data Prep (new "Transforms" tab inside Datasets)

### Requirements

- No harness, no agents. A simple UI like Layer 1.
- Python code in a proper code editor, using the SDK to read Layer 1 and write the results to new collections.
- Run on demand, on a schedule, or periodically.
- Detailed schema for every output collection.

### Layer 2 produces many flat collections, not one

Layer 1 often holds complex, nested vendor data. Layer 2 simplifies it into **many simple, flat collections**, each with a clear grain, primary key and point-in-time fields, purpose-built for one use. "Flat" does **not** mean one collection holding all the data.

- A single transform may write **one or more** output collections. For example, one parse of a nested Layer 1 dataset can produce `fundamentals_pit`, `fundamentals_segments` and `fundamentals_lines`.
- Each output collection has its own key, write mode, `known_at`/`as_of` fields, schema docs and catalog entry.
- Each collection has exactly one producing transform. A transform can't write to a Layer 1 sync target or to another transform's output.
- Splitting work across separate transforms, each with its own collection, is equally valid. Choose based on whether the outputs come from the same parse and run together.

### Design

A **Transform** is a first-class resource (like a dataset sync), not a workflow:

```yaml
name: prices_daily
description: Split/dividend-adjusted daily prices with total returns, one row per security per trading day.
code: | # Python, edited in the UI
  import oh, pipeline
  ...
inputs: [eod_prices, corporate_actions, securities] # declared, used for lineage + triggers
outputs: # one or more flat collections
  - collection: prices_daily
    key: [security_id, date] # upsert key
    write_mode: upsert # upsert | append | replace
    known_at_field: known_at # required: point-in-time field (unless static)
    as_of_field: as_of_date
    grain: one row per security_id per trading date
    schema_docs: { fields: { adj_close: 'Close adjusted for splits and dividends, USD' } }
trigger:
  schedule: { at: '19:30', timezone: America/New_York }
  after: [dataset:eod_prices, transform:corporate_actions] # dependency triggers
incremental:
  mode: date_range # full | date_range
  lookback_days: 10 # fixes H1
params: {}
secrets: []
```

### UI (Datasets > Transforms)

The full screen designs are in §8.4.

- List: name, inputs, output collections, trigger, last run status, rows written, duration, next run.
- Editor:
  - a Monaco/CodeMirror Python editor,
  - an input collection picker that inserts `oh.read_df(...)` snippets,
  - a schema sidebar showing the fields of the input collections,
  - an outputs panel with "+ Add output".
- **Run preview:** execute against a sample (e.g., 20 symbols, 1 year) and show the first 100 rows of each output in a grid before writing.
- Run history with logs, stdout/stderr, rows read, rows written per output, and DQ counts.
- Output tab per collection: schema (auto-inferred plus your docs), coverage stats, sample rows.
- DAG view: which syncs and transforms feed which collections.

### SDK additions (`oh.py`)

| Need              | Add                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Idempotent writes | `oh.upsert(collection, records, key=[...])`, `oh.upsert_df(...)`, `oh.output(name)` for declared outputs |
| Incremental runs  | `oh.window` = `{start, end, lookback_start}` injected by the scheduler                                   |
| Big reads         | `oh.read_df(..., columns=[...], chunksize=...)`, or `oh.duckdb()` over Mongo exports for heavy joins     |
| Data quality      | `oh.dq(issue_type, severity, **ctx)` written idempotently (fixes H2)                                     |
| Schema docs       | `oh.describe(collection, fields={...}, grain=..., caveats=[...])`                                        |
| PIT helpers       | `oh.pit.eod_known_at(d)`, `oh.pit.as_of(known_at)` (expose `pipeline.core.pit`)                          |

### What happens to the existing `pipeline/` package

Keep it as a **library** baked into the executor image (`import pipeline`). The five current Layer 2 modules (`securities`, `corporate_actions`, `prices_daily`, `macro_daily`, `trading_calendar`) become the first five Transforms, each a few lines calling the library. Remove the "Pipeline Layer 2" harness workflow once Transforms run them. Fix H1, H2, H4, H5, H6 and M2 as part of the migration.

### The one rigor rule Layer 2 must keep

Every Layer 2 output that agents may backtest on **must** have `known_at`/`as_of_date`. When a transform is saved, any output without a `known_at_field` is rejected, unless the collection is marked `static` (e.g., a calendar). Without this, Layer 3 backtests leak the future and every "successful" idea is suspect.

### First transforms to ship

1. `trading_calendar`, `securities`, `corporate_actions`, `prices_daily`, `macro_daily` (migrated)
2. `fundamentals_pit` (merges statements, versions restatements, adds TTM; may output several flat collections)
3. `estimates_snapshots`, `analyst_events`, `earnings_events`, `insider_trades`
4. `features_daily` (price, valuation, quality, growth, events), then `features_ranked` (sector ranks, z-scores)
5. `universe_daily` (point-in-time tradeable universe)

### Exit criteria

- A user who doesn't use agents can create, preview, schedule and monitor a transform entirely in the UI.
- The five migrated transforms run on dependency triggers after their syncs, with no harness.
- Every output collection has a complete catalog entry.

---

## 4. Layer 3: Research Agents (the core)

### Requirements

The agents:

- read the schema and data, and propose theories;
- a judge reviews and refines each theory;
- a coding agent implements and backtests it;
- the judge analyzes the results, and the loop marks each idea failed or successful.

The budget is close to unlimited.

### Agent roles

| Agent        | Job                                                                                                                                                                                                                                                                                                                                       | Tools                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Theorist** | Reads the catalog, seed skills (strategy library), and the memory of past theories. Proposes a testable theory: hypothesis, economic rationale, data needed, universe, signal logic in words, horizon, expected direction, what would falsify it.                                                                                         | catalog tools, data tools (as_of), theory memory search, `submit_theory`   |
| **Judge**    | Two gates. _Before coding:_ is it testable with the available data and history, free of lookahead, novel (not a near-duplicate), and economically plausible? _After results:_ overfitting, robustness, a known factor in disguise, caveats (survivorship, short history). Writes a critique, then asks for a revision or gives a verdict. | catalog, theory memory, evaluation results, `review_theory`, `set_verdict` |
| **Coder**    | Turns an approved theory into a **strategy plugin** (contract below), runs exploratory analysis if needed, calls the trusted evaluator, fixes code errors.                                                                                                                                                                                | `run_python`, catalog, `evaluate_strategy`, `submit_code`                  |

Use different models for the Theorist and the Judge, so they don't share blind spots. Model roles already exist.

### The key design decision: trusted evaluator, not agent-written backtests

If the Coder wrote a whole backtest every time, you'd get 1,000 different backtest engines. Each would have its own lookahead bugs, cost assumptions and metric definitions, and each would be graded by the agent that wrote it. Instead:

**Strategy plugin contract** (what the Coder writes):

```python
def universe(ctx) -> list[str]: ...          # optional filter, security_ids tradeable on ctx.date
def signal(ctx) -> dict[str, float]: ...     # score per security_id on ctx.date; higher = more bullish
# ctx.read_df(collection, ...) is automatically filtered as_of ctx.date by the evaluator
META = {"side": "long|short|long_short", "horizon_days": 40, "rebalance": "weekly", "top_n": 30}
```

**Trusted evaluator** (fixed platform code, versioned, tested):

- Walks the dates and serves data through an `as_of`-enforced reader, so agents can't see the future even if they try.
- Portfolio construction, next-day execution, costs, delisting returns, borrow cost for shorts.
- Walk-forward splits, and a locked holdout the agent can't touch.
- Metrics:
  - CAGR, Sharpe, Sortino, max drawdown, hit rate, turnover,
  - excess return against the sector and SPX,
  - breakdowns by year and by regime, and factor exposures,
  - a **deflated Sharpe using the total number of trials** run by the swarm.
- Writes a structured `evaluation` record (numbers plus series for charts), never free text.

### Run, test, fix (agent-written code)

The code agents write is short Python running in the existing executor, against schemas the catalog defines, so the loop is simple (**M3.09, #153**):

1. Write the code, then run `test_strategy`: a dry run through the as_of reader on a small non-holdout sample.
2. On an error, read it (exception, traceback with the plugin's own line numbers, and the real columns when a field is wrong) and fix it. Repeat, with a cap of about 5 attempts.
3. Then `submit_code`, then `evaluate_strategy`.

`test_strategy` never reports performance, so fixing code can't turn into tuning it to pass the gates. A failing gate goes to the Judge, not back into the fix loop. In Layer 5, a broken live run raises an alert; the Coder may propose a fixed new version, which a human must approve.

### Theory lifecycle (state machine)

```
draft -> pre_review -> (revise -> pre_review)* -> rejected_untestable
                     -> approved_for_code -> coding -> (code_error -> coding)*
                     -> evaluated -> post_review -> (revise -> coding)*
                     -> FAILED | SUCCESSFUL -> (human) APPROVED | PARKED
```

- Maximum 3 revisions per theory (configurable). The overall budget is unlimited but each idea's is bounded; otherwise the loop p-hacks its way to a "success".
- Every transition is stored with the agent's reasoning, so Layer 4 can show the full history.

### Success is mechanical, the judge explains

"Successful" requires fixed numeric gates in config, not the judge's mood:

| Gate                                             | Default                                                        |
| ------------------------------------------------ | -------------------------------------------------------------- |
| Out-of-sample (walk-forward) Sharpe after costs  | ≥ 0.5                                                          |
| Deflated Sharpe probability (given total trials) | ≥ 0.95                                                         |
| Positive excess in % of years                    | ≥ 60%                                                          |
| Holdout result (one shot)                        | positive excess, Sharpe ≥ 0.3                                  |
| Min trades / avg holdings                        | ≥ 100 trades, ≥ 10 holdings                                    |
| Alpha after factor exposures t-stat              | ≥ 2                                                            |
| Data caveats                                     | none blocking (e.g., estimate data must cover the test window) |

The judge can downgrade a mechanically passing idea (with reasons), but cannot upgrade a failing one.

### History budget and holdout policy (important with 5 to 10 years)

- **Prices (10 years):** walk-forward on years 1 to 8, with the last 18 months as the holdout (configurable; shorter than the usual 24 because the history is short).
- **Fundamentals:** the same, once 40 quarters are synced.
- **Theories based on estimates or consensus:** there's no historical depth, because snapshots started in October 2026. The judge must tag them `forward_only`; they skip the backtest and go straight to Layer 5 paper tracking. Proxies built from `analyst_events` (grade and price-target changes, which do have history) can be backtested.

### Theory memory

- A `theories` collection, plus embeddings in Weaviate. The Theorist searches before proposing. The Judge rejects near-duplicates (cosine similarity above a threshold) unless the theory states what is different.
- Failed theories are as valuable as successes: they stop the swarm re-testing the same idea, and they feed the trial count.

### Orchestration in OpenHarness

- One workflow, "Research loop": Theorist agent node → Judge agent node → condition (approved?) → Coder agent node (loop pattern, `run_python`, `evaluate_strategy`) → Judge → condition → write verdict → back to start.
- It runs continuously on a schedule (e.g., every hour, with N theories in parallel via a `parallel` node). The budget is unlimited, and the tools enforce the per-theory revision caps.
- Skills:
  - a seed "strategy families" skill, from the 100-strategy library,
  - "how to write a strategy plugin",
  - "how to read the catalog",
  - a judge checklist.

### Collection-scoped data access for any harness

The built-in MongoDB tools are pinned to the workspace database but not to collections. M3.08 adds **collection bindings**: a harness or agent is granted specific collections with `read` / `insert` / `update` / `delete` permissions (plus optional row limits, a fixed filter, and as_of enforcement), enforced on the server, with each collection's catalog schema in the agent's context. This enables, for example, a data chatbot that answers from `prices_daily`, `features_daily` and `signals` instead of calling FMP directly.

### New MCP tools (all server-side, as_of-aware)

| Tool                                                           | Purpose                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `list_collections`, `describe_collection`, `sample_collection` | Catalog                                                                   |
| `query_collection(collection, filter, fields, as_of)`          | Safe reads with enforced as_of and row limits                             |
| `search_theories(text)`, `get_theory(id)`                      | Memory                                                                    |
| `submit_theory`, `review_theory`, `submit_code`, `set_verdict` | Lifecycle writes, validated by the state machine                          |
| `evaluate_strategy(theory_id, code_version, params)`           | Runs the trusted evaluator in the executor, returns the evaluation record |

### Exit criteria

- The loop runs unattended for 7 days, producing at least 50 evaluated theories with no manual intervention.
- Every evaluation is reproducible: a re-run gives identical metrics.
- Lookahead canary: a deliberately cheating plugin (one that reads tomorrow's return) scores about 0, because the reader blocks it.

---

## 5. The Schema Catalog (the bridge between the two products)

This is the most important missing piece. Without it, agents guess field names and meanings and produce broken code.

### `dataset_catalog` collection, one doc per collection

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
      "null_pct": 0.1,
      "min": 0.01,
      "max": 6500.0,
      "example": 187.42
    }
  ],
  "coverage": {
    "rows": 5100000,
    "symbols": 2400,
    "universe_coverage_pct": 98.7,
    "date_min": "2016-01-04",
    "date_max": "2026-11-03",
    "missing_days_pct": 0.4
  },
  "freshness": { "cadence": "daily after eod_prices", "last_updated": "2026-11-03T23:41:00Z" },
  "caveats": ["Delisted coverage limited to ~100 names on current FMP plan (survivorship bias)"],
  "joins": [
    { "to": "securities", "on": "security_id" },
    { "to": "features_daily", "on": ["security_id", "date"] }
  ]
}
```

- **Auto-generated** after every sync or transform run: field types, null %, min/max, examples, coverage, freshness. A transform with several outputs updates one entry per output collection.
- **Curated** descriptions: for Layer 1, from the dataset catalog definitions plus FMP's field docs; for Layer 2, from each output's `schema_docs`.
- Viewable in the Datasets tab (a "Schema" view per collection), and exportable as Markdown for prompts.
- Served to agents through MCP tools, and included in skills.

---

## 6. Layer 4: Ideas and Simulations (new tabs)

The full screen designs are in §8.6–§8.9.

### Ideas tab

- **Board:** columns or filters by status (drafting, in review, evaluated, successful, failed, approved, parked).
  - Sort by deflated Sharpe, out-of-sample Sharpe or recency.
  - Search and tags: category, side, horizon, data used.
- **Idea detail page (the "proof pack"):**
  - **Idea:** thesis, rationale, falsification condition, and the data used (with catalog links and caveats).
  - **Debate timeline:** the theorist's proposal, the judge's critiques, the revisions, and the final verdict with its reasons.
  - **Code:** the plugin source, with version history and diffs.
  - **Results:**
    - equity curve against the benchmark, drawdown, rolling Sharpe,
    - returns by year, by regime and by sector,
    - turnover, holdings count, factor exposures,
    - the walk-forward fold table and the holdout result,
    - the trial count and deflated Sharpe.
  - **Reproducibility:** data snapshot date, code hash, evaluator version, params, and a "re-run" button.
  - **Actions:** Approve, Park, Reject, Send back with a comment (the comment goes to the agents as feedback), Schedule simulation.

### Simulations tab

- A human schedules an approved idea for a **full historical simulation** over the 5–10 year window, through the paper broker (`pipeline/docs/replay.md` §4b): positions, trades, cash, NAV, sizing, stops, and exits with reasons.
- Pages:
  - a list of simulation runs,
  - run detail: equity curve, a trade blotter (sortable, each trade linked to its signal and date), positions over time, exposure, P&L attribution,
  - a side-by-side comparison of several ideas or parameter sets.
- Portfolio simulation: combine several approved ideas into one book with capital allocation, to see their correlation and combined drawdown.

### Platform gaps for Layer 4

- The studio has no chart library. Add one (Recharts or ECharts), and render charts from the structured evaluation and simulation records, never from images the agents make.
- There's no code viewer with diffs. Add one, using the same editor as Transforms.
- Evaluation and simulation records must be structured JSON series (dates and values), so the UI renders them consistently.

### Exit criteria

- Every successful idea has a complete proof pack, viewable without reading logs.
- A human can approve an idea and launch a 10-year simulation from the UI, then review the trades and charts.

---

## 7. Layer 5: Live Signals and Dry Run

- **Live runner:** approved strategies (pinned code version and params) run on schedule after the relevant data events (e.g., after `features_daily` updates). They use the same plugin and the same evaluator reader, with as_of = today. Output goes to a `signals` collection: strategy, security, score, rank, side, target weight, reasons.
- **Dry-run portfolio:** the paper broker executes signals at the next close, keeping live paper positions per strategy and for a combined book. It's the same ledger code as the Layer 4 simulations, so live and historical results are directly comparable.
- **Performance tracking:** live results against what the backtest expected (Sharpe, hit rate, drawdown bands). A decay alert fires when live results stay outside the expected band for N weeks. A strategy is auto-parked after sustained underperformance (configurable).
- **Signals UI:** today's signals per strategy, and aggregated across strategies per stock, with links back to each idea's proof pack. Optional daily digest (an email node exists).
- **Bridge to the existing stock-analyst skill:** the daily brief can read `signals` and the paper positions instead of working out setups itself. That makes the "text brief" product and the research engine one product.
- **Forward-only strategies** (based on estimates) live here from day one, since they can't be backtested yet.

### Exit criteria

- At least one approved strategy runs live for 30 trading days, with daily signals, a paper ledger and a chart of live results against expected.

---

## 8. UI design by layer

Every new screen follows the existing studio language:

- a left sidebar with grouped navigation and a breadcrumb top bar,
- a page title with one primary action on the right,
- a row of KPI stat cards, then a table or card grid.

Surfaces are light, with rounded cards, status pills, and the existing CSS tokens (`--blue`, `--green`, `--amber`, `--red-ink`, `--magenta`, `--mono`). Designs are desktop first (min 1280px); tables scroll horizontally on narrow screens.

### 8.1 Navigation

```
openharness.
[ Behnam-WS  Shared workspace  > ]

Data
  Datasets            tabs: Syncs | Transforms | Catalog | Health
Research
  Research Lab        Layer 3 control room
  Ideas               Layer 4 proof packs
  Simulations         Layer 4 historical runs
  Signals             Layer 5 live signals and paper book
Build
  Harnesses, Playground, Skills, MCP connections, Knowledge
Workspace
  Inbox, Executions, Integrations, Settings
```

- Today's "Dataset" page becomes **Datasets**, with four tabs. The tab is kept in the URL (`/datasets/transforms/prices_daily`), so every screen is linkable.
- A global **data freshness indicator** sits in the top bar next to "Online":
  - green: "Data fresh as of Nov 3 close",
  - amber: "2 syncs late",
  - red: "Layer 2 blocked".
  - Clicking it opens Datasets > Health.

### 8.2 Shared components to add first (M1)

| Component                        | Spec                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status pill**                  | One component with a fixed vocabulary and colors, always icon + text and never color alone. Data: `fresh` green, `stale` amber, `failed` red, `running` blue (animated dot), `queued` gray, `disabled` gray outline. Ideas: `draft` gray; `in review`, `coding` and `evaluating` blue; `successful` green; `failed` red; `approved` solid green; `parked` gray; `forward-only` magenta. |
| **KPI card**                     | Reuse the existing stat card (icon tile, label, big number, footnote on the right). Add an optional sparkline and a delta chip (`+3 today`).                                                                                                                                                                                                                                            |
| **Code editor**                  | Monaco, with Python, a read-only mode, a diff mode, the `--mono` font, a toolbar slot, and inline error markers from run output (line numbers parsed from tracebacks).                                                                                                                                                                                                                  |
| **Charts**                       | ECharts (via `echarts-for-react`), which handles 10 years of daily data with zoom, many series, heatmaps and histograms. One `<TimeSeriesChart>` wrapper with a shared tooltip and crosshair, range presets (1Y, 3Y, 5Y, Max), a log toggle, and PNG/CSV export. The server downsamples series over 5,000 points (LTTB).                                                                |
| **Data grid**                    | Extend the existing `DataGrid.tsx`: virtualized rows, column picker, sort, filter chips, pinned first column, CSV export, and row click opening a drawer.                                                                                                                                                                                                                               |
| **Detail drawer**                | A 520px drawer on the right for quick views (a run, a trade, a field), with an "Open full page" link in its header.                                                                                                                                                                                                                                                                     |
| **Timeline**                     | A vertical event list with role avatar, timestamp, title and an expandable body. Used for agent debates, run history and the idea lifecycle.                                                                                                                                                                                                                                            |
| **Gate checklist**               | One table row per gate: name, value, threshold, a pass/fail icon, and a tooltip with the definition. Used on Ideas and Simulations.                                                                                                                                                                                                                                                     |
| **Empty, loading, error states** | Every list has an empty state with one next action ("No transforms yet. Create from template"), skeleton loaders, and the existing `notice error` pattern.                                                                                                                                                                                                                              |

### 8.3 Layer 1: Datasets > Syncs (enhance existing tab)

**Syncs list**

```
Datasets
[ Syncs ] Transforms  Catalog  Health                          [ + New sync ]

[Syncs 43 · 41 enabled] [Collections 47 · 312M rows] [Healthy 44/47] [FMP calls today 18.2k / limit]

Category [All v]  Priority [All v]  Status [All v]  Cadence [All v]     Search syncs...
[ ] | Name                     | Dataset        | Cadence       | Prio | History     | Coverage | Last run      | Next      |
[ ] | EOD prices (universe)    | eod_prices     | daily 18:49   | P0   | 2016-01-04  | ███████░ 97% | ok 12m ago | Tue 18:49 |
[ ] | Income statement (Q)     | income_statement | after earnings +1d | P1 | 40 q   | ██████░░ 88% | ok 2d ago  | on event  |
[ ] | Stock news               | news_stocks    | hourly        | P2   | 90 days     | n/a      | running 34%   | 21:00     |
bulk toolbar (existing): Run now · Enable · Disable · Backfill · Export
```

- New columns: **Priority**, **History** (from date or depth), **Coverage** (a bar, from the catalog), **Next** run.
- Clicking a row opens the sync detail page.

**Sync detail page** (tabs)

- **Source:** dataset, endpoint, a params form (generated from the catalog definition), target collection, and read-only key fields with an "append-only" badge for snapshots and statements.
- **Symbols:** universe / list / preset, with the resolved count ("2,412 symbols incl. 98 delisted").
- **History and backfill:**
  ```
  History start [2016-01-01]   Statement depth [40 quarters]
  Backfill status: running   ██████████░░░░░░  62%  2019 of 2016-2026   ETA 1h 40m
  Batches: 2016 ok · 2017 ok · 2018 ok · 2019 running (1,204/2,412 symbols) · 2020 queued ...
  FMP rate 380/min (limit 400)          [ Pause ]  [ Resume ]  [ Retry failed (12) ]
  ```
- **Schedule:** a cadence selector with four modes:
  - **Interval:** every N minutes or hours.
  - **Daily** at a set time.
  - **Weekly** on a set day and time.
  - **Event:** after earnings + N days, or after another sync completes.
  - Also a P0/P1/P2 priority selector, and the next 5 computed run times.
- **Runs:** a grid of started, duration, status, rows written, FMP calls and errors. A row opens a drawer with the log tail and per-symbol errors.
- **Schema:** an embedded catalog view of the target collection (§8.5), with "Open in Catalog".

**Datasets > Health**

```
[Fresh 44] [Stale 2] [Failed 1] [Drift alerts 1]

Collection          | Layer | Freshness       | Coverage    | Gaps (last 90 trading days)        | Issues
eod_prices          | 1     | fresh  (18:58)  | 97.4%       | ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▯▮▮▮▮▮▮▮▮▮      | 0
analyst_estimates   | 1     | fresh  (Sat)    | 91.0%       | weekly ▮ ▮ ▮ ▮ ▮ ▮ ▮ ▮ ▮ ▮ ▮ ▮      | 1 drift
prices_daily        | 2     | stale  (Mon)    | 97.1%       | ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▯      | blocked by eod_prices

Plan caveats (shown to agents): Delisted coverage ~100 names · Index constituents unavailable · Estimates history from 2026-10-17
```

- Gap strip: one cell per expected date, filled when data exists and hollow when it's missing. Hovering shows the date and row count.
- Drift alerts, e.g. "Field `epsAvg` missing in 3% of rows since Nov 1", with a link to sample rows.
- Caveats can be edited here, and they flow into the catalog.

### 8.4 Layer 2: Datasets > Transforms

**Transforms list**

```
[ Syncs ] [ Transforms ]  Catalog  Health                   [ + New transform v ]
                                                              Blank · Join · Flatten · Feature · Snapshot diff
[Transforms 9 · 9 enabled] [Runs today 14] [Failed 0] [Rows written today 2.1M]

Name             | Inputs                               | Outputs                    | Trigger                  | Last run        | Rows   | Dur
securities       | company_profiles, delisted, stock_list | securities               | after universe sync      | ok 18:59        | 2,412  | 14s
prices_daily     | eod_prices, corporate_actions        | prices_daily               | after eod_prices + ca    | ok 19:31        | 2,398  | 2m 10s
fundamentals_pit | income_statement, balance_sheet, ... | fundamentals_pit, +2 more  | after earnings syncs     | ok 20:02        | 9,120  | 3m 40s
features_daily   | prices_daily, fundamentals_pit, ...  | features_daily             | after prices_daily       | running 40%     | -      | -
```

**Transform editor** (full page, three panes + bottom panel)

```
Datasets > Transforms > prices_daily          v3 (saved)  [ Diff v2 ]   [ Preview ]  [ Run now ]  [ Save ]
+--------------------+---------------------------------------------+------------------------------+
| INPUTS             |  1  import oh, pipeline                     | OUTPUTS            [+ Add]   |
| v eod_prices       |  2  from pipeline.layer2.prices_logic \     |  v prices_daily              |
|    symbol   str    |  3      import compute_symbol_rows          |    Key [security_id, date]   |
|    date     date   |  4                                          |    Write mode (o) upsert     |
|    close    float  |  5  w = oh.window   # start, end, lookback  |    known_at [known_at]*      |
|    volume   int    |  6  bars = oh.read_df("eod_prices",         |    as_of [as_of_date]*       |
|    ...             |  7      {"date": {"$gte": w.lookback_start}})| TRIGGER                      |
| > corporate_actions|  ...                                        |  [x] Schedule 19:30 ET       |
| > securities       |                                             |  [x] After: eod_prices,      |
|                    |                                             |      corporate_actions       |
| + Add input        |                                             | INCREMENTAL                  |
| click field =      |                                             |  Mode date range, lookback 10|
| insert snippet     |                                             | PARAMS / SECRETS / FIELD DOCS|
+--------------------+---------------------------------------------+------------------------------+
| Preview (20 symbols, 1y) [prices_daily v] | Logs | DQ issues (3) | Schema                         |
|  ok 2.4s · 5,020 rows · key unique · known_at present · 0.3% nulls in vwap                     |
|  security_id | date       | close  | adj_close | tr_1d   | known_at              | dq_flags      |
|  SEC_000001  | 2025-11-03 | 187.40 | 187.40    | 0.0123  | 2025-11-03T21:00:00Z  | []            |
+------------------------------------------------------------------------------------------------+
```

- A **validation bar** for each output in the preview:
  - green checks for key uniqueness, `known_at` present, and the schema matching the last run,
  - red blocks saving when any non-static output has an empty `known_at_field`.
- **Snippet insertion:** clicking a field or collection inserts a correct `oh.read_df` call with a projection.
- **Versions:** every save is a version, with a diff between any two and "Restore".
- **Run now** asks for a range (last day, custom, or full backfill) and shows a progress panel.

**Lineage** (Catalog tab, "Graph" toggle)

- A left-to-right DAG: syncs (rounded, blue) → collections (rectangles) → transforms (rounded, green, which can fan out to several output collections) → collections → agent tools (outlined).
- Node borders are colored by freshness. Clicking a node opens its page; hovering shows the last run and row count.
- Selecting a node highlights everything upstream and downstream of it.

### 8.5 The bridge: Datasets > Catalog

```
Datasets > Catalog                                         [ List | Graph ]   [ Export for agents ]
+-------------------------+-----------------------------------------------------------------------+
| Search collections...   | prices_daily                         Layer 2 · transform prices_daily v3 |
| Layer 1  (43)           | Split/dividend-adjusted daily prices with total returns.              |
|   eod_prices            | Grain: one row per security_id per trading date   PK: security_id,date |
|   income_statement      | Time: known_at = 16:00 ET close, usable same day   fresh · 19:31      |
|   ...                   | [Fields] Coverage  Time semantics  Caveats (1)  Sample  Joins  Agent view |
| Layer 2  (9)            | Field      | Type  | Unit | Description                | Null% | Example |
|  > prices_daily         | adj_close  | float | USD  | Close adjusted for splits..| 0.0   | 187.42  |
|   features_daily        | tr_1d      | float | ratio| Total return incl. divs    | 0.1   | 0.0123  |
| Layer 3 outputs (4)     |  (descriptions editable inline; auto-filled fields show a robot icon)  |
+-------------------------+-----------------------------------------------------------------------+
```

- **Coverage tab:** a rows-per-day chart, a symbols-per-day chart, a gap heatmap (year × day of year), and coverage against the universe.
- **Agent view tab:** exactly what `describe_collection` returns to agents, plus its token size. This is how you check that the agents see what you think they see.
- **Export for agents:** Markdown of the selected collections, for skills or prompts.
- Missing descriptions are flagged with an amber "undocumented" pill. The catalog list shows a documentation completeness % per layer.

### 8.6 Layer 3: Research Lab

The control room for the agent loop. Humans configure and watch it here, and review the results in Ideas.

```
Research Lab                                      status: running · gates v2   [ Pause ]  [ Settings ]
[Theories today 38] [In flight 6] [Successful 3 (7.9%)] [Total trials 1,412] [Tokens today 4.1M · $61]

PIPELINE
 Draft (4)      Pre-review (3)   Coding (2)       Evaluating (1)   Post-review (2)   Verdict today
 +-----------+  +-----------+    +-----------+    +-----------+    +-----------+     ok 3 successful
 | T-0412    |  | T-0409    |    | T-0401    |    | T-0398    |    | T-0395    |     x 21 failed
 | Insider   |  | Revenue   |    | Quality   |    | PEAD in   |    | Low-vol   |     ~ 6 untestable
 | cluster + |  | accel in  |    | drawdown  |    | small caps|    | sector    |
 | revisions |  | software  |    | recovery  |    |  ████░ 70%|    | rotation  |
 | Theorist  |  | rev 1/3   |    | code err 1|    |           |    | Judge...  |
 +-----------+  +-----------+    +-----------+    +-----------+    +-----------+

LIVE ACTIVITY                                              | CHARTS
 20:14 Judge rejected T-0410: duplicate of T-0233 (0.93)   | Theories per day (stacked by verdict)
 20:12 Coder fixed KeyError in T-0401 (attempt 2)          | Success rate over time
 20:09 Evaluator finished T-0398: OOS Sharpe 0.41          | Cumulative trials (feeds deflated Sharpe)
 20:05 Theorist proposed T-0412 (family: insider)          | Token cost per day by role
```

- Cards open the theory in Ideas. In-flight and finished theories use the same page.
- **Settings drawer** (tabs):
  - _Agents:_ the model, attached skills and temperature for each role (Theorist, Judge, Coder).
  - _Focus:_ optional steering ("explore insider and earnings families this week"), families to exclude, and the maximum share of theories per family.
  - _Gates:_ the success thresholds (§4). Gates are **versioned and locked while the loop runs**. Editing them creates gate v3 and warns that results under v2 and v3 can't be compared.
  - _Budget:_ parallel theories, the revision cap per theory, maximum evaluator jobs, and a daily token or cost alert. It's an alert only, with no hard stop, matching the "unlimited budget".
  - _Schedule:_ continuous, or a nightly window.
- **Human steering box** at the top of Live Activity: a note injected into the Theorist's context on the next cycle ("prioritize ideas usable for 4 to 8 week holds").

### 8.7 Layer 4: Ideas

**Ideas list**

```
Ideas                                                              [ Compare (2) ]  [ Export ]
[Successful 41] [Approved 6] [Failed 812] [In progress 6] [Forward-only 9]

Status [Successful v]  Family [All v]  Side [All v]  Horizon [All v]  Data [All v]  Gates [v2 v]  Search...
[ ] | ID     | Idea                                   | Status      | Side | Hzn | OOS Sh | DSR  | Excess/yr | MaxDD | Holdout | Equity
[x] | T-0233 | Insider cluster buys after drawdown    | successful  | long | 40d | 0.71   | 0.97 | +4.1%     | -14%  | pass    | ~~/~~
[x] | T-0187 | Revenue acceleration + margin up       | approved    | long | 1y  | 0.62   | 0.96 | +3.3%     | -19%  | pass    | ~/~~/
[ ] | T-0302 | Negative revisions + 6m weak momentum  | successful  | short| 40d | 0.55   | 0.95 | +2.8%     | -22%  | pass    | ~~\~/
```

- The default view shows Successful and Approved ideas, sorted by deflated Sharpe probability (DSR). Failed ideas are one filter away and never hidden.
- A card-view toggle for browsing: title, status, 4 key metrics, and an equity sparkline.

**Idea detail (the proof pack)**

```
Ideas > T-0233
Insider cluster buys after a 20% drawdown                  successful · gates v2 · long · 40d
Proposed by Theorist (model A) · judged by Judge (model B) · 2 revisions · evaluated Nov 2
[ Approve ]  [ Schedule simulation ]  [ Send back... ]  [ Park ]  [ Reject ]

VERDICT                                                    KEY RESULTS
Gate                       Value   Threshold   Result      [OOS Sharpe 0.71] [DSR 0.97] [Excess +4.1%/yr]
OOS Sharpe (after costs)   0.71    >= 0.50     pass        [Max DD -14%] [Hit rate 56%] [Trades 1,240]
Deflated Sharpe prob.      0.97    >= 0.95     pass
Positive years             7/9     >= 60%      pass        Judge summary: "Edge concentrated in small and mid
Holdout (18m, one shot)    +2.2%   > 0         pass        caps; survives costs; not explained by value or
Alpha t-stat after factors 2.6     >= 2.0      pass        momentum. Caveat: delisted coverage limited."
Caveats                    1       none blocking  warn

[ Overview ] [ Results ] [ Debate ] [ Code ] [ Runs ] [ Comments ]
```

- **Overview:** thesis, economic rationale, falsification condition, universe, horizon, rebalance. The **data used** appears as chips linking to catalog entries, each with its caveats inline.
- **Results:** a 2-column grid of charts:
  - Equity curve against SPX and the sector benchmark (log toggle), with a drawdown area chart beneath and a synced crosshair.
  - Returns by year, by regime and by sector (bars).
  - Rolling 12-month Sharpe (line), with the 0.5 gate as a dashed line.
  - The walk-forward folds table (train period, test period, in-sample Sharpe, out-of-sample Sharpe).
  - A holdout panel, visually separated, stamped "evaluated once on Nov 2".
  - Factor exposures (horizontal bars with t-stats).
  - A trade return histogram, with mean and median markers.
- **Debate:** a timeline of every turn, showing the role avatar (Theorist, Judge, Coder, Evaluator, Human), model name, timestamp and text. Numbers the agents cite render as chips linking to the evaluation that produced them; a number with no source shows a red "unsourced" chip.
- **Code:** read-only Monaco, a version selector, diffs between versions, the evaluator version used, "Copy", and "Open as transform" (to reuse the signal as a Layer 2 feature).
- **Runs:** every evaluation run (date, data snapshot, code hash, evaluator version, metrics). "Reproduce" re-runs it and shows a match/mismatch badge.
- **Comments:** a human feedback thread. "Send back" posts a comment and returns the idea to the Theorist with that comment in its context.

**Compare** (2 to 4 ideas): equity curves overlaid, metrics side by side with the best value per row highlighted, a return correlation matrix, and holdings overlap (% of names in common).

### 8.8 Layer 4: Simulations

**Schedule simulation** (a modal opened from Idea detail or Compare)

```
New simulation
Ideas        [T-0233 x] [T-0187 x] [+ add]
Period       [2016-01-04] to [2026-11-03]       (includes holdout: [ ] allow)
Capital      [$1,000,000]     Benchmark [SPX v]
Allocation   (o) Equal   ( ) Risk parity   ( ) Custom  T-0233 [50]% T-0187 [50]%
Sizing       (o) Quarter-Kelly, cap 5%   ( ) Equal weight
Constraints  Max positions [30]  Sector cap [30]%  Gross [100]%  Net [100]%
Costs        Commission [1] bps  Slippage [5] bps  Borrow (shorts) [50] bps/yr
Seed         [42]                               Estimated runtime ~6 min
                                                        [ Cancel ]  [ Run simulation ]
```

**Simulations list:** run name, ideas (chips), period, status, CAGR, Sharpe, max drawdown, final NAV, created, by.

**Simulation detail**

```
Simulations > Insider + RevAccel, 2016-2026                       completed · NAV reconciles ok
[CAGR 13.2%] [Excess 3.6%/yr] [Sharpe 0.84] [Max DD -21%] [Trades 2,860] [Avg positions 24]

[ Performance ] [ Trades ] [ Positions ] [ Attribution ] [ Config ]
```

- **Performance:** equity against the benchmark with drawdown, an exposure area chart (gross, net, by sector), a monthly returns heatmap (years × months, red/green), and rolling Sharpe.
- **Trades:** a virtualized blotter (entry date, exit date, symbol, side, quantity, entry, exit, P&L, return, excess, exit-reason pill, idea). A row's drawer shows the signal values on the entry date and a mini price chart with the entry and exit marked.
- **Positions:** a **time scrubber** across the period. The table shows the holdings, weights and P&L as of the selected date, and a small chart above marks the scrubber's position on the equity curve.
- **Attribution:** P&L by idea, sector, side, exit reason and holding-period bucket (bars), plus predicted versus realized calibration if the idea has probabilities.
- **Config:** the frozen inputs, code versions and data snapshot, with "Clone and edit" to rerun with changes.
- A **Go live (paper)** button appears on completed simulations of approved ideas. It promotes the idea to Layer 5 with its code versions pinned.

### 8.9 Layer 5: Signals

**Signals (today)**

```
Signals · Mon Nov 3, 2026 (session close)                 data fresh · generated 19:52
[Live strategies 5] [Signals today 41] [Paper NAV $1,041,220] [Today +0.42%] [Decay alerts 1]

[ By stock ]  By strategy   Paper book   Alerts
Symbol | Net score | Strategies agreeing      | Side  | Target wt | Top reasons                         | Action
NVDA   | +2.31     | T-0187, T-0302(-)       | long  | 4.0%      | revenue accel 98th pct; revisions +6%| new
JNJ    | +1.12     | T-0233                  | long  | 3.0%      | 3 insider buys in 30d after -22% DD  | hold
...
```

- If the data is stale, a red banner replaces the table ("Signals not generated: prices_daily stale since Mon 19:31"), linking to Health. Yesterday's signals are never shown as today's.
- **By strategy:** one card per live strategy, showing:
  - a status pill (live, paused, auto-parked) and days live,
  - live Sharpe against the expected band, and hit rate,
  - today's signal count, and a decay pill if it's outside the band.
- **Strategy live detail:** a live-versus-expected chart. The backtest's distribution of outcomes is drawn as a shaded fan (P10 to P90) from the go-live date, with the live paper equity line on top. Below it are the signal history and the paper ledger (the same components as Simulation detail, in live mode).
- **Paper book:** the combined book across strategies, using the Simulation detail components (Performance, Trades, Positions, Attribution), with a "live" badge and a daily NAV table.
- **Alerts:** decay (live results outside the expected band for N weeks), data staleness, strategy run failures and auto-park events. Each alert has Acknowledge and a link. Notification settings cover an email digest, using the existing email node.

### 8.10 UI acceptance per milestone

| Milestone | Screens that must ship                                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1        | Shared components (§8.2), Syncs enhancements, sync detail with backfill and schedule modes, the Health tab, the Catalog list and collection page (Fields, Coverage, Caveats, Agent view) |
| M2        | Transforms list, the transform editor with preview and validation (multiple outputs), versions/diff, runs, the lineage graph                                                             |
| M3        | Catalog Agent view checked against the MCP output; evaluator results render on a dev-only result page                                                                                    |
| M4        | Research Lab (pipeline board, activity feed, settings with versioned gates)                                                                                                              |
| M5        | Ideas list, Idea detail (all tabs), Compare                                                                                                                                              |
| M6        | Simulation modal, Simulations list, Simulation detail (all tabs)                                                                                                                         |
| M7        | Signals (By stock, By strategy, live detail with the expected fan, Paper book, Alerts), and the top-bar freshness indicator wired to Layer 5                                             |

### 8.11 API surface the UI needs (summary)

| Area        | Endpoints                                                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Syncs       | existing + `POST /dataset-syncs/:id/backfill`, `GET .../backfill`, `POST .../backfill/pause\|resume`, schedule mode `event`                                                                                                                         |
| Health      | `GET /datasets/health`, `GET /datasets/health/:collection/gaps?days=90`                                                                                                                                                                             |
| Catalog     | `GET /catalog`, `GET /catalog/:collection`, `PATCH /catalog/:collection` (descriptions, caveats), `GET /catalog/:collection/agent-view`, `GET /catalog/lineage`, `POST /catalog/export`                                                             |
| Transforms  | `GET/POST /transforms`, `GET/PUT/DELETE /transforms/:id`, `GET /transforms/:id/versions`, `POST /transforms/:id/preview`, `POST /transforms/:id/run`, `GET /transforms/:id/runs`                                                                    |
| Research    | `GET /research/status`, `POST /research/pause\|resume`, `GET/PUT /research/settings`, `GET /research/gates/:version`, `GET /research/activity?since=` (SSE stream)                                                                                  |
| Ideas       | `GET /ideas?filters`, `GET /ideas/:id`, `GET /ideas/:id/evaluations`, `GET /ideas/:id/debate`, `GET /ideas/:id/code?version=`, `POST /ideas/:id/actions` (approve, park, reject, send-back), `POST /ideas/:id/reproduce`, `GET /ideas/compare?ids=` |
| Simulations | `POST /simulations`, `GET /simulations`, `GET /simulations/:id`, `GET /simulations/:id/series?metric=`, `GET /simulations/:id/trades`, `GET /simulations/:id/positions?date=`, `POST /simulations/:id/go-live`                                      |
| Signals     | `GET /signals?date=&by=stock\|strategy`, `GET /live-strategies`, `GET /live-strategies/:id`, `POST /live-strategies/:id/pause\|resume`, `GET /paper-book`, `GET /alerts`, `POST /alerts/:id/ack`                                                    |

All series endpoints return `{dates: [], series: {name: []}}`, downsampled on the server, so every chart uses the same wrapper.

---

## 9. Roadmap (vertical slices, value early)

Rather than finishing each layer before starting the next, ship one thin path through all five layers first, then widen it. Each milestone ends with something you can use.

| Milestone                                | Scope                                                                                                                                                                                                                                                                                               | Exit                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **M1. Layer 1 complete + Catalog v1**    | L1-1 to L1-11. Catalog auto-generation for Layer 1. Backfill to 10y. Delete dead code, fix mapping.                                                                                                                                                                                                 | §2 exit criteria; every Layer 1 collection described in the catalog         |
| **M2. Transforms tab + core transforms** | The Transform resource (with multiple outputs), its API and UI (editor, preview, schedule, history), the SDK additions and dependency triggers. Migrate the five existing modules, with the H1–H6 and M2 fixes. Add `fundamentals_pit`, `features_daily` and `universe_daily`. Catalog for Layer 2. | §3 exit criteria                                                            |
| **M3. Trusted evaluator + data tools**   | Plugin contract, as_of reader, evaluator with costs, walk-forward, holdout, deflated Sharpe, evaluation records. MCP catalog and query tools with as_of enforcement + fuzz test. Lookahead canary.                                                                                                  | Random signal ≈ 0 Sharpe; 12-1 momentum shows 2022 drawdown; canary blocked |
| **M4. Research loop v1**                 | Theorist, Judge, Coder agents, state machine, theory memory with dedupe, lifecycle tools, research workflow, seed skills.                                                                                                                                                                           | §4 exit criteria                                                            |
| **M5. Ideas tab**                        | Board, proof pack page, charts, code viewer, human actions and feedback to agents.                                                                                                                                                                                                                  | §6 exit (ideas part)                                                        |
| **M6. Simulations**                      | Paper broker and ledger, simulation runs, simulations tab, multi-idea portfolio sim.                                                                                                                                                                                                                | §6 exit (sims part)                                                         |
| **M7. Live signals and dry run**         | Live runner, signals collection, live paper book, tracking, decay alerts, signals UI, stock-analyst skill reads signals.                                                                                                                                                                            | §7 exit                                                                     |
| **M8. Widen**                            | Remaining Layer 2 transforms (analyst, insider, congress, 13F via EDGAR), macro overlays, options/borrow data when you upgrade data, shorts and options in evaluator and broker.                                                                                                                    | Per issue                                                                   |

Each milestone also ships the screens listed in §8.10. M1 and M2 are pure data work and don't depend on agents. M3 is the foundation that makes M4's results trustworthy, so don't skip it.

---

## 10. What happened to the previous issues

The previous roadmap (Phases 0–7 and the pipeline spec's steps) has been replaced by this document. Its issues are closed as _not planned_, each with a comment linking the new issue(s) it was folded into.

| Previous issue(s)                                   | Folded into                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| #38 Phase 0, #25–#31 (H1–H6, M2)                    | M2.10, M2.11 (the pipeline modules move into Transforms); M1.16 (backfill)            |
| #15 statement depth                                 | M1.05 (L1-1)                                                                          |
| #34 backfill runner, #14 full backfill              | M1.08 (sync backfill), M1.16, M2.02 (transform backfill ranges)                       |
| #16, #32 earnings timing / payload_hash             | M1.13 (caveat now), M8.01 (BMO/AMC via SEC 8-K), M2.03 (content hash)                 |
| #55 delisted paging, #17 index constituents         | M1.13 (caveats now), M8.04 (data upgrade)                                             |
| #6 fundamentals_pit, #39 Phase 1                    | M2.12, M8.01                                                                          |
| #10 Layer 3 features, #40 Phase 2                   | M2.13, M2.14                                                                          |
| #11 validation + lookahead tests                    | M3.05, M2.11 (DQ threshold gates)                                                     |
| #12 agent views + read tools, #48 server-side as_of | M3.06                                                                                 |
| #13 backtest tool + holdout, #41 Phase 3            | M3.02, M3.03, M3.04, M4.03                                                            |
| #52 evidence window / revision proxies              | M4.04 (`forward_only`), M8.01 (analyst_events proxies)                                |
| #19 swarm, #43 Phase 5                              | M4.06                                                                                 |
| #49 rules replay, #53 paper broker                  | M6.02, M6.01                                                                          |
| #44 Phase 6 paper trading                           | M7.01, M7.06                                                                          |
| #8 remaining Layer 2, #9 13F, #37 macro             | M8.01, M8.02, M8.03                                                                   |
| #35 borrow, #36 options, #45 Phase 7                | M8.05, M8.06                                                                          |
| #42 probability engine                              | Not in this roadmap. Mechanical evaluator gates (M3.04, M4.04) replace it.            |
| #50 agent-mode replay, #51 replay reporting         | Not in this roadmap. Proof packs (M5.03) and simulation reports (M6.03) replace them. |

These issues are kept because they are outside this roadmap: #62 (execution state to the database plus shared RWX storage, needed to scale the app tier), #33 (pipeline CI job; hosted CI stays off unless enabled), and #18 (dead OpenShell UI code).

---

## 11. Implementation plan (GitHub issues)

Work top to bottom. Each item is one PR-sized issue, and later items depend on earlier ones. The ordered checklist lives in [#139](https://github.com/bhajian/StockHarness/issues/139).

### M1 · Layer 1 complete + Catalog v1

| Order | Issue | Title                                                                                                                    |
| ----- | ----- | ------------------------------------------------------------------------------------------------------------------------ |
| M1.00 | #152  | Everything is a YAML object: common envelope + export/import framework for every layer (config, code, policies, records) |
| M1.01 | #73   | Shared UI components + Datasets nav restructure (Syncs, Transforms, Catalog, Health)                                     |
| M1.02 | #74   | Chart foundation: ECharts TimeSeriesChart wrapper + standard series API format (LTTB downsampling)                       |
| M1.03 | #75   | Remove dead Layer 1 code: old stock-data-sync flows, fin\_\* collections, fix layer1_mapping.yaml                        |
| M1.04 | #76   | Sync detail page + Syncs list columns (Priority, History, Coverage, Next run)                                            |
| M1.05 | #77   | Per-sync history depth (from, statementQuarters) + plan-depth probe; target 10y prices, 40 quarters                      |
| M1.06 | #78   | Sync priority (P0/P1/P2) + priority-aware scheduler and FMP rate limiter                                                 |
| M1.07 | #79   | Schedule modes: Interval / Daily / Weekly / Event + hourly cadence for news, quotes, price targets                       |
| M1.08 | #80   | Backfill mode per sync: chunked, resumable, pausable, with progress; never blocks the daily schedule                     |
| M1.09 | #81   | Emit dataset.sync.completed events + subscription mechanism                                                              |
| M1.10 | #82   | Event-driven syncs: "after earnings + N days" and "after another sync completes"                                         |
| M1.11 | #83   | Ingest validation + schema drift detection (fail sync items loudly)                                                      |
| M1.12 | #84   | Schema Catalog v1: dataset_catalog collection, auto-generated after every sync, + API                                    |
| M1.13 | #85   | Record FMP plan limits as catalog caveats (delisted ~100, constituents 402, estimate history, earnings timing)           |
| M1.14 | #86   | Datasets > Health tab + data freshness indicator in the top bar                                                          |
| M1.15 | #87   | Datasets > Catalog UI: collection list + collection page                                                                 |
| M1.16 | #88   | Run the full Layer 1 backfill + verify M1 exit criteria                                                                  |
| M1.17 | #149  | Config backup in the repo: YAML exports of every configuration, kept current automatically + tested restore              |

### M2 · Transforms tab + core transforms

| Order | Issue | Title                                                                                                             |
| ----- | ----- | ----------------------------------------------------------------------------------------------------------------- |
| M2.01 | #89   | Transform resource: model (one or more outputs), CRUD + versions API, and the known_at save rule                  |
| M2.02 | #90   | Transform runner: executor, window injection, per-output write modes, run history                                 |
| M2.03 | #91   | oh SDK additions: upsert/upsert_df, window, chunked reads, duckdb, idempotent dq, describe, pit helpers           |
| M2.04 | #92   | Transform dependency triggers: after dataset:X / transform:Y                                                      |
| M2.05 | #93   | Code editor component (Monaco): Python, read-only, diff mode, traceback error markers                             |
| M2.06 | #94   | Transforms list + transform editor (inputs pane, code, outputs/trigger config)                                    |
| M2.07 | #95   | Transform preview run on a sample + validation bar (per output)                                                   |
| M2.08 | #96   | Transform versions (diff/restore) + run history UI                                                                |
| M2.09 | #97   | Catalog for Layer 2 outputs + lineage DAG (Catalog > Graph)                                                       |
| M2.10 | #98   | Migrate trading_calendar + securities to Transforms (fix H4, H5, H6, M2)                                          |
| M2.11 | #99   | Migrate corporate_actions + prices_daily + macro_daily to Transforms (fix H1, H2, H3); remove the Layer 2 harness |
| M2.12 | #100  | Transform: fundamentals_pit (merge statements, restatement versions, TTM)                                         |
| M2.13 | #101  | Transform: universe_daily (point-in-time tradeable universe)                                                      |
| M2.14 | #102  | Transforms: features_daily + features_ranked                                                                      |

### M3 · Trusted evaluator + data tools

| Order | Issue | Title                                                                                                             |
| ----- | ----- | ----------------------------------------------------------------------------------------------------------------- |
| M3.01 | #103  | Strategy plugin contract + as_of-enforced reader (ctx.read_df)                                                    |
| M3.02 | #104  | Trusted evaluator core: date walk, portfolio construction, next-day execution, costs, delisting, borrow           |
| M3.03 | #105  | Walk-forward splits + locked holdout (18 months, one shot)                                                        |
| M3.04 | #106  | Evaluator metrics incl. factor exposures and deflated Sharpe                                                      |
| M3.05 | #107  | Evaluator sanity suite: random signal ≈ 0, 12-1 momentum 2022 drawdown, lookahead canary, reproducibility         |
| M3.06 | #108  | MCP data tools: list/describe/sample/query_collection with server-side as_of + fuzz test                          |
| M3.07 | #109  | evaluate_strategy tool + dev-only evaluation result page                                                          |
| M3.08 | #148  | Collection-scoped MongoDB tools for harnesses: bind collections with read / write / delete permissions and schema |
| M3.09 | #153  | Run–test–fix loop for agent-written code (simple, reuses run_python + the executor)                               |

### M4 · Research loop v1

| Order | Issue | Title                                                                                   |
| ----- | ----- | --------------------------------------------------------------------------------------- |
| M4.01 | #110  | Theory model + lifecycle state machine with per-theory revision caps                    |
| M4.02 | #111  | Theory memory: Weaviate embeddings, search, near-duplicate rejection                    |
| M4.03 | #112  | Lifecycle MCP tools: submit_theory, review_theory, submit_code, set_verdict             |
| M4.04 | #113  | Versioned success gates (mechanical) + forward_only tagging for estimate-based theories |
| M4.05 | #114  | Seed skills: strategy families, plugin how-to, catalog how-to, judge checklist          |
| M4.06 | #115  | Research loop workflow: Theorist → Judge → Coder → Evaluator → Judge → verdict          |
| M4.07 | #116  | Research Lab UI: pipeline board, live activity (SSE), charts, settings, steering        |
| M4.08 | #117  | M4 acceptance: 7-day unattended research run                                            |

### M5 · Ideas tab

| Order | Issue | Title                                                                   |
| ----- | ----- | ----------------------------------------------------------------------- |
| M5.01 | #118  | Ideas API                                                               |
| M5.02 | #119  | Ideas list (table + card view)                                          |
| M5.03 | #120  | Idea detail (proof pack): verdict gates, KPIs, Overview, Results charts |
| M5.04 | #121  | Idea detail: Debate timeline, Code tab, Runs tab                        |
| M5.05 | #122  | Human actions + comments; "Send back" feeds the Theorist                |
| M5.06 | #123  | Compare 2–4 ideas                                                       |

### M6 · Simulations

| Order | Issue | Title                                                                        |
| ----- | ----- | ---------------------------------------------------------------------------- |
| M6.01 | #124  | Paper broker + simulated trade ledger (shared by simulations and live paper) |
| M6.02 | #125  | Simulation runs: API, multi-idea portfolio allocation, schedule modal        |
| M6.03 | #126  | Simulations tab: list + detail                                               |

### M7 · Live signals and dry run

| Order | Issue | Title                                                                      |
| ----- | ----- | -------------------------------------------------------------------------- |
| M7.01 | #127  | Live runner: approved strategies run after data events; signals collection |
| M7.02 | #128  | Live paper book: shared broker per strategy and for the combined book      |
| M7.03 | #129  | Live vs expected tracking, decay alerts, auto-park                         |
| M7.04 | #130  | Signals UI + Go live                                                       |
| M7.05 | #131  | Daily brief from signals (stock-analyst skill) + email digest              |
| M7.06 | #132  | M7 acceptance: one approved strategy live for 30 trading days              |

### M8 · Widen

| Order | Issue | Title                                                                                          |
| ----- | ----- | ---------------------------------------------------------------------------------------------- |
| M8.01 | #133  | Remaining Layer 2 transforms: estimates, analyst events, earnings (BMO/AMC), insider, congress |
| M8.02 | #134  | 13F ingestion: SEC EDGAR + OpenFIGI                                                            |
| M8.03 | #135  | Macro overlays: oil, DXY, GPR, EPU, FOMC                                                       |
| M8.04 | #136  | Data upgrade: full delisted history + index constituents                                       |
| M8.05 | #137  | Short borrow data + shorts in the evaluator and broker                                         |
| M8.06 | #138  | Options chains + historical IV; options in the evaluator and broker                            |
