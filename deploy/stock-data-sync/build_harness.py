#!/usr/bin/env python3
"""Assemble the "Stock data sync" harness JSON from the flow files.

Each dataset becomes one `code` node: the shared _common.py prefix + the flow's run()
body + a wrapper that calls run() and reports a structured result. Nodes are chained
start -> flow1 -> ... -> finish (a harness runs as one sequential cursor, which also
serialises FMP load). Every node accepts payload overrides so a run can force the weekly
datasets and cap symbols for a fast validation pass:

    POST /api/runs {workflowId, input, payload:{force:true, limit:8, pages:1}}   # validation
    POST /api/runs {workflowId, input, payload:{force:true}}                      # full one-off

Usage: python build_harness.py [full|prove] > workflow.json
"""
import json
import sys
from pathlib import Path

FLOWS_DIR = Path(__file__).parent / "flows"
COMMON = (FLOWS_DIR / "_common.py").read_text()

WRAPPER = """

# --- node wrapper -------------------------------------------------------------
try:
    _out = run()
    oh.result({{"ok": True, "flow": {flow!r}, "fmpCalls": _calls[0], **(_out or {{}})}})
    log({flow!r}, "ok", _out, "fmpCalls=", _calls[0])
except Exception as _e:
    import traceback
    log(traceback.format_exc())
    oh.result({{"ok": False, "flow": {flow!r}, "error": str(_e)}})
"""

# Options travel in the run input (always present). Every node receives it; flows parse
# directives like "force limit=8 pages=1 maxrpm=600" from it. Scheduled runs pass a plain
# input, so weekly datasets self-gate to Saturday.
OVERRIDES = {"runInput": "{{input}}"}

# (node id, display name, flow file, cadence, timeoutSeconds)
FULL = [
    # --- daily ---
    ("universe", "Universe (screener)", "universe.py", "daily", 600),
    ("eod_prices", "EOD prices", "eod_prices.py", "daily", 3600),
    ("eod_index", "Index & VIX levels", "eod_index.py", "daily", 600),
    ("earnings_calendar", "Earnings calendar", "earnings_calendar.py", "daily", 600),
    ("earnings_surprises", "Earnings surprises", "earnings_surprises.py", "daily", 1800),
    ("analyst_grades", "Analyst grade changes", "analyst_grades.py", "daily", 600),
    ("price_target_changes", "Price target changes", "price_target_changes.py", "daily", 600),
    ("insider_trades", "Insider trades", "insider_trades.py", "daily", 600),
    ("congress_trades", "Congress trades", "congress_trades.py", "daily", 600),
    ("dividends_calendar", "Dividends calendar", "dividends_calendar.py", "daily", 600),
    ("splits_calendar", "Splits calendar", "splits_calendar.py", "daily", 600),
    ("treasury_rates", "Treasury rates", "treasury_rates.py", "daily", 300),
    ("sector_performance", "Sector performance", "sector_performance.py", "daily", 300),
    ("news_stocks", "Stock news", "news_stocks.py", "daily", 600),
    ("financials_event", "Financials (reporters)", "financials_event.py", "daily", 3600),
    # --- weekly (self-gate on Saturday unless forced) ---
    ("stock_list", "Stock list (full)", "stock_list.py", "weekly", 600),
    ("delisted_companies", "Delisted companies", "delisted_companies.py", "weekly", 900),
    ("company_profiles", "Company profiles", "company_profiles.py", "weekly", 7200),
    ("shares_float", "Shares float", "shares_float.py", "weekly", 600),
    ("analyst_estimates", "Analyst estimates", "analyst_estimates.py", "weekly", 10800),
    ("price_target_consensus", "Price target consensus", "price_target_consensus.py", "weekly", 7200),
    ("grades_consensus", "Grades consensus", "grades_consensus.py", "weekly", 7200),
    ("financial_scores", "Financial scores", "financial_scores.py", "weekly", 7200),
    ("key_metrics", "Key metrics (annual)", "key_metrics.py", "weekly", 7200),
    ("ratios", "Ratios (annual)", "ratios.py", "weekly", 7200),
    ("financial_growth", "Financial growth", "financial_growth.py", "weekly", 7200),
]

PROVE = [f for f in FULL if f[0] in ("universe", "eod_prices", "treasury_rates", "earnings_calendar", "insider_trades")]

SETS = {"full": FULL, "prove": PROVE}


def build_code(flow_id, flow_file):
    body = (FLOWS_DIR / flow_file).read_text()
    return COMMON + "\n\n# --- flow ---\n" + body + WRAPPER.format(flow=flow_id)


def build(set_name):
    flows = SETS[set_name]
    nodes = [{"id": "start", "type": "start", "name": "Start", "next": flows[0][0]}]
    for i, (fid, fname, ffile, cadence, timeout) in enumerate(flows):
        nxt = flows[i + 1][0] if i + 1 < len(flows) else "finish"
        nodes.append(
            {
                "id": fid,
                "type": "code",
                "name": f"{fname} [{cadence}]",
                "code": build_code(fid, ffile),
                "params": dict(OVERRIDES),
                "secrets": ["FMP_API_KEY"],
                "timeoutSeconds": timeout,
                "next": nxt,
            }
        )
    nodes.append({"id": "finish", "type": "finish", "name": "Finish", "template": "Stock data sync complete."})
    return {
        "name": "Stock data sync",
        "description": "Pulls market data from FMP into MongoDB collections. One node per dataset, "
        "paced to stay under FMP rate limits; weekly datasets self-gate to Saturday. "
        "Daily schedule after US close; force via run payload for a full one-off.",
        "enabled": True,
        "startAt": "start",
        "nodes": nodes,
        "maxSteps": 1000,
        "schedule": {
            "enabled": True,
            "everyMinutes": 1440,
            "at": "18:30",
            "timezone": "America/New_York",
            "input": "scheduled daily stock data sync",
        },
    }


if __name__ == "__main__":
    set_name = sys.argv[1] if len(sys.argv) > 1 else "full"
    print(json.dumps(build(set_name)))
