"""The signal tape (#467, stage 1): what a strategy asked for, before anything is executed or scored.

Built from the evaluator's signal walk (`engine.plan_books`), which reads data only through the point-in-time reader
and never sees a return the strategy earns. For every rebalance: the signal date, the session the book is executed at
(signal date + lag), a hash of the eligible names, and every name in the book with its score, rank and target weight.
An empty book (sell everything) is a rebalance with no rows.

The tape is canonical JSON with a sha256 over it, so two runs with the same code, parameters and data produce the same
hash. The independent executor (`executor.py`) reads nothing else from the evaluator: this module is the schema the
two stages share.
"""
from __future__ import annotations

import hashlib
import json

SCHEMA = 1


def _sha(obj) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def build(plan: dict, sessions: list[str], lag: int) -> dict:
    """The tape of a plan: `plan` is `plan_books` output; `sessions` the evaluated sessions from the first execution."""
    rebalances, rows = [], []
    for exec_date in sorted(plan["targets"]):
        signal_date, eligible = plan["eligible_at"][exec_date]
        rebalances.append({"signal_date": signal_date, "exec_date": exec_date, "eligible": len(eligible),
                           "eligible_hash": _sha(sorted(eligible))})
        sig = plan["signals"].get(exec_date, {})
        for s, w in sorted(plan["targets"][exec_date].items()):
            score, rank, of = sig.get(s, (None, None, None))
            rows.append({"signal_date": signal_date, "exec_date": exec_date, "security_id": s,
                         "weight": float(w), "score": score, "rank": rank, "of": of})
    tape = {"schema": SCHEMA, "lag": int(lag), "sessions": list(sessions), "rebalances": rebalances, "rows": rows}
    tape["hash"] = _sha({k: v for k, v in tape.items()})
    return tape


def eligible_sets(plan: dict) -> dict[str, set[str]]:
    """exec date -> the names eligible on its signal date (for the executor's rule checks)."""
    return {d: set(names) for d, (_, names) in plan["eligible_at"].items()}


def summary(tape: dict) -> dict:
    """What the evaluation record keeps of the tape: its hash and size (the tape itself is reproducible)."""
    return {"schema": tape["schema"], "hash": tape["hash"], "rebalances": len(tape["rebalances"]),
            "rows": len(tape["rows"]), "lag": tape["lag"]}
