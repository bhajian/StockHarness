# Seed skills

Agent skills that ship with StockHarness, kept as source in the repo. Each file is a skill: front matter
with `name` and `description` (the one-line "when to use"), then the instructions.

| Skill                                        | For                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`strategy-library.md`](strategy-library.md) | 42 strategy cards (S01–S42) for the research agents: signals, real fields, parameters, point-in-time rules |

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
