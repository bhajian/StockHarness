# Config export / import

Every StockHarness object (dataset syncs, harnesses including their Python code steps, agents and skills)
exports and imports as **YAML** (`apiVersion: stockharness/v1`, `kind`, `metadata`, `spec`). This is the
"everything is a YAML object" policy (#152). The same format is used by **Settings → Configuration (YAML)**,
the Export/Import buttons on the Harnesses, Skills and Datasets pages, and this CLI.

## What's in a file

- One `stockharness/v1` document per object (multi-document YAML), in kind order, then sorted by name.
- **References by name:** `{ $ref: { type: providers, name: Main LLM } }`, and `connection: FMP` for syncs.
  Connections, model providers and knowledge bases are never exported (they hold secrets). Create them on
  the target first, with the same names.
- **No secrets** (only secret _names_, e.g. a code step's `secrets: [FMP_API_KEY]`), and **no server state**
  (ids, cursors, timestamps, run state).
- **Code verbatim:** Python code steps, prompts and skill instructions are YAML block scalars. A round trip
  preserves them byte-for-byte.

## Files (committed under `exports/`)

`skills.yaml`, `agents.yaml`, `harnesses.yaml`, `dataset-syncs.yaml`. Older files (`workflows.yaml`,
`dataset-syncs.json`) still import; `export` replaces them with the new files.

## Usage

```bash
export OH_BASE=https://openharness.faberiq.ai OH_EMAIL=you@example.com OH_PASSWORD=...
python3 config_io.py export                # write exports/ (one file per kind)
python3 config_io.py export --with-history # also every earlier transform version (restored by an import
                                           # that creates the transform, so diff and restore keep working)
python3 config_io.py apply --dry-run       # preview every file; nothing is written
python3 config_io.py apply                 # merge: create or update by kind + name
python3 config_io.py apply --replace       # also remove objects of each kind that are not in its file
```

`apply` previews all files first and writes nothing if any file has an error. Objects still referenced
elsewhere are never removed. No third-party Python packages are needed.

## Restore onto a fresh install

1. Install, then create the connections (e.g. `FMP`, the built-in MongoDB), model providers and knowledge
   bases, using the names the files reference.
2. Run `python3 config_io.py apply --dry-run`, fix any reported missing references, then
   `python3 config_io.py apply`.

Data rows are not part of this; back them up with MongoDB.

## Automatic backup to git (#149)

The app keeps `exports/` current by itself:

- Every `CONFIG_BACKUP_INTERVAL_MINUTES` (default 5), plus a forced daily run, it renders the four files
  with the same renderer as the export.
- When they changed, it commits them to the **`config-backup`** branch and opens or updates one
  **"Config snapshot"** PR into `main`. Merge that PR to make `main` the recovery point. It's never
  auto-merged.
- Only the export files are touched. There are no empty commits, and legacy files are deleted.
- Status appears in **Settings → Configuration (YAML) → Backup to git**: last check, last change, last
  commit, the PR, and whether `main` is in sync. The page also has **Back up now**.

Setup:

1. Create a **fine-grained GitHub token** for `bhajian/StockHarness` only, with _Contents: read and write_
   and _Pull requests: read and write_.
2. Store it in the cluster (never in git):
   ```bash
   kubectl -n openharness create secret generic openharness-config-backup \
     --from-literal=CONFIG_BACKUP_GITHUB_TOKEN=github_pat_...
   kubectl -n openharness rollout restart deployment/app
   ```
3. `CONFIG_BACKUP_REPO` is set in the AWS overlay. Optional settings: `CONFIG_BACKUP_BRANCH`,
   `CONFIG_BACKUP_BASE`, `CONFIG_BACKUP_PATH`, `CONFIG_BACKUP_OWNER_ID` (the default is the first
   administrator's workspace), `CONFIG_BACKUP_INTERVAL_MINUTES`.

Without the token the backup runs in detect-only mode: it records changes but pushes nothing.

## Restoring on a new install

The committed exports (refreshed from the live workspace in #200) import into an empty workspace with no
errors once the objects that hold secrets exist, because those are never exported:

- connections **MongoDB** (the built-in one), **FMP** (with the `apikey` in its URL) and **Parallel**;
- model providers **Gemini-flash-3-8** and **Gemini-flash-vision**.

Then run `python3 config_io.py apply --dry-run` and `apply`. Syncs, transforms (with their Python code), the
skill and the harnesses are created; data is not included, so run the syncs (or a backfill) and then the
transforms to rebuild the collections.
