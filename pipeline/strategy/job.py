"""Executor entrypoint for evaluations (#104) and plugin tests (#153). Trusted code: the API submits

    from pipeline.strategy.job import main
    main()

with oh.params = {action, code, params, policies, readable_end?, plugin_ref?, config?}. The database handle stays
here; the plugin only gets ctx. Failures come back as a structured error with the plugin's own line numbers.
"""
from __future__ import annotations

import os
import traceback

from .contract import PLUGIN_FILENAME, PluginError


def plugin_error(exc: BaseException, code: str | None = None) -> dict:
    """The exception type and message, and the traceback trimmed to the plugin's frames (with their lines)."""
    lines = (code or "").splitlines()
    frames = [
        {"line": f.lineno, "function": f.name, "code": (lines[f.lineno - 1].strip() if f.lineno and f.lineno <= len(lines) else f.line)}
        for f in traceback.extract_tb(exc.__traceback__)
        if f.filename == PLUGIN_FILENAME
    ]
    out = {"type": type(exc).__name__, "message": str(exc)[:2000], "frames": frames[-8:]}
    if isinstance(exc, PluginError):
        out["problems"] = exc.problems
    if isinstance(exc, SyntaxError) and exc.lineno:
        out["frames"] = [{"line": exc.lineno, "function": "<module>", "code": exc.text.strip() if exc.text else ""}]
    return out


def run(params: dict, source) -> dict:
    from . import engine

    action = params.get("action", "evaluate")
    code = params["code"]
    try:
        if action == "evaluate":
            record = engine.evaluate(code, source=source, policies=params["policies"], params=params["params"],
                                     config=params.get("config"), readable_end=params.get("readable_end"),
                                     plugin_ref=params.get("plugin_ref"))
            return {"ok": True, "record": record}
        raise ValueError(f"unknown action {action}")
    except Exception as exc:  # noqa: BLE001 - reported to the caller as a structured error
        return {"ok": False, "error": plugin_error(exc, code)}


def main() -> None:
    import oh
    from .sources import MongoSource

    db = oh._db()
    os.environ.pop("MONGODB_URI", None)  # the plugin never needs it
    oh.result(run(dict(oh.params), MongoSource(db)))
