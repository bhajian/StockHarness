"""Helpers available to code that runs in the OpenHarness Python executor.

    import oh
    rows = oh.read("prices", {"ticker": "AAPL"}, limit=5000)   # list of dicts from a collection
    frame = oh.read_df("prices", sort=[("date", 1)])             # the same as a pandas DataFrame
    oh.write("signals", records)                                 # append documents
    oh.write_df("features", frame, mode="replace")               # replace a collection's content
    oh.result({"rows": len(rows)})                               # what the agent or workflow receives
    oh.params["window"]                                          # parameters the caller passed in

Transforms (Layer 2, #91):

    w = oh.window                                   # start, end, lookback_start (None outside a transform)
    bars = oh.read_df("eod_prices", {"date": {"$gte": w.lookback_start}}, columns=["symbol", "date", "close"])
    oh.output("prices_daily").upsert_df(rows)       # a declared output: its key and write mode apply
    oh.upsert("my_table", records, key=["security_id", "date"])   # idempotent; unchanged rows are skipped
    oh.dq("stale_price", "warn", security_id="SEC_1", date="2026-11-03")   # idempotent data-quality issue
    oh.describe("prices_daily", fields={"adj_close": "Adjusted close, USD"}, grain="security × day")
    oh.pit.eod_known_at("2026-11-03"); oh.pit.as_of(known_at)            # point-in-time helpers
    con = oh.duckdb(bars=bars, actions=("corporate_actions", {}))        # SQL joins over frames/collections

Collections are those of the calling workspace: the connection string the executor received only reaches
that database. Writes go through the trusted runner; the code never needs credentials of its own.
"""

from __future__ import annotations

import json
import os
from typing import Any, Iterable

__all__ = [
    "params", "read", "read_df", "write", "write_df", "result", "log", "collections",
    "window", "output", "upsert", "upsert_df", "dq", "describe", "pit", "duckdb", "aggregate",
]

params: dict[str, Any] = json.loads(os.environ.get("OH_PARAMS") or "{}")
_RESULT_PATH = os.environ.get("OH_RESULT_PATH", "/work/.oh-result.json")
_DESCRIBE_PATH = os.environ.get("OH_DESCRIBE_PATH", "/work/.oh-describe.json")
_STATS_PATH = os.environ.get("OH_STATS_PATH", "")
# Per-collection counters reported to the runner (#90): rows read, written, unchanged, dq issues.
_stats: dict[str, dict[str, int]] = {}


def _count(collection: str, key: str, n: int) -> None:
    if n:
        c = _stats.setdefault(collection, {})
        c[key] = c.get(key, 0) + int(n)
_client = None
# Declared outputs of the running transform (set by the transform runner, #90). When present, writes to any
# other collection are refused, so a transform can only write what it declares.
_OUTPUTS: dict[str, dict] = {o["collection"]: o for o in json.loads(os.environ.get("OH_OUTPUTS") or "[]")}
_DQ_COLLECTION = os.environ.get("OH_DQ_COLLECTION") or (next(iter(_OUTPUTS)) if _OUTPUTS else "")
# Preview runs (#95): writes are captured (first rows + checks per output) instead of written, dq issues are
# counted but not stored, and reads of symbol-keyed collections are narrowed to a sample of symbols.
_PREVIEW = os.environ.get("OH_PREVIEW") == "1"
_PREVIEW_PATH = os.environ.get("OH_PREVIEW_PATH", "")
_SAMPLE: list[str] = json.loads(os.environ.get("OH_SAMPLE_SYMBOLS") or "[]")
_PREVIEW_ROWS = 100
_preview: dict[str, dict] = {}
_has_symbol: dict[str, bool] = {}


def _db():
    global _client
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        raise RuntimeError("This job has no MongoDB collections: start it from a workspace with a MongoDB connection")
    if _client is None:
        from pymongo import MongoClient

        _client = MongoClient(uri, serverSelectionTimeoutMS=10000)
    return _client.get_default_database()


def collections() -> list[str]:
    """Names of the collections in the workspace database."""
    return sorted(n for n in _db().list_collection_names() if not n.startswith("system."))


def _guard(collection: str) -> None:
    if _OUTPUTS and collection not in _OUTPUTS:
        raise PermissionError(
            f"{collection} is not a declared output of this transform (outputs: {', '.join(_OUTPUTS)})"
        )


def _sampled(collection: str, filter: dict | None) -> dict:
    """In a preview, narrow reads of collections that have a symbol field to the sample symbols."""
    filter = filter or {}
    if not (_PREVIEW and _SAMPLE) or "symbol" in filter:
        return filter
    if collection not in _has_symbol:
        _has_symbol[collection] = _db()[collection].find_one({"symbol": {"$exists": True}}, {"_id": 1}) is not None
    if not _has_symbol[collection]:
        return filter
    narrowed = {"symbol": {"$in": _SAMPLE}}
    return {"$and": [filter, narrowed]} if filter else narrowed


def _capture(collection: str, rows: list[dict], key: list[str] | None, known_at_field: str | None) -> dict:
    """Preview: record rows and checks for an output instead of writing (#95)."""
    p = _preview.setdefault(collection, {"count": 0, "rows": [], "dup_keys": 0, "missing_key": 0,
                                         "missing_known_at": 0, "fields": {}, "_seen": set()})
    for r in rows:
        r = {k: v for k, v in r.items() if k not in ("_id", "_hash")}
        p["count"] += 1
        if key:
            ident = tuple(r.get(k) for k in key)
            if any(v is None for v in ident):
                p["missing_key"] += 1
            elif ident in p["_seen"]:
                p["dup_keys"] += 1
            else:
                p["_seen"].add(ident)
        if known_at_field and r.get(known_at_field) in (None, ""):
            p["missing_known_at"] += 1
        for k, v in r.items():
            f = p["fields"].setdefault(k, {"nonnull": 0, "type": None})
            if v is not None:
                f["nonnull"] += 1
                f["type"] = f["type"] or type(v).__name__
        if len(p["rows"]) < _PREVIEW_ROWS:
            p["rows"].append({k: (v if not isinstance(v, str) or len(v) <= 300 else v[:300] + "…") for k, v in r.items()})
    _count(collection, "previewed", len(rows))
    return {"written": 0, "unchanged": 0, "previewed": len(rows)}


def _finite(v):
    """JSON has no NaN/Infinity (e.g. pct_change after a zero close): show them as strings in the preview."""
    import math

    if isinstance(v, float) and not math.isfinite(v):
        return str(v)
    if isinstance(v, dict):
        return {k: _finite(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_finite(x) for x in v]
    return v


def _write_preview() -> None:
    if not (_PREVIEW and _PREVIEW_PATH):
        return
    out = {}
    for c, p in _preview.items():
        out[c] = {k: v for k, v in p.items() if k != "_seen"}
        # A field missing from a row counts as null for that row.
        out[c]["fields"] = {
            k: {"type": f["type"], "null_pct": round(100 * (1 - f["nonnull"] / p["count"]), 1) if p["count"] else 0}
            for k, f in p["fields"].items()
        }
    out = _finite(out)
    body = json.dumps(out, default=str, allow_nan=False)
    for keep in (20, 5, 0):  # keep the job report (stdout + result + meta) well under the API's 1 MB body limit
        if len(body) <= 400_000:
            break
        for p in out.values():
            p["rows"] = p["rows"][:keep]
            p["truncated"] = True
        body = json.dumps(out, default=str, allow_nan=False)
    with open(_PREVIEW_PATH, "w", encoding="utf-8") as handle:
        handle.write(body)


def read(collection: str, filter: dict | None = None, *, limit: int | None = None, sort: list | None = None,
         projection: dict | None = None, columns: list[str] | None = None) -> list[dict]:
    """Documents of a collection as plain dicts (``_id`` is kept as a string). ``columns`` limits the fields."""
    if columns and projection is None:
        projection = {c: 1 for c in columns}
        projection.setdefault("_id", 0)
    cursor = _db()[collection].find(_sampled(collection, filter), projection)
    if sort:
        cursor = cursor.sort(sort)
    if limit:
        cursor = cursor.limit(int(limit))
    rows = []
    for doc in cursor:
        if "_id" in doc:
            doc["_id"] = str(doc["_id"])
        rows.append(doc)
    _count(collection, "read", len(rows))
    return rows


def aggregate(collection: str, pipeline: list[dict]) -> list[dict]:
    """Run a read-only aggregation (e.g. the first date each symbol appears). Writing stages are refused."""
    if any(("$out" in st or "$merge" in st) for st in pipeline):
        raise PermissionError("oh.aggregate is read-only: use oh.output(...) to write")
    if _PREVIEW and _SAMPLE:
        sampled = _sampled(collection, {})
        if sampled:
            pipeline = [{"$match": sampled}, *pipeline]
    rows = list(_db()[collection].aggregate(pipeline, allowDiskUse=True))
    for doc in rows:
        if "_id" in doc and not isinstance(doc["_id"], (str, int, float, dict, type(None))):
            doc["_id"] = str(doc["_id"])
    _count(collection, "read", len(rows))
    return rows


def read_df(collection: str, filter: dict | None = None, *, chunksize: int | None = None, **kwargs):
    """A collection (or a filtered part of it) as a pandas DataFrame.

    ``columns=[...]`` loads only those fields. ``chunksize=N`` returns an iterator of DataFrames of N rows,
    for collections too large to load at once.
    """
    import pandas as pd

    if not chunksize:
        return pd.DataFrame(read(collection, filter, **kwargs))
    return _read_chunks(collection, filter, int(chunksize), **kwargs)


def _read_chunks(collection, filter, chunksize, *, columns=None, sort=None, projection=None, limit=None):
    import pandas as pd

    if columns and projection is None:
        projection = {c: 1 for c in columns}
        projection.setdefault("_id", 0)
    cursor = _db()[collection].find(_sampled(collection, filter), projection, batch_size=min(chunksize, 10000))
    if sort:
        cursor = cursor.sort(sort)
    if limit:
        cursor = cursor.limit(int(limit))
    batch = []
    for doc in cursor:
        if "_id" in doc:
            doc["_id"] = str(doc["_id"])
        batch.append(doc)
        if len(batch) >= chunksize:
            yield pd.DataFrame(batch)
            batch = []
    if batch:
        yield pd.DataFrame(batch)


def write(collection: str, records: Iterable[dict], *, mode: str = "append") -> int:
    """Insert documents. ``mode="replace"`` empties the collection first. Returns the inserted count."""
    _guard(collection)
    if mode not in ("append", "replace"):
        raise ValueError("mode must be 'append' or 'replace'")
    docs = []
    for record in records:
        if not isinstance(record, dict):
            record = {"value": record}
        record = dict(record)
        record.pop("_id", None)
        docs.append(record)
    if _PREVIEW:
        cfg = _OUTPUTS.get(collection, {})
        known = None if cfg.get("static") else cfg.get("known_at_field")
        return _capture(collection, docs, cfg.get("key"), known)["previewed"]
    target = _db()[collection]
    if mode == "replace":
        target.delete_many({})
    if not docs:
        return 0
    inserted = 0
    for start in range(0, len(docs), 1000):
        inserted += len(target.insert_many(docs[start : start + 1000], ordered=True).inserted_ids)
    _count(collection, "written", inserted)
    return inserted


def write_df(collection: str, frame, *, mode: str = "append") -> int:
    """Write a pandas DataFrame (one document per row). NaN becomes null."""
    import math

    return write(collection, _frame_records(frame), mode=mode)


def _frame_records(frame) -> list[dict]:
    import math

    records = frame.to_dict(orient="records")
    for record in records:
        for key, value in list(record.items()):
            if isinstance(value, float) and math.isnan(value):
                record[key] = None
            elif value is None:
                continue
            elif hasattr(value, "isoformat"):
                record[key] = value.isoformat()
            elif hasattr(value, "item") and not isinstance(value, (str, bytes)):
                try:
                    record[key] = value.item()
                except (ValueError, TypeError):
                    pass
            # pandas missing values (NaT, NA)
            if record[key] is not None and str(record[key]) in ("NaT", "<NA>", "nan"):
                record[key] = None
    return records


def result(value: Any) -> None:
    """Set the structured result returned to the agent or the workflow step (JSON-serializable)."""
    with open(_RESULT_PATH, "w", encoding="utf-8") as handle:
        json.dump(value, handle, default=str)


def log(*parts: Any) -> None:
    """Print a line to the job's output (visible to the agent and in the trace)."""
    print(*parts, flush=True)


# --- Transforms (#91) ------------------------------------------------------------------------------
class _Window:
    """The run's window: write rows in [start, end]; load from lookback_start (for returns, rolling stats)."""

    def __init__(self, raw: dict):
        self.start: str = raw["start"]
        self.end: str = raw["end"]
        self.lookback_start: str = raw.get("lookback_start") or raw["start"]

    def __getitem__(self, k):
        return getattr(self, k)

    def __repr__(self):
        return f"Window(start={self.start!r}, end={self.end!r}, lookback_start={self.lookback_start!r})"


window: _Window | None = _Window(json.loads(os.environ["OH_WINDOW"])) if os.environ.get("OH_WINDOW") else None


def _hash(record: dict) -> str:
    import hashlib

    body = {k: v for k, v in record.items() if k not in ("_id", "_hash", "_syncedAt", "processed_at")}
    return hashlib.sha1(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()


_indexed: set[tuple] = set()


def _ensure_key_index(collection: str, key: list[str]) -> None:
    """Upserts look rows up by key: without an index each lookup scans the collection (#98)."""
    ident = (collection, tuple(key))
    if ident in _indexed:
        return
    try:
        _db()[collection].create_index([(k, 1) for k in key], name="oh_key_" + "_".join(key)[:100])
    except Exception:  # e.g. an equivalent index under another name already exists
        pass
    _indexed.add(ident)


def upsert(collection: str, records: Iterable[dict], *, key: list[str], known_at_field: str | None = None) -> dict:
    """Idempotent write on ``key``. Rows whose content did not change are skipped (content hash).

    Returns ``{"written": n, "unchanged": m}``. ``known_at_field``, when given, must be set on every row.
    """
    from pymongo import UpdateOne

    _guard(collection)
    if not key:
        raise ValueError("upsert needs a key, e.g. key=['security_id', 'date']")
    if _PREVIEW:
        return _capture(collection, [dict(r) for r in records], key, known_at_field)
    rows = []
    for record in records:
        record = dict(record)
        record.pop("_id", None)
        missing = [k for k in key if record.get(k) is None]
        if missing:
            raise ValueError(f"{collection}: row without key field(s) {missing}: {str(record)[:200]}")
        if known_at_field and record.get(known_at_field) in (None, ""):
            raise ValueError(f"{collection}: row without {known_at_field} (point-in-time is required): {str(record)[:200]}")
        record["_hash"] = _hash(record)
        rows.append(record)
    target = _db()[collection]
    _ensure_key_index(collection, key)
    written = unchanged = 0
    for start in range(0, len(rows), 1000):
        chunk = rows[start : start + 1000]
        existing = {
            tuple(d.get(k) for k in key): d.get("_hash")
            for d in target.find({"$or": [{k: r[k] for k in key} for r in chunk]}, {**{k: 1 for k in key}, "_hash": 1, "_id": 0})
        }
        ops = []
        for r in chunk:
            if existing.get(tuple(r[k] for k in key)) == r["_hash"]:
                unchanged += 1
                continue
            ops.append(UpdateOne({k: r[k] for k in key}, {"$set": r}, upsert=True))
        if ops:
            res = target.bulk_write(ops, ordered=False)
            written += (res.upserted_count or 0) + (res.modified_count or 0)
    _count(collection, "written", written)
    _count(collection, "unchanged", unchanged)
    return {"written": written, "unchanged": unchanged}


def upsert_df(collection: str, frame, *, key: list[str], known_at_field: str | None = None) -> dict:
    """``upsert`` for a pandas DataFrame (NaN/NaT become null, numpy scalars plain Python)."""
    return upsert(collection, _frame_records(frame), key=key, known_at_field=known_at_field)


class _Output:
    """A declared transform output: writes use its key and write mode, and enforce its known_at field."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.collection = cfg["collection"]
        self._known = None if cfg.get("static") else cfg.get("known_at_field")

    def upsert(self, records: Iterable[dict]) -> dict:
        # Point-in-time readers filter on the as_of field: index it with the key (#102).
        if self.cfg.get("as_of_field") and not _PREVIEW:
            _ensure_key_index(self.collection, [self.cfg["as_of_field"]])
        mode = self.cfg.get("write_mode", "upsert")
        if mode == "upsert":
            return upsert(self.collection, records, key=self.cfg["key"], known_at_field=self._known)
        rows = list(records)
        if self._known and not _PREVIEW:
            for r in rows:
                if r.get(self._known) in (None, ""):
                    raise ValueError(f"{self.collection}: row without {self._known}: {str(r)[:200]}")
        return {"written": write(self.collection, rows, mode="replace" if mode == "replace" else "append"), "unchanged": 0}

    def upsert_df(self, frame) -> dict:
        return self.upsert(_frame_records(frame))

    write = upsert
    write_df = upsert_df


def output(name: str) -> _Output:
    """A declared output of the running transform (see its Outputs panel)."""
    if not _OUTPUTS:
        raise RuntimeError("oh.output() is for transforms; this job declares no outputs")
    if name not in _OUTPUTS:
        raise KeyError(f"{name} is not a declared output (outputs: {', '.join(_OUTPUTS)})")
    return _Output(_OUTPUTS[name])


_dq_buffer: list[dict] = []


def dq(issue_type: str, severity: str = "warn", *, security_id: str | None = None, date: str | None = None,
       collection: str | None = None, **context: Any) -> None:
    """Record a data-quality issue idempotently: one row per (collection, issue_type, security_id, date)."""
    if severity not in ("info", "warn", "error"):
        raise ValueError("severity must be info, warn or error")
    _dq_buffer.append({
        "collection": collection or _DQ_COLLECTION or "unknown",
        "issue_type": issue_type,
        "security_id": security_id,
        "date": date,
        "severity": severity,
        "context": context or None,
    })
    if len(_dq_buffer) >= 1000:
        _flush_dq()


def _flush_dq() -> None:
    from datetime import datetime, timezone

    from pymongo import UpdateOne

    if not _dq_buffer:
        return
    now = datetime.now(timezone.utc)
    for d in _dq_buffer:
        _count(d["collection"], "dq", 1)
    if _PREVIEW:  # counted, with the first issues kept for the preview; nothing is stored
        for d in _dq_buffer:
            issues = _preview.setdefault(d["collection"], {"count": 0, "rows": [], "dup_keys": 0, "missing_key": 0,
                                                           "missing_known_at": 0, "fields": {}, "_seen": set()})
            issues.setdefault("dq", [])
            if len(issues["dq"]) < 50:
                issues["dq"].append({k: d[k] for k in ("issue_type", "severity", "security_id", "date")})
        _dq_buffer.clear()
        return
    ops = [
        UpdateOne(
            {k: d[k] for k in ("collection", "issue_type", "security_id", "date")},
            {"$set": {"severity": d["severity"], "context": d["context"], "last_seen_at": now},
             "$setOnInsert": {"detected_at": now, "resolved": False}},
            upsert=True,
        )
        for d in _dq_buffer
    ]
    _db()["dq_issues"].bulk_write(ops, ordered=False)
    _dq_buffer.clear()


_described: dict[str, dict] = {}


def describe(collection: str, *, description: str | None = None, grain: str | None = None,
             fields: dict[str, str | dict] | None = None, caveats: list[dict] | None = None) -> None:
    """Curated catalog docs for an output. The runner applies them to the Schema Catalog after the run."""
    entry = _described.setdefault(collection, {"collection": collection})
    if description is not None:
        entry["description"] = description
    if grain is not None:
        entry["grain"] = grain
    if fields:
        entry.setdefault("fields", {}).update(
            {k: (v if isinstance(v, dict) else {"description": v}) for k, v in fields.items()}
        )
    if caveats:
        entry["caveats"] = caveats
    with open(_DESCRIBE_PATH, "w", encoding="utf-8") as handle:
        json.dump(list(_described.values()), handle, default=str)


def duckdb(**tables):
    """A DuckDB connection with each keyword registered as a table: a DataFrame, or (collection, filter)."""
    import duckdb as _duckdb

    con = _duckdb.connect()
    for name, value in tables.items():
        if isinstance(value, tuple):
            value = read_df(value[0], value[1] if len(value) > 1 else None)
        con.register(name, value)
    return con


class _Pit:
    """Point-in-time helpers (pipeline.core.pit): when information became known and when it is usable."""

    def eod_known_at(self, d):
        from pipeline.core.pit import eod_known_at

        return eod_known_at(_as_date(d))

    def earnings_known_at(self, d, timing: str = "unknown"):
        from pipeline.core.pit import earnings_known_at

        return earnings_known_at(_as_date(d), timing)

    def as_of(self, known_at, *, same_day: bool = False):
        """First trading date to act on ``known_at`` (uses the workspace trading_calendar when present)."""
        from datetime import datetime, timezone

        from pipeline.core.pit import as_of_from_known_at

        if isinstance(known_at, str):
            known_at = datetime.fromisoformat(known_at.replace("Z", "+00:00"))
        if known_at.tzinfo is None:
            known_at = known_at.replace(tzinfo=timezone.utc)
        return as_of_from_known_at(known_at, self._sessions(), same_day=same_day)

    _cache = None

    def _sessions(self):
        from datetime import datetime, timedelta, timezone

        if self._cache is None:
            rows = read("trading_calendar", {"is_trading_day": True}, sort=[("date", 1)],
                        projection={"date": 1, "open_utc": 1, "_id": 0})
            if rows:
                self._cache = [(_as_date(r["date"]), _as_dt(r["open_utc"])) for r in rows]
            else:  # no calendar yet: weekdays with a 09:30 ET (14:30 UTC) open
                start = datetime(2000, 1, 3, 14, 30, tzinfo=timezone.utc)
                days = (datetime.now(timezone.utc) - start).days + 400
                self._cache = [
                    ((start + timedelta(days=i)).date(), start + timedelta(days=i))
                    for i in range(days) if (start + timedelta(days=i)).weekday() < 5
                ]
        return self._cache


def _as_date(v):
    from datetime import date, datetime

    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return date.fromisoformat(str(v)[:10])


def _as_dt(v):
    from datetime import datetime, timezone

    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(str(v).replace("Z", "+00:00"))


pit = _Pit()

import atexit as _atexit  # noqa: E402

def _write_stats() -> None:
    if _STATS_PATH and _stats:
        with open(_STATS_PATH, "w", encoding="utf-8") as handle:
            json.dump(_stats, handle)


# At exit: buffered data-quality issues are written (also every 1,000 issues), then the stats file.
_atexit.register(_write_preview)
_atexit.register(_write_stats)
_atexit.register(lambda: _dq_buffer and _flush_dq())
