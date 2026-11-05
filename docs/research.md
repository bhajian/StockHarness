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
