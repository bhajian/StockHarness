"""Point-in-time rules in Python (#103), a line-for-line port of packages/core/src/knownAt.ts `knownAtOf`.

A rule says when a row became known; `as_of_date(rule, row)` is the first trading date a strategy may act on
it. The shared vectors in pipeline/tests/fixtures/known_at_vectors.json keep both implementations identical.
Stdlib only.

`coarse_filter(rule, d)` is a MongoDB pre-filter that never drops a row visible on `d` (it may keep extra rows);
`visible(rule, row, d)` is the exact test applied afterwards.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo

    ET = ZoneInfo("America/New_York")
except Exception:  # pragma: no cover - tzdata ships with pandas
    ET = timezone.utc

UTC = timezone.utc
_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_NAIVE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$")


def _eastern(y, m, d, hh=0, mm=0, ss=0) -> datetime:
    return datetime(y, m, d, hh, mm, ss, tzinfo=ET).astimezone(UTC)


def _eastern_date(t: datetime) -> str:
    return t.astimezone(ET).date().isoformat()


def add_days(iso: str, n: int) -> str:
    return (date.fromisoformat(iso) + timedelta(days=n)).isoformat()


def _weekend(iso: str) -> bool:
    return date.fromisoformat(iso).weekday() >= 5


def _next_weekday(iso: str) -> str:
    d = add_days(iso, 1)
    while _weekend(d):
        d = add_days(d, 1)
    return d


def _on_or_next_weekday(iso: str) -> str:
    return _next_weekday(iso) if _weekend(iso) else iso


def parse_instant(v) -> datetime | None:
    """A date / timestamp value as a UTC instant. Date-only = 16:00 ET that day; naive date-times are ET."""
    if isinstance(v, datetime):
        return v.replace(tzinfo=UTC) if v.tzinfo is None else v.astimezone(UTC)  # BSON dates are naive UTC
    if isinstance(v, date):
        return _eastern(v.year, v.month, v.day, 16, 0)
    if not isinstance(v, str) or not v.strip():
        return None
    s = v.strip()
    m = _DATE.match(s)
    if m:
        return _eastern(int(m[1]), int(m[2]), int(m[3]), 16, 0)
    m = _NAIVE.match(s)
    if m:
        return _eastern(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]), int(m[6] or 0))
    try:
        t = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t.replace(tzinfo=UTC) if t.tzinfo is None else t.astimezone(UTC)


def _first_session_after(t: datetime) -> str:
    """First weekday session whose 09:30 ET open is after `t` (holidays never matter for a trading-day check)."""
    d = _eastern_date(t)
    y, m, dd = (int(x) for x in d.split("-"))
    return d if not _weekend(d) and _eastern(y, m, dd, 9, 30) > t else _next_weekday(d)


def _is_date(v) -> bool:
    return isinstance(v, str) and bool(_DATE.match(v))


def as_of_date(rule: dict, row: dict) -> str | None:
    """The first trading date `row` may be acted on under `rule`; None when unknown or current-only."""
    t = rule.get("type")
    if t == "current_only":
        return None
    if t == "asOf":  # Layer 2 rows carry their own as_of_date
        v = row.get(rule["field"])
        if isinstance(v, datetime):
            return v.date().isoformat()
        return v if _is_date(v) else None
    if t in ("eod", "snapshot"):
        k = parse_instant(row.get(rule["field"]))
        return _on_or_next_weekday(_eastern_date(k)) if k else None
    if t == "timestamp":
        k = parse_instant(row.get(rule["field"]))
        if k is None and rule.get("fallback"):
            k = parse_instant(row.get(rule["fallback"]))
        return _first_session_after(k) if k else None
    if t == "nextSession":
        k = parse_instant(row.get(rule["field"]))
        return _first_session_after(k) if k else None
    if t == "dayBefore":
        v = row.get(rule["field"])
        if not _is_date(v):
            return None
        return _first_session_after(parse_instant(add_days(v, -1)))
    if t == "statement":
        accepted, period = row.get("acceptedDate"), row.get("date")
        period = period if isinstance(period, str) else ""
        placeholder = not isinstance(accepted, str) or not accepted.strip() or accepted[:10] == period
        if not placeholder:
            k = parse_instant(accepted)
            return _first_session_after(k) if k else None
        if not _is_date(period):
            return None
        lag = 90 if str(row.get("period") or "") in ("Q4", "FY") else 45
        return _first_session_after(parse_instant(add_days(period, lag)))
    if t == "periodLag":
        v = row.get(rule["periodField"])
        if not _is_date(v):
            return None
        return _first_session_after(parse_instant(add_days(v, int(rule["lagDays"]))))
    return None


def visible(rule: dict, row: dict, d: str) -> bool:
    a = as_of_date(rule, row)
    return a is not None and a <= d


def rule_fields(rule: dict) -> list[str]:
    """Fields a rule reads (always fetched, even when the caller projects other columns)."""
    t = rule.get("type")
    if t == "statement":
        return ["acceptedDate", "date", "period"]
    if t == "periodLag":
        return [rule["periodField"]]
    out = [rule["field"]] if rule.get("field") else []
    if rule.get("fallback"):
        out.append(rule["fallback"])
    return out


def _le(field: str, d: str) -> dict:
    """`field` on or before day `d`: date / date-time strings, or BSON dates (a generous upper bound)."""
    end = datetime.fromisoformat(add_days(d, 2)).replace(tzinfo=UTC)
    return {"$or": [{field: {"$lte": d + "~"}}, {field: {"$type": "date", "$lte": end}}]}


def coarse_filter(rule: dict, d: str) -> dict:
    """A MongoDB pre-filter that keeps every row visible on `d` (and maybe a few more; `visible` decides)."""
    t = rule.get("type")
    if t == "asOf":
        return {rule["field"]: {"$lte": d}}
    if t in ("eod", "snapshot", "nextSession"):
        return _le(rule["field"], d)
    if t == "timestamp":
        if rule.get("fallback"):
            return {"$or": [_le(rule["field"], d), _le(rule["fallback"], d)]}
        return _le(rule["field"], d)
    if t == "dayBefore":
        return _le(rule["field"], add_days(d, 1))
    if t == "statement":
        return _le("date", d)
    if t == "periodLag":
        return _le(rule["periodField"], d)
    return {}
