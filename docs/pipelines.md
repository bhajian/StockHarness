# Pipelines

A **pipeline** runs the layers as one dependency graph (DAG): Layer 1 syncs, then Layer 2 transforms, then
Layer 3 research and Layer 5 live signals, plus harnesses and checks. A run covers one **period** (a day, an
ISO week or a month). A node starts only when every node it depends on has **succeeded and passed its gate**.
Layer 2 is optional: a research, live or harness node can sit right after a sync.

Pipelines are YAML objects (`kind: Pipeline`), exported and imported with everything else
(Settings → Configuration, or `deploy/config-io`).

```yaml
apiVersion: stockharness/v1
kind: Pipeline
metadata: { name: weekly-research }
spec:
  period: week # day | week | month | event
  schedule: { enabled: true, everyMinutes: 10080, at: '06:00', weekday: 6, timezone: America/New_York }
  deadline_hours: 12 # past this an alert event is raised
  nodes:
    - { id: eod, ref: 'sync:L1 — EOD prices', gate: { min_symbol_coverage: 0.95 } }
    - { id: statements, ref: 'sync:L1 — Income statement (quarterly)' }
    - { id: prices, ref: 'transform:prices_daily', after: [eod], gate: { min_rows: 1000 } }
    - { id: fund, ref: 'transform:fundamentals_pit', after: [statements] }
    - {
        id: ready,
        ref: 'check:collection_rows',
        after: [prices],
        params: { collection: prices_daily },
        gate: { min_rows: 1 },
      }
    - { id: brief, ref: 'harness:Daily brief', after: [ready, fund], on_upstream_failure: skip }
```

## Nodes

| Type        | Runs                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------- |
| `sync`      | the dataset sync (its own incremental window); stats: rows, symbols attempted/covered    |
| `transform` | the transform with the run's period as its window; stats: rows (written + unchanged), DQ |
| `harness`   | a harness run, with the period in its payload                                            |
| `check`     | `collection_rows`: rows of `params.collection` in the period (`params.date_field`)       |
| `research`  | Layer 3 (arrives with M4)                                                                |
| `live`      | Layer 5 (arrives with M5)                                                                |

Per node: `after` (upstream node ids), `gate`, `on_upstream_failure` (`block`, the default; `skip`;
`continue_with_warning`), `params`, `retries` (default 1, with 1/5/15 min backoff) and `timeout_minutes`.

**Gates**, checked after a node succeeds (the results are stored with the node run):
`min_symbol_coverage` (syncs), `min_rows`, `max_row_drop_pct` (versus the previous period), and
`max_dq_error_rate` (transforms). A failed gate is `gate_failed`, and downstream nodes are blocked.

## Runs

- **Periods.** One run per pipeline per period. A run covers the period that contains the day before it
  starts: Saturday's weekly run covers that ISO week, a daily run covers yesterday, and a run on the 1st
  covers the previous month.
- **Shared nodes.** Two pipelines that need the same node (the same ref) for the same period run it once.
- **Restarts.** State lives in MongoDB (`pipeline_runs`, `pipeline_node_executions`), so a restart resumes
  without re-running completed nodes.
- **Controls:**
  - **retry** a failed or blocked node,
  - **re-run from here** (the node and everything downstream; upstream results are kept),
  - **skip** a node with a reason (downstream treats it as done),
  - **cancel** the run.
- **Backfill:** `POST /api/pipelines/:id/backfill { from, to, parallelism }` queues past periods. They
  start oldest first, `parallelism` at a time, without touching the schedule.
- **Events:** `pipeline.node.completed`, `pipeline.run.completed` and `pipeline.run.deadline_missed`, for
  harnesses and webhooks.

## API

| Method and path                                              | Purpose                                        |
| ------------------------------------------------------------ | ---------------------------------------------- |
| `GET/POST /api/pipelines`, `GET/PUT/DELETE /:id`             | definitions (the list includes each `lastRun`) |
| `POST /api/pipelines/validate`                               | errors (block saving) and warnings for a draft |
| `GET /api/pipelines/suggest?transforms=a,b`                  | "Generate from dependencies"                   |
| `POST /api/pipelines/:id/run { period? }`                    | start a run (the current period by default)    |
| `POST /api/pipelines/:id/backfill`                           | runs for past periods                          |
| `GET /api/pipelines/:id/runs`, `GET /api/pipeline-runs/:id`  | run history and one run with all node runs     |
| `POST /api/pipeline-runs/:id/nodes/:node/retry\|rerun\|skip` | node controls (`skip` takes `{ reason }`)      |
| `POST /api/pipeline-runs/:id/cancel`                         | cancel                                         |

A transform's `trigger.after` stays as the simple per-transform shorthand (#92). Pipelines add periods,
gates, other layers and run tracking.
