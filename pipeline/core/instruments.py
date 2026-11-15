"""Instrument types (#393): tell common stock and ADRs from notes, preferreds, warrants, units, rights and funds.

FMP lists exchange-traded debt, preferreds and SPAC warrants next to common stock, often under the issuer's name
and market cap ("DTE Energy Company 2020 Series", "The Southern Company JR 2017B NT 77"). Only `common` and `ADR`
are equity for the universes. The same rules are in packages/core/src/instruments.ts; both are tested against
tests/fixtures/instrument-types.json.
"""
from __future__ import annotations

import re

EQUITY_TYPES = ("common", "ADR")

_PREFERRED_SYMBOL = re.compile(r"[-.](P[A-Z]?|PR[A-Z]?)$")
_PREFERRED_NAME = re.compile(r"\b(preferred|pfd|perpetual)\b")
_ADR_NAME = re.compile(r"\bamerican depositary (shares?|receipts?)\b")
# FMP profiles often leave isFund/isEtf unset for mutual, closed-end and index funds (#437).
_ETF_NAME = re.compile(r"\b(etf|etn|etfs)\b")
_FUND_NAME = re.compile(r"\bfund\b")
_MUTUAL_FUND_SYMBOL = re.compile(r"^[A-Z]{4}X$")  # NASDAQ: a fifth letter X is a mutual fund
_WARRANT_SYMBOL = re.compile(r"[-.](WS|W[A-Z]?)$|^[A-Z]{4}W$")
_UNIT_SYMBOL = re.compile(r"[-.](U|UN)$|^[A-Z]{4}U$")
_RIGHT_SYMBOL = re.compile(r"[-.](R|RT)$|^[A-Z]{4}R$")
_NOTE_NAME = (
    re.compile(r"\b(notes?|debentures?|nt)\b"),
    re.compile(r"\bdue (19|20)\d{2}\b"),
    re.compile(r"\d+(\.\d+)?\s?%"),
    re.compile(r"\b(19|20)\d{2}[a-z]?\s+series\b"),
    re.compile(r"\b(subordinated|fixed[- ]rate|floating[- ]rate)\b"),
)


def instrument_type(symbol, name=None, is_etf=False, is_fund=False, is_adr=False) -> str:
    """common | ADR | preferred | note | warrant | unit | right | fund | etf."""
    s = str(symbol or "").upper()
    n = str(name or "").lower()
    if is_etf:
        return "etf"
    if is_fund:
        return "fund"
    if _ETF_NAME.search(n):
        return "etf"
    if _FUND_NAME.search(n) or _MUTUAL_FUND_SYMBOL.search(s):
        return "fund"
    if _ADR_NAME.search(n):
        return "ADR"
    if _PREFERRED_SYMBOL.search(s) or _PREFERRED_NAME.search(n):
        return "preferred"
    if _WARRANT_SYMBOL.search(s) or re.search(r"\bwarrants?\b", n):
        return "warrant"
    if _UNIT_SYMBOL.search(s):
        return "unit"
    if _RIGHT_SYMBOL.search(s):
        return "right"
    if any(p.search(n) for p in _NOTE_NAME):
        return "note"
    return "ADR" if is_adr else "common"


def is_equity(symbol, name=None, is_etf=False, is_fund=False, is_adr=False) -> bool:
    return instrument_type(symbol, name, is_etf, is_fund, is_adr) in EQUITY_TYPES
