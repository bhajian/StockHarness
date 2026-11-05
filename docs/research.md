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
