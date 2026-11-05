"""Executor entrypoint for evaluations (#104) and plugin tests (#153). Trusted code: the API submits

    from pipeline.strategy.job import main
    main()

with oh.params = {action, code, params, policies, readable_end?, plugin_ref?, config?}; for action "simulate"
(#124) {ideas: [{id, ref, code, plugin_ref}], params, policies, readable_end?, config?, simulation_id}, which writes
the ledger (sim_orders, sim_trades, sim_portfolio_daily, sim_positions) to the workspace database. The database
handle stays here; the plugin only gets ctx. Failures come back as a structured error with the plugin's own line numbers.
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
    if isinstance(exc, (KeyError, AttributeError)) and getattr(exc, "columns_seen", None):
        out["hint"] = "a name the code used is not a column; the collections read so far have these columns"
        out["columns"] = exc.columns_seen
    if isinstance(exc, SyntaxError) and exc.lineno:
        out["frames"] = [{"line": exc.lineno, "function": "<module>", "code": exc.text.strip() if exc.text else ""}]
    return out


def run(params: dict, source, db=None) -> dict:
    from . import engine

    action = params.get("action", "evaluate")
    code = params.get("code") or ""
    try:
        if action == "simulate":
            from .simulate import ListSink, MongoSink, simulate

            sink = MongoSink(db, params["simulation_id"]) if db is not None else ListSink()
            result = simulate(params["ideas"], source=source, policies=params["policies"], params=params["params"],
                              config=params.get("config"), readable_end=params.get("readable_end"), sink=sink)
            return {"ok": True, "simulation": result}
        if action == "evaluate":
            record = engine.evaluate(code, source=source, policies=params["policies"], params=params["params"],
                                     config=params.get("config"), readable_end=params.get("readable_end"),
                                     plugin_ref=params.get("plugin_ref"))
            return {"ok": True, "record": record}
        if action == "test":
            from .testing import test_plugin

            return {"ok": True, "test": test_plugin(code, source=source, policies=params["policies"],
                                                   params=params.get("params"), readable_end=params.get("readable_end"))}
        raise ValueError(f"unknown action {action}")
    except Exception as exc:  # noqa: BLE001 - reported to the caller as a structured error
        if action == "simulate":  # the frames are the failing idea's plugin lines
            failing = getattr(exc, "idea_id", None)
            code = next((i["code"] for i in params.get("ideas") or [] if i["id"] == failing), "")
            return {"ok": False, "error": {**plugin_error(exc, code), **({"idea_id": failing} if failing else {})}}
        return {"ok": False, "error": plugin_error(exc, code)}


def main() -> None:
    import oh
    from .sources import MongoSource

    db = oh._db()
    os.environ.pop("MONGODB_URI", None)  # the plugin never needs it
    oh.result(run(dict(oh.params), MongoSource(db), db))
