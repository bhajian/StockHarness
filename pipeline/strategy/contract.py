"""The strategy plugin contract (#103).

A plugin is a short Python module that agents write and the trusted evaluator runs:

    import numpy as np

    META = {"side": "long", "horizon_days": 40, "rebalance": "weekly", "top_n": 30}

    def universe(ctx) -> list[str]:          # optional: security_ids to consider on ctx.date
        ...

    def signal(ctx) -> dict[str, float]:     # required: a score per security_id on ctx.date (higher = better)
        f = ctx.read_df("features_ranked", columns=["security_id", "mom_12_1_pct"], lookback_days=5)
        last = f.sort_values("as_of_date").groupby("security_id").tail(1)
        return dict(zip(last.security_id, last.mom_12_1_pct))

The plugin only sees data through `ctx.read_df`, which applies the point-in-time rule of each collection.
`validate(source)` checks a plugin statically; `load(source)` validates, then executes it with restricted
builtins and an import allow-list. This keeps honest mistakes and casual bypasses out; the hard boundary is the
executor container, which reaches only this workspace's database.
"""
from __future__ import annotations

import ast
import builtins
import hashlib
from types import SimpleNamespace

PLUGIN_FILENAME = "strategy.py"
SIDES = ("long", "short", "long_short")
REBALANCES = ("daily", "weekly", "monthly")
META_KEYS = {"side", "horizon_days", "rebalance", "top_n", "description", "params"}
ALLOWED_MODULES = {
    "math", "statistics", "numpy", "pandas", "datetime", "collections", "itertools", "functools", "typing",
    "dataclasses", "random", "re", "bisect", "heapq", "operator", "__future__",
}
FORBIDDEN_NAMES = {
    "eval", "exec", "compile", "open", "__import__", "globals", "locals", "vars", "getattr", "setattr",
    "delattr", "input", "breakpoint", "exit", "quit", "help", "memoryview", "__builtins__", "__loader__",
    "__spec__",
}
# File, network and pickle IO on numpy / pandas objects.
FORBIDDEN_ATTRS = {
    "to_csv", "to_parquet", "to_pickle", "to_sql", "to_excel", "to_json", "to_hdf", "to_feather", "to_html",
    "to_latex", "to_markdown", "to_clipboard", "to_stata", "to_orc", "to_xml", "tofile", "save", "savez",
    "savez_compressed", "savetxt", "load", "loadtxt", "fromfile", "genfromtxt", "memmap", "DataSource",
}
_SAFE_BUILTINS = {
    n: getattr(builtins, n)
    for n in (
        "abs all any bool dict divmod enumerate filter float frozenset int isinstance issubclass iter len list "
        "map max min next pow print range repr reversed round set slice sorted str sum tuple zip hash "
        "ArithmeticError AssertionError Exception IndexError KeyError LookupError NotImplementedError "
        "OverflowError RuntimeError StopIteration TypeError ValueError ZeroDivisionError True False None"
    ).split()
    if hasattr(builtins, n)
}


def code_hash(source: str) -> str:
    """`sha256:<hex>` of the code, as stored on StrategyPlugin objects."""
    return "sha256:" + hashlib.sha256(source.encode("utf-8")).hexdigest()


class PluginError(ValueError):
    """A plugin that breaks the contract. `problems` lists every issue with its line number."""

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


def _top_module(name: str) -> str:
    return (name or "").split(".")[0]


def validate_meta(meta) -> list[str]:
    if not isinstance(meta, dict):
        return ["META must be a dict"]
    problems = []
    unknown = set(meta) - META_KEYS
    if unknown:
        problems.append(f"META has unknown keys: {', '.join(sorted(unknown))} (allowed: {', '.join(sorted(META_KEYS))})")
    if meta.get("side") not in SIDES:
        problems.append(f"META.side must be one of {', '.join(SIDES)}")
    if meta.get("rebalance") not in REBALANCES:
        problems.append(f"META.rebalance must be one of {', '.join(REBALANCES)}")
    for k in ("horizon_days", "top_n"):
        v = meta.get(k)
        if not isinstance(v, int) or isinstance(v, bool) or v < 1:
            problems.append(f"META.{k} must be a positive integer")
    if "params" in meta and not isinstance(meta["params"], dict):
        problems.append("META.params must be a dict of default parameters")
    return problems


def validate(source: str) -> list[str]:
    """Every contract problem in `source` (empty when valid). Each message names its line."""
    try:
        tree = ast.parse(source, filename=PLUGIN_FILENAME)
    except SyntaxError as e:
        return [f"line {e.lineno}: syntax error: {e.msg}"]
    problems: list[str] = []
    funcs = {n.name: n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    if "signal" not in funcs:
        problems.append("the plugin must define signal(ctx)")
    for name in ("signal", "universe"):
        f = funcs.get(name)
        if f is not None and (isinstance(f, ast.AsyncFunctionDef) or len(f.args.args) != 1):
            problems.append(f"line {f.lineno}: {name} must be a plain function taking one argument (ctx)")
    meta = [n for n in tree.body if isinstance(n, ast.Assign) and any(getattr(t, "id", None) == "META" for t in n.targets)]
    if not meta:
        problems.append("the plugin must define META = {...}")
    else:
        try:
            problems += [f"line {meta[-1].lineno}: {p}" for p in validate_meta(ast.literal_eval(meta[-1].value))]
        except ValueError:
            problems.append(f"line {meta[-1].lineno}: META must be a literal dict (no expressions)")
    for node in ast.walk(tree):
        line = getattr(node, "lineno", "?")
        if isinstance(node, ast.Import):
            for a in node.names:
                if _top_module(a.name) not in ALLOWED_MODULES:
                    problems.append(f"line {line}: import {a.name} is not allowed (allowed: {', '.join(sorted(ALLOWED_MODULES - {'__future__'}))})")
        elif isinstance(node, ast.ImportFrom):
            if node.level or _top_module(node.module) not in ALLOWED_MODULES:
                problems.append(f"line {line}: from {node.module or '.'} import is not allowed")
        elif isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            problems.append(f"line {line}: {node.id} is not allowed in a plugin")
        elif isinstance(node, ast.Attribute):
            a = node.attr
            if a.startswith("_") or a in FORBIDDEN_ATTRS or (a.startswith("read_") and a != "read_df"):
                problems.append(f"line {line}: .{a} is not allowed (private attributes and IO; read data only through ctx.read_df)")
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            problems.append(f"line {line}: global/nonlocal state is not allowed")
    return problems


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level or _top_module(name) not in ALLOWED_MODULES:
        raise ImportError(f"import {name} is not allowed in a plugin")
    return __import__(name, globals, locals, fromlist, level)


def load(source: str) -> SimpleNamespace:
    """Validate and execute a plugin; returns signal, universe (or None), META and the code hash."""
    problems = validate(source)
    if problems:
        raise PluginError(problems)
    env = {"__builtins__": {**_SAFE_BUILTINS, "__import__": _guarded_import}, "__name__": "strategy"}
    exec(compile(source, PLUGIN_FILENAME, "exec"), env)  # noqa: S102 - validated plugin, restricted builtins
    meta = dict(env["META"])
    return SimpleNamespace(
        signal=env["signal"],
        universe=env.get("universe") if callable(env.get("universe")) else None,
        META=meta,
        params={**(meta.get("params") or {})},
        hash=code_hash(source),
    )
