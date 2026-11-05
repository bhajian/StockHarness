#!/usr/bin/env python3
"""Export and import StockHarness objects as YAML (apiVersion stockharness/v1).

Every object kind (dataset syncs, harnesses incl. their Python code steps, agents, skills) is exported by the
server's /api/objects endpoints: references are written by name, secrets and data rows are never included,
and the output is deterministic so git diffs stay minimal. See #152.

Usage:
    OH_BASE=https://openharness.faberiq.ai OH_EMAIL=you@example.com OH_PASSWORD=... \\
      python config_io.py export [--dir exports]
    OH_BASE=... OH_EMAIL=... OH_PASSWORD=... python config_io.py apply [--dir exports] [--dry-run] [--replace]

`apply` previews every file first and stops on any error (nothing is written). It is idempotent: objects are
matched by kind and name (update if present, else create). Connections, model providers and knowledge bases
referenced by name must already exist on the target (they hold secrets and are created per install).

Older export files (dataset-syncs.json, workflows.yaml with {"$ref": ...} references) still import.
No third-party Python packages are needed.
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

# One file per kind, in dependency order. Legacy files are used only when the new file is absent.
FILES = [
    ("Skill", "skills.yaml", []),
    ("Agent", "agents.yaml", []),
    ("Harness", "harnesses.yaml", ["workflows.yaml"]),
    ("DatasetSync", "dataset-syncs.yaml", ["dataset-syncs.json"]),
    ("Transform", "transforms.yaml", []),
    ("CatalogEntry", "catalog.yaml", []),
    ("Pipeline", "pipelines.yaml", []),
    ("StrategyPlugin", "strategy-plugins.yaml", []),
    ("Gates", "research-gates.yaml", []),
]
BASE = os.environ.get("OH_BASE", "https://openharness.faberiq.ai").rstrip("/")
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def _req(method, path, body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + "/api" + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Origin", BASE)
    try:
        with _opener.open(req, timeout=120) as r:
            payload = r.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        raise SystemExit(f"{method} {path} failed: HTTP {e.code} {detail}")
    if raw:
        return payload.decode()
    return json.loads(payload) if payload else None


def login():
    _req("POST", "/auth/login", {"email": os.environ["OH_EMAIL"], "password": os.environ["OH_PASSWORD"]})


def cmd_export(out_dir: Path, with_history: bool = False):
    out_dir.mkdir(parents=True, exist_ok=True)
    for kind, fname, legacy in FILES:
        query = {"kinds": kind, **({"history": "1"} if with_history else {})}
        text = _req("GET", "/objects/export?" + urllib.parse.urlencode(query), raw=True)
        (out_dir / fname).write_text(text)
        count = text.count("\nkind: ") + (1 if text.startswith("kind: ") else 0)
        print(f"exported {count:>3} {kind:<12} -> {out_dir / fname}")
        for old in legacy:  # superseded by the new file
            if (out_dir / old).exists():
                (out_dir / old).unlink()
                print(f"removed legacy {out_dir / old}")


def _files(out_dir: Path):
    for kind, fname, legacy in FILES:
        for name in [fname, *legacy]:
            path = out_dir / name
            if path.exists():
                # New-format files are self-describing; legacy files are bare lists of this kind.
                yield kind, path, (None if name == fname else kind)
                break


def _print_plan(path: Path, plan: dict):
    changes = [i for i in plan["items"] if i["action"] != "unchanged"]
    print(f"{path.name}: {len(plan['items'])} objects, {len(changes)} changes, {len(plan['errors'])} errors")
    for i in changes:
        print(f"  [{i['action']}] {i['kind']}: {i['name']}")
    for e in plan["errors"]:
        print(f"  ERROR {e.get('kind', '')} {e.get('name', '')}: {e['message']}")


def cmd_apply(out_dir: Path, dry_run: bool, replace: bool):
    mode = "replace" if replace else "merge"
    work = []
    for kind, path, legacy_kind in _files(out_dir):
        body = {"yaml": path.read_text(), "mode": mode, "dryRun": True}
        if legacy_kind:
            body["legacyKind"] = legacy_kind
        result = _req("POST", "/objects/import", body)
        _print_plan(path, result["plan"])
        work.append((path, body, result["plan"]))
    if any(p["errors"] for _, _, p in work):
        sys.exit("Errors found: nothing was applied.")
    if dry_run:
        return
    for path, body, _ in work:
        result = _req("POST", "/objects/import", {**body, "dryRun": False})
        if not result.get("applied"):
            sys.exit(f"{path.name}: stopped: {result.get('error') or result['plan']['errors']}")
        print(f"{path.name}: applied")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["export", "apply"])
    ap.add_argument("--dir", default=str(Path(__file__).parent / "exports"))
    ap.add_argument("--dry-run", action="store_true", help="preview only")
    ap.add_argument("--replace", action="store_true", help="also remove objects of each kind not in its file")
    ap.add_argument("--with-history", action="store_true",
                    help="export: include every transform version (an import into an empty workspace restores them)")
    args = ap.parse_args()
    login()
    if args.command == "export":
        cmd_export(Path(args.dir), args.with_history)
    else:
        cmd_apply(Path(args.dir), args.dry_run, args.replace)


if __name__ == "__main__":
    main()
