"""Where the evaluator's rows come from: MongoDB in the executor, or in-memory rows in tests.

Both answer `find(collection, filter, fields)` with a list of dicts. `MemorySource` understands the small
filter subset the reader and plugins use ($and $or $in $nin $eq $ne $gt $gte $lt $lte $exists $type).
"""
from __future__ import annotations

from datetime import datetime

_ORDER = {"$gt": lambda a, b: a > b, "$gte": lambda a, b: a >= b, "$lt": lambda a, b: a < b, "$lte": lambda a, b: a <= b}


def _comparable(a, b) -> bool:
    return (isinstance(a, str) and isinstance(b, str)) or (
        isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool)
    ) or (isinstance(a, datetime) and isinstance(b, datetime))


def _match_value(value, cond) -> bool:
    if not isinstance(cond, dict) or not any(k.startswith("$") for k in cond):
        return value == cond or (isinstance(value, list) and cond in value)
    for op, arg in cond.items():
        if op == "$eq" and value != arg:
            return False
        if op == "$ne" and value == arg:
            return False
        if op == "$in" and value not in arg:
            return False
        if op == "$nin" and value in arg:
            return False
        if op == "$exists" and (value is not None) != bool(arg):
            return False
        if op == "$type" and not (arg == "date" and isinstance(value, datetime)):
            return False
        if op in _ORDER and not (value is not None and _comparable(value, arg) and _ORDER[op](value, arg)):
            return False
        if op not in _ORDER and op not in ("$eq", "$ne", "$in", "$nin", "$exists", "$type"):
            raise ValueError(f"MemorySource does not support {op}")
    return True


def matches(row: dict, flt: dict | None) -> bool:
    for k, cond in (flt or {}).items():
        if k == "$and":
            if not all(matches(row, f) for f in cond):
                return False
        elif k == "$or":
            if not any(matches(row, f) for f in cond):
                return False
        elif "." in k:  # a path into an array of sub-documents, e.g. identifiers.value
            head, rest = k.split(".", 1)
            items = row.get(head) if isinstance(row.get(head), list) else [row.get(head)]
            if not any(isinstance(i, dict) and matches(i, {rest: cond}) for i in items):
                return False
        elif not _match_value(row.get(k), cond):
            return False
    return True


class MemorySource:
    def __init__(self, collections: dict[str, list[dict]]):
        self.collections = collections

    def find(self, collection: str, flt: dict | None = None, fields: list[str] | None = None) -> list[dict]:
        out = []
        for r in self.collections.get(collection, []):
            if matches(r, flt):
                out.append({k: r[k] for k in fields if k in r} if fields else dict(r))  # like a MongoDB projection
        return out

    def has_field(self, collection: str, field: str) -> bool:
        return any(field in r for r in self.collections.get(collection, [])[:50])

    def sample_fields(self, collection: str) -> list[str]:
        rows = self.collections.get(collection, [])
        return sorted(rows[0]) if rows else []


class MongoSource:
    def __init__(self, db):
        self._db = db
        self._fields: dict[tuple[str, str], bool] = {}

    def find(self, collection: str, flt: dict | None = None, fields: list[str] | None = None) -> list[dict]:
        proj = {f: 1 for f in fields} if fields else {}
        proj["_id"] = 0
        return list(self._db[collection].find(flt or {}, proj))

    def sample_fields(self, collection: str) -> list[str]:
        row = self._db[collection].find_one({}, {"_id": 0})
        return sorted(row) if row else []

    def has_field(self, collection: str, field: str) -> bool:
        key = (collection, field)
        if key not in self._fields:
            self._fields[key] = self._db[collection].find_one({field: {"$exists": True}}, {"_id": 1}) is not None
        return self._fields[key]
