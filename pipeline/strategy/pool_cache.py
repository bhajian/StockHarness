"""A read cache for many runs over subsets of one pool of names (#325: a subset search runs the strategy on the
chosen names and on dozens of random sets of the same size).

Each query that selects ``security_id $in [...]`` (at the top level or inside ``$and``) within the pool is sent
once for the whole pool and the rows are filtered in memory, so every run still sees exactly its own names'
rows; any other query goes to the source unchanged.
"""
from __future__ import annotations

import json


class PoolCache:
    def __init__(self, source, pool: list[str]):
        self.source = source
        self.pool = sorted(set(pool))
        self._pool_set = set(self.pool)
        self._memo: dict[str, list[dict]] = {}
        self.stats = {"hits": 0, "loads": 0, "passthrough": 0}

    def __getattr__(self, name):  # has_field, sample_fields, … go to the source
        return getattr(self.source, name)

    def _ids_clause(self, query: dict):
        """(the ids asked for, the query with the pool instead) or None when the query is not by ids."""
        def swap(q):
            ids = (q.get("security_id") or {}).get("$in") if isinstance(q.get("security_id"), dict) else None
            if isinstance(ids, list) and set(ids) <= self._pool_set and len(q["security_id"]) == 1:
                return ids, {**q, "security_id": {"$in": self.pool}}
            return None
        if not isinstance(query, dict):
            return None
        top = swap(query)
        if top:
            return top
        parts = query.get("$and")
        if isinstance(parts, list) and len(query) == 1:
            for i, part in enumerate(parts):
                hit = swap(part) if isinstance(part, dict) else None
                if hit:
                    return hit[0], {"$and": [*parts[:i], hit[1], *parts[i + 1:]]}
        return None

    def find(self, collection, query=None, fields=None):
        hit = self._ids_clause(query or {})
        if not hit:
            self.stats["passthrough"] += 1
            return self.source.find(collection, query, fields)
        ids, pooled = hit
        want = list(fields) if fields else None
        if want is not None and "security_id" not in want:
            want = [*want, "security_id"]
        key = json.dumps([collection, pooled, want], sort_keys=True, default=str)
        if key not in self._memo:
            self.stats["loads"] += 1
            self._memo[key] = list(self.source.find(collection, pooled, want))
        else:
            self.stats["hits"] += 1
        keep = set(ids)
        drop = fields is not None and "security_id" not in fields
        out = []
        for r in self._memo[key]:
            if r.get("security_id") in keep:
                row = dict(r)
                if drop:
                    row.pop("security_id", None)
                out.append(row)
        return out
