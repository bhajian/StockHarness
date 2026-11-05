# The research loop (Layer 4, M4)

Agents propose theories, review them, write strategy plugins and score them with the trusted evaluator
(docs/strategies.md). Success is mechanical: the gates decide, and the Judge may only downgrade.

## Theories (#110)

A theory is a testable hypothesis, stored in `theories`:

- **Content:** title, hypothesis, rationale, the data it needs (catalog collections and fields), universe, the
  signal logic in words, horizon, direction, a falsification condition, family and tags.
- **Numbering:** each theory is `T-<number>` in its workspace.
- **Lifecycle:**

```
draft → pre_review → (revise → pre_review)* → rejected_untestable | approved_for_code
approved_for_code → coding → (code_error → coding)* → evaluated → post_review → (revise_code → coding)*
post_review → failed | successful → (human) approved | parked
```

Rules (`packages/core/src/theoryLifecycle.ts`, enforced on every change):

- **Roles:** the Theorist submits and revises; only the Judge reviews and gives verdicts; only the Coder codes;
  the evaluator records results; only a human approves or parks.
- **Caps:** at most 3 revisions per theory (pre-code and post-result together), and 5 code retries after an
  error. At a cap the way back closes, and the Judge must decide. Both caps come from the workspace's research
  settings.
- **Edits:** content can change only in `draft` or `revise`.
- **Atomic moves:** a transition applies only if the theory is still in the state that was read, so two agents
  cannot both move it.
- **The debate:** every transition, edit and link is kept in `history` with its actor (role, agent, model, run)
  and reasoning. The Ideas pages show it (M5).
- **Links:** the theory records its plugin versions and evaluations. Each evaluation counts as one of its
  `trials`.

`/api/theories` lists, reads, creates, edits and moves theories; people act as the `human` role there. Agents use
the lifecycle MCP tools (#112).

**`Theory` objects** export with their debate, links and trial count. Import restores them as they were and adds
their trials to the workspace's trial count, so the deflated Sharpe stays honest. Numbering continues after
imported theories, and an existing theory is never overwritten.

## Theory memory (#111)

Every theory is embedded (title, hypothesis and signal logic). It is stored in the vector store (Weaviate here) for
search, and in `theory_embeddings` with its vector for exact cosine similarity. Drafts, failed and rejected theories
stay in memory, and they still count as trials.

- **Search:** `GET /api/theories/search?q=` (and the `search_theories` tool, #112) returns the closest theories
  with their similarity, ranked by the vector store's hybrid search when it is available.
- **Duplicate check:** on submit for review (and on re-submit after a revision), a theory whose similarity to any
  other is at or above the threshold (default **0.9**, research settings `duplicateThreshold`) is refused. The
  error names the match and its score. Nothing is created, unless the theory says what is different in
  `differsFrom`. The closest match is recorded on the transition.
- **Embeddings:** the workspace's embedding provider (research settings `embeddingProviderId`, else its first
  embedding model). Without one, a local **lexical** vector (hashed words and word pairs) is used and labelled as
  such: it catches re-submissions and light rewording, not real paraphrases. Add an embedding model (for example
  Gemini `gemini-embedding-001`) for semantic duplicates.

## Lifecycle tools (#112)

A research connection can have a **role** (Connections → StockHarness research data → Research role). The role
decides what agents bound to that connection may do. It is enforced by the server, since the connection's token
proves the connection:

| Tool                                                                | Role     | What it does                                                                                                                                                                                   |
| ------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_theories(text)`                                             | all      | closest theories, any status                                                                                                                                                                   |
| `get_theory(theory_id)`                                             | all      | content, status, counts, plugin versions, evaluation summaries, recent debate                                                                                                                  |
| `submit_theory(...)`                                                | Theorist | a new theory for review, or a revised one (`theory_id` + changed fields)                                                                                                                       |
| `review_theory(theory_id, approve \| revise \| reject, reasoning)`  | Judge    | pre-code review                                                                                                                                                                                |
| `submit_code(theory_id, code)`                                      | Coder    | saves the next plugin version and dry-runs it (`test_strategy`). Failing code moves the theory to `code_error` with the attempts left; after the last one, the next call hands it to the Judge |
| `evaluate_strategy(theory_id, params)`                              | Coder    | runs the theory's plugin once per coding round, links the evaluation (a trial) and moves the theory to `post_review`                                                                           |
| `set_verdict(theory_id, successful \| failed \| revise, reasoning)` | Judge    | post-result review                                                                                                                                                                             |

Every write is a legal transition (#110) with its reasoning. The runtime tells research connections, and only
them, which agent, run and model is calling. That is recorded as the actor of each step of the debate.

## Success gates (#113)

Success is mechanical. `set_verdict(successful | failed)` applies the active gates version
(`GET/POST /api/research/gates`; defaults below) to the theory's latest exploration evaluation and its
holdout:

| Gate                                                | Default      |
| --------------------------------------------------- | ------------ |
| Exploration Sharpe                                  | ≥ 0.5        |
| Deflated Sharpe probability (all trials)            | ≥ 0.95       |
| Years with positive excess over the S&P 500         | ≥ 60%        |
| Holdout excess over the S&P 500 / holdout Sharpe    | > 0 / ≥ 0.3  |
| Trades / average names held                         | ≥ 100 / ≥ 10 |
| Alpha t-stat after factors (Newey-West)             | ≥ 2          |
| Blocking warnings (`empty_book`, `extreme_returns`) | none         |

- **Holdout:** when the exploration gates pass and the theory has no holdout yet, a `successful` request spends
  the theory's one holdout shot on that code version first (#105), then decides.
- **Downgrade only:** the Judge may downgrade a passing theory with reasons (at least a sentence) but can never
  upgrade a failing one. The verdict records the gates version, every gate's value and the mechanical result.
- **Versions:** a version is locked by its first verdict. New thresholds always make a new, active version, so
  verdicts stay comparable within a version. `Gates` objects export as `v<n>`. On import, identical thresholds are
  unchanged, locked versions import read-only, and a version number already taken by other thresholds gets the
  next number.
- **forward_only:** a theory whose data includes estimate or consensus snapshots (`analyst_estimates`,
  `price_target_consensus`, `grades_consensus`, `financial_scores`) has no history to backtest. It is tagged
  `forward_only`, its backtest evaluation is refused, and it goes to paper tracking (Layer 5). A proxy built
  from `analyst_events` can still be backtested as a separate theory.

## Seed skills (#114)

The research agents' skills are kept as source in `skills/` and generated into `deploy/config-io/seed/skills.yaml`
(`node --import tsx scripts/seed-skills.ts`), which imports on a fresh install:

| Skill                     | For                                                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strategy-library`        | 42 strategy cards by family (momentum, reversal, low risk, value, quality, capital actions, growth, earnings, analysts, insiders and congress, flows, macro, composites): signal, real fields, parameters, point-in-time traps, status |
| `write-a-strategy-plugin` | the plugin contract, worked examples (Layer 2 features, prices, Layer 1 read directly, fundamentals) and the submit / test / fix / evaluate loop                                                                                       |
| `read-the-catalog`        | the research data tools, what as_of means per collection, the caveats that change results                                                                                                                                              |
| `judge-checklist`         | pre-code review (testable, no lookahead, novel, plausible, backtestable) and post-result review (overfitting, factor in disguise, caveats)                                                                                             |

A unit test fails when the seed file is out of date, and `pipeline/tests/test_skill_examples.py` checks every
plugin example in the skills against the contract (and runs the ones the synthetic market can feed). With a
research role, only the Coder may test or evaluate code (every evaluation is a trial).
