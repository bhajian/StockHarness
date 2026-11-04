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

Data rows are not part of this; back them up with MongoDB. Keeping `exports/` current automatically is #149.
