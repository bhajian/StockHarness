# Ideas (M5)

An **idea** is a research-loop theory seen by a person: the theory with its evaluations, its debate, its code versions
and the gates that decided it.

## API (#118)

| Endpoint                           | What it returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/ideas`                   | KPIs (successful, promising, approved, failed, in progress, forward-only) and the ideas with their key numbers (exploration Sharpe, deflated Sharpe, excess over the S&P 500 per year, max drawdown, holdout, gates version, an equity sparkline). Filters: `status` (comma list or `in_progress`), `family`, `side`, `horizonMin`/`horizonMax`, `data` (a collection or `collection.field`), `gatesVersion`, `q` (text or `T-<n>`). `sort`: `dsr` (default), `sharpe`, `excess`, `recent` |
| `GET /api/ideas/:id`               | the theory, the models per role, the gates (the verdict's own results, or the active gates applied now), the Judge's latest summary, the exploration and holdout evaluations, comments, and the actions available                                                                                                                                                                                                                                                                          |
| `GET /api/ideas/:id/evaluations`   | every evaluation: trials, the holdout and reproductions (data snapshot, code hash, evaluator version, record hash, metrics)                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/ideas/:id/debate`        | every turn (Theorist, Judge, Coder, evaluator, human) with model and time. Each number an agent cites is linked to the evaluation that produced it, or flagged as unsourced                                                                                                                                                                                                                                                                                                                |
| `GET /api/ideas/:id/code?version=` | every plugin version (test outcome, error, note), the selected code and the previous version for a diff                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/ideas/:id/actions`      | `approve`, `park`, `reject` (needs a reason), `send_back` (needs a comment; the Theorist sees it in its next brief)                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/ideas/:id/comments`     | a comment in the debate                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/ideas/:id/reproduce`    | re-runs an exploration evaluation with the same code and parameters. It is not a new trial, and it reports match or mismatch of the record hash                                                                                                                                                                                                                                                                                                                                            |
| `GET /api/ideas/compare?ids=`      | 2–4 ideas: equity overlay (standard series format, downsampled), metrics side by side, return correlation, holdings overlap                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/ideas/:id/export`        | the idea as YAML records: the plugin with every version, its evaluations and the theory with its debate. It imports into another workspace and exports identically                                                                                                                                                                                                                                                                                                                         |

People can send back any reviewed idea (with a comment) and reject a successful or approved one. These moves are
not capped; the caps bound the agents.

## The Ideas pages (#119–#123, #269)

The studio's **Ideas** item (also _All ideas_ on the Research page, and every board card and activity entry there)
opens the master table. Every page is a URL, so a link, a reload or Back lands on the same view.

- `/ideas` — KPI cards (successful, promising, approved, failed, in progress, forward only), then a filter bar: the status view
  (successful & approved by default, promising, in progress, failed & rejected, all), search, family, side, sort, and a table /
  card toggle, all kept in the query string. The table is windowed for thousands of ideas and shows Sharpe, deflated
  Sharpe, excess per year, max drawdown, the holdout and an equity sparkline. Tick 2–4 ideas and _Compare_.
- `/ideas/T-n[/tab]` — the idea: status, gates version (locked by the verdict, or the current one), side, horizon,
  revisions, trials and the model per role; administrator actions (approve, park, reject…, send back… with a
  comment the Theorist reads in the next brief, reproduce) and _Export YAML_; the gate checklist and the Judge's last
  word; then the tabs:
  - **Overview** — hypothesis, rationale, signal, falsification, universe; data chips open the Schema Catalog.
  - **Results** — the latest exploration's proof pack (the same report as the evaluation page) and the holdout,
    evaluated once.
  - **Review** — the debate turn by turn. Numbers the agents cite are chips: sourced ones link to the evaluation they
    come from, unsourced ones are marked red. Administrators can comment.
  - **Code** — every plugin version with its test outcome and error; read-only code with a diff against the version
    before; Copy.
  - **Runs** — every evaluation (explore, holdout, reproductions with match / mismatch) with a per-run Reproduce.
- `/ideas/compare?ids=T-1,T-2` — equity overlay, a metrics table with the best value per row highlighted, return
  correlation and holdings overlap.

## Verdicts: successful, promising, failed (#113, #354)

The verdict is mechanical. The Judge calls `set_verdict` on an idea in post_review, and the active gates
decide:

- **Successful:** every gate passes, including the one-shot holdout. The holdout runs only when every
  exploration gate has passed. The Judge may downgrade a successful idea to failed, with reasons, but can never
  upgrade a failing one.
- **Promising:** it beat the S&P 500 over the evaluation (positive excess per year), and the only gates that failed
  are the proof gates (`deflated_sharpe`, `alpha_t`). Sharpe, positive excess years, trades, holdings and the
  warnings all passed. It worked, but it is not proven to be more than luck over all the trials, or more than
  known factors. This label comes from the gates, whatever the Judge asked for. A person may park it, fail it or
  send it back.
- **Failed:** anything else: it lost to the S&P 500, a performance gate failed, or the holdout failed.

Verdicts given before the label existed are relabelled once, at startup, from their recorded gates. The history
records the change: a `failed → promising` move by the evaluator.
