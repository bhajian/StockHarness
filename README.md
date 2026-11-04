# StockHarness

**StockHarness** is a self-hosted research system for finding, proving and running stock-trading strategies.

- It keeps a clean, point-in-time copy of 5–10 years of market data.
- A team of AI research agents proposes trading theories and tests each one on a trusted backtest engine.
- You review the evidence, approve the ideas that hold up, and simulate them over history.
- Approved strategies then run live, producing daily signals against a paper (dry-run) portfolio.

It works in five layers:

1. It syncs historical and scheduled market data from Financial Modeling Prep (FMP) into MongoDB.
2. It prepares that data into clean, point-in-time collections.
3. AI research agents propose theories and test them against a trusted backtest engine.
4. People review the results, approve ideas and simulate them over history.
5. Approved strategies produce live signals and run in a paper (dry-run) portfolio.

StockHarness's agents, harnesses, durable runner, Python executor and API are its own platform. They were forked from the open-source [OpenHarness](https://github.com/deepfinery/OpenHarness) project, which StockHarness extends with the market-data, research, simulation and live layers.

- **Product guide:** [PRODUCT.md](PRODUCT.md) explains the finished product:
  - every one of the 42 datasets, with its fields and real example rows,
  - the clean Layer 2 collections,
  - the research agents, their skills and about 40 strategy ideas, with a worked end-to-end example,
  - what each layer does in the app.
- **Roadmap:** [ROADMAP.md](ROADMAP.md) describes the 5-layer architecture, the gaps and the ordered plan. The ordered checklist is pinned as [#139](https://github.com/bhajian/StockHarness/issues/139).
- **Platform reference:** [docs/platform.md](docs/platform.md) covers StockHarness's agents, harnesses, runs, resilience, configuration and the API.
- **Live instance:** https://openharness.faberiq.ai (AWS EKS; the host name predates the rename).

## Contents

- [Architecture](#architecture)
- [What works today](#what-works-today)
- [Quick start](#quick-start)
- [Datasets (Layer 1)](#datasets-layer-1)
- [Data prep pipeline (Layer 2)](#data-prep-pipeline-layer-2)
- [Agents and research](#agents-and-research)
- [Repository layout](#repository-layout)
- [Deployment](#deployment)
- [Development and verification](#development-and-verification)
- [Project rules](#project-rules)
- [License](#license)

## Architecture

```
 Layer 1  DATA SYNC        FMP -> raw Mongo collections, historic + scheduled
              |  contract: Schema Catalog + point-in-time fields
 Layer 2  DATA PREP        Python transforms -> many clean, flat, point-in-time collections
              |  contract: Schema Catalog + Data Access tools (as_of enforced)
 Layer 3  RESEARCH AGENTS  Theorist -> Judge -> Coder -> trusted Evaluator -> Judge -> verdict loop
              |  contract: Theory record + Proof Pack
 Layer 4  IDEAS & SIMS     Review ideas, proofs and charts; human approval; full historical simulation
              |  contract: Approved Strategy (versioned code + params)
 Layer 5  LIVE             Daily signals, paper (dry-run) portfolio, live vs expected tracking
```

Three rules hold the system together:

- **Point in time.** Every row records when it became known. The platform, not the agent, filters every read "as of" a date, so neither backtests nor agents can see the future.
- **Schema Catalog.** Every collection is described by machine-readable metadata: its fields, time semantics, coverage and caveats. Agents work from that description instead of guessing.
- **Trusted evaluator.** Agents write the strategy logic. A fixed, tested engine runs the backtests and computes the metrics, so agents never grade their own work.

## What works today

| Area                                                                              | Status                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Layer 1: dataset syncs**                                                        | ✅ 42 FMP datasets with schedules, a survivorship-aware sync universe, append-only snapshots and statements, bulk actions, and YAML config export/import. See [Datasets](#datasets-layer-1).                                     |
| **Layer 2: pipeline modules**                                                     | 🟡 `trading_calendar`, `securities`, `corporate_actions`, `prices_daily` and `macro_daily` exist in [`pipeline/`](pipeline/README.md) and run from a harness. Moving them into a first-class **Transforms** tab is milestone M2. |
| **Agent platform**                                                                | ✅ Agents, harnesses, schedules, the Python executor (`run_python` and code steps), MongoDB over MCP, knowledge, skills and the API. See [docs/platform.md](docs/platform.md).                                                   |
| **Schema Catalog, trusted evaluator, research loop, Ideas, Simulations, Signals** | ⏳ Planned in milestones M1–M7. See [ROADMAP.md](ROADMAP.md).                                                                                                                                                                    |

Known data limits on the current FMP plan:

- Delisted-company history covers only about 100 names.
- Index constituents aren't available.
- Estimate and consensus history starts at the first weekly snapshot (October 2026).

These limits are tracked as catalog caveats (M1.13).

## Quick start

You need Docker with Docker Compose, and OpenSSL.

```sh
git clone https://github.com/bhajian/StockHarness.git
cd StockHarness
./start.sh
```

1. Open the address `./start.sh` prints (**http://localhost:8088** by default).
2. Create the first administrator using the `SETUP_TOKEN` written to `.env`. There is no default account.
3. **Add a model provider:** go to Settings → Model providers.
4. **Connect FMP:** go to MCP connections → Connect a server, and paste your FMP MCP URL with the API key in the query string, for example `https://…/mcp?apikey=YOUR_KEY`. The dataset sync engine reads the `apikey` from that URL. Agents can use the same connection as tools.
5. **Add dataset syncs:** open **Dataset** and choose **Add dataset sync**. Or use **Import YAML** to load a saved configuration, such as an earlier export.

Later starts reuse `.env` and the volumes. Run `docker compose up --build -d --wait` after pulling changes. Allow about 4 GB of memory for the stack.

## Datasets (Layer 1)

The **Dataset** tab syncs raw FMP data into your workspace's MongoDB, one collection per dataset. The sync runs in the backend; it doesn't use a harness or an agent.

- **Catalog:** 42 datasets in 7 categories (each is described with its fields and a real example in [PRODUCT.md §4](PRODUCT.md#4-layer-1-data-sync)):
  - Prices: EOD stocks and indexes.
  - Market: treasury rates, sector performance, gainers and most active, news, GDP, CPI.
  - Calendars: earnings, dividends, splits, and full dividend and split history.
  - Fundamentals: statements, metrics, ratios, scores, growth, segments, owner earnings.
  - Estimates: analyst estimates, price targets, grades.
  - Ownership: insider and congress trades.
  - Reference: the sync universe, profiles, float, market cap, peers, executives, employees.

  They're defined in [`packages/core/src/datasetCatalog.ts`](packages/core/src/datasetCatalog.ts).

- **Symbols:** a per-symbol dataset takes its tickers from one of:
  - the **universe** collection,
  - a **screener preset** (mega cap, large cap, S&P 500-like, Nasdaq-100-like, all NYSE, all Nasdaq),
  - an explicit list.

  The universe sync combines active names with delisted companies, to reduce survivorship bias.

- **Schedules:** every N minutes, or daily or weekly at a wall-clock time in a chosen time zone. Each sync has its own date range, retention and target collection.
- **History is preserved:** weekly snapshot datasets append a row per `snapshot_date`, and statements append each restatement (keyed by `acceptedDate`) instead of overwriting it.
- **Bulk actions:** select rows, or all of them, then:
  - **Run** the selection one after another,
  - **Enable** or **Disable**,
  - **Reset cursor** (the next run re-pulls history),
  - **Purge records** (keeps the sync),
  - **Delete** (optionally dropping collections no other sync writes to).
- **Config as YAML:** **Export all** or **Export selected** writes the sync settings as YAML. The connection is written by name, and no secrets or data are included. **Import YAML** previews what it will create, update or remove, then applies all-or-nothing. _Merge_ matches syncs by name; _Replace_ also removes syncs that aren't in the file.
- **Pacing:** FMP calls are rate-limited (`DATASET_SYNC_RPM`, default 250 per minute) with retries. A failing symbol never fails the whole dataset.

The synced collections can be browsed in the tab, used by agents through the built-in MongoDB MCP connection, and read in Python with `oh.read` / `oh.read_df`.

[`deploy/config-io/`](deploy/config-io/README.md) has a CLI that exports and imports dataset syncs, harnesses, agents and skills from outside the studio.

## Data prep pipeline (Layer 2)

[`pipeline/`](pipeline/README.md) is a Python package baked into the executor image (`import pipeline`). It turns Layer 1 into typed, deduplicated, point-in-time collections:

- Every row carries `known_at`, `as_of_date` and lineage.
- Joins use an immutable `security_id`, never the ticker.
- Rejected rows go to `dq_issues`.

| Module              | Output                                                                               |
| ------------------- | ------------------------------------------------------------------------------------ |
| `trading_calendar`  | NYSE trading days                                                                    |
| `securities`        | Security identity, with ticker, sector and exchange history over time                |
| `corporate_actions` | Deduplicated splits and dividends, full history                                      |
| `prices_daily`      | Split- and dividend-adjusted daily prices and total returns, with data-quality flags |
| `macro_daily`       | Treasury curve, VIX, index levels, sector returns                                    |

Today the chain runs from the "Pipeline Layer 2" harness ([`deploy/pipeline-harness/`](deploy/pipeline-harness)). Milestone M2 replaces it with a **Transforms** tab. There, Python transforms are edited in the UI, previewed, run on a schedule or after their input syncs, and documented in the Schema Catalog. Each transform can write one or more flat output collections. See [`pipeline/GAPS.md`](pipeline/GAPS.md) for the Layer 1 gap analysis and [`pipeline/docs/replay.md`](pipeline/docs/replay.md) for the simulation and paper-broker design.

## Agents and research

The StockHarness platform provides:

- agents with four patterns (ReAct, plan-and-execute, reflection, autonomous loop),
- unlimited budgets when configured, and a model role per agent,
- harness graphs with agent, code, condition, parallel and email steps,
- schedules, skills, knowledge bases, and MCP tools.

Agents can run Python they write themselves (`run_python`, with up to 1,000 parallel parameter sets) in an isolated executor. The executor includes pandas, polars, duckdb, scipy, statsmodels, scikit-learn, LightGBM, TA-Lib and empyrical. See [docs/python-executor.md](docs/python-executor.md) and [docs/platform.md](docs/platform.md).

[PRODUCT.md §7](PRODUCT.md#7-layer-3-research-agents) describes the planned agents (Theorist, Judge, Coder), the skills they load, the strategy ideas they explore, and a full theory → code → evaluation → verdict example.

The research layers are planned in [ROADMAP.md](ROADMAP.md):

- a Theorist, Judge and Coder agent loop,
- a trusted evaluator with walk-forward testing, a locked holdout and deflated Sharpe,
- theory memory with near-duplicate rejection,
- Ideas proof packs, simulations through a shared paper broker, and live signals.

## Repository layout

| Path                      | Purpose                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                | Express API: auth, resources, dataset syncs, scheduler, queue dispatcher, SSE, static UI                                                             |
| `apps/runner`             | RabbitMQ consumer: run execution, checkpoints, agent patterns, document ingestion                                                                    |
| `apps/studio`             | React studio: Datasets, harness canvas, playground, knowledge, connections, settings                                                                 |
| `packages/core`           | Shared runtime: schemas, agent runtime, LLM adapters, MCP, dataset catalog and sync engine, storage                                                  |
| `pipeline/`               | Python Layer 2 library: PIT helpers, securities, prices, corporate actions, macro, tests                                                             |
| `python-executor/`        | Executor image and the `oh` SDK (`oh.py`)                                                                                                            |
| `mongodb-mcp/`            | MongoDB MCP server giving agents per-workspace database access                                                                                       |
| `skills/`                 | Agent skills kept in the repo, e.g. [`strategy-library.md`](skills/strategy-library.md), the 42 strategy cards (also in the config-io skills export) |
| `deploy/k8s`              | Kustomize base and overlays (`aws`, `nebius`, `generic`) and scripts                                                                                 |
| `deploy/config-io`        | Config export/import CLI and the committed exports                                                                                                   |
| `deploy/pipeline-harness` | Builder for the current Layer 2 harness (to be replaced by Transforms)                                                                               |
| `gateway`, `connector-*`  | Device gateway and connectors (inherited from OpenHarness; not used in the StockHarness UI)                                                          |
| `tests/`                  | Unit, real-stack integration, fault-injection and browser tests                                                                                      |
| `docs/`                   | Platform documentation ([platform reference](docs/platform.md))                                                                                      |

## Deployment

### Local

Use Docker Compose via `./start.sh` (see [Quick start](#quick-start)).

### Kubernetes

[deploy/k8s/INSTALL.md](deploy/k8s/INSTALL.md) is the generic guide. The live instance runs on **AWS EKS**:

|                     |                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Cluster / namespace | `deepfinery-training-eks` / `openharness`, a legacy name (us-east-1)                                                          |
| Public URL          | https://openharness.faberiq.ai (an ALB terminates TLS)                                                                        |
| Images              | ECR `491085405405.dkr.ecr.us-east-1.amazonaws.com/openharness/{app,gateway,mongodb-mcp,python-executor}`                      |
| Manifests           | [`deploy/k8s/overlays/aws`](deploy/k8s/overlays/aws/kustomization.yaml): gp3 EBS storage, HTTP proxy, no Caddy, NeMo or Garak |

To release an app change:

```sh
SHA=$(git rev-parse --short=12 HEAD)        # build from a clean worktree of main
aws ecr get-login-password --region us-east-1 \
  | docker login -u AWS --password-stdin 491085405405.dkr.ecr.us-east-1.amazonaws.com
docker buildx build --platform linux/amd64 --push -f Dockerfile \
  -t 491085405405.dkr.ecr.us-east-1.amazonaws.com/openharness/app:$SHA .
# set newTag for openharness in deploy/k8s/overlays/aws/kustomization.yaml, then:
kubectl diff  -k deploy/k8s/overlays/aws    # expect only the image change
kubectl apply -k deploy/k8s/overlays/aws
kubectl -n openharness rollout status deployment/app
```

The `app` Deployment runs the API and the runner as a single replica with the `Recreate` strategy, because the files volume can only attach to one node (ReadWriteOnce). That means:

- every rollout restarts any in-progress dataset sync,
- check `dataset_sync_runs` for `status: running` before deploying.

Removing this limit is tracked in [#62](https://github.com/bhajian/StockHarness/issues/62).

## Development and verification

You need Node.js 22 or later.

```sh
npm ci
npm run typecheck
npm test                 # unit tests
npm run build
```

- **Real-stack tests:** `./scripts/test-stack.sh` runs the full integration suite in an isolated `openharness-test-*` Compose project.
- **Dataset tests:** the dataset sync tests need only MongoDB. Start one in an isolated test project, then run:

  ```sh
  MONGODB_URI=mongodb://127.0.0.1:27118/agentic_test MONGODB_DATABASE=agentic_test \
    node --import tsx --test --test-concurrency=1 tests/integration/dataset-*.test.ts
  ```

- **Pipeline tests:** `python3 -m unittest discover -s pipeline/tests -t .`.
- **UI against a local API:** `npm run dev`, then open http://localhost:5173.

## Project rules

The full rules are in [AGENTS.md](AGENTS.md):

- Every change gets a GitHub issue, a dedicated branch, and a PR linked with `Closes #<issue>` that is merged to `main`.
- Hosted CI is disabled, so run the relevant local checks before merging.
- Everything needed to build from a fresh clone lives in this repository.
- External agent tools use MCP only.
- Fault injection only ever touches the isolated test Compose project.

## License

Apache License 2.0, inherited from OpenHarness. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party packages and container images keep their own licenses.
