# Seed skills

Agent skills that ship with StockHarness, kept as source in the repo. Each file is a skill: front matter
with `name` and `description` (the one-line "when to use"), then the instructions.

| Skill                                                      | For                                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`strategy-library.md`](strategy-library.md)               | 42 strategy cards (S01–S42) for the research agents: signals, real fields, parameters, point-in-time rules |
| [`write-a-strategy-plugin.md`](write-a-strategy-plugin.md) | The plugin contract, worked examples and the submit / test / fix / evaluate loop (Coder)                   |
| [`read-the-catalog.md`](read-the-catalog.md)               | The research data tools, what as_of means per collection, and the caveats that change results              |
| [`judge-checklist.md`](judge-checklist.md)                 | Pre-code and post-result review: testability, lookahead, novelty, overfitting, factor in disguise (Judge)  |

**Install on a fresh install:** `deploy/config-io/seed/skills.yaml` holds every seed skill as a `stockharness/v1`
Skill object; import it from Settings → Configuration (or `config_io.py`). It is generated from these files: run
`node --import tsx scripts/seed-skills.ts` after editing one (a unit test fails when it is out of date). Plugin
examples in the skills are checked by `pipeline/tests/test_skill_examples.py`.

**Seed skills vs the backup.** `deploy/config-io/exports/skills.yaml` is the **backup of what is live** in
the workspace (#149), written automatically. A seed skill shows up there only after it has been imported.
To install one, use **Skills → New skill** and paste it, or import it as YAML:

```yaml
apiVersion: stockharness/v1
kind: Skill
metadata: { name: strategy-library }
spec:
  description: <the description line from the file>
  instructions: |
    <the file's content>
```
