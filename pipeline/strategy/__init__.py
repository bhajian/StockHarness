"""Layer 3: strategy plugins and the trusted evaluator (M3, #103–#107).

Agents write plugins (contract.py); fixed platform code reads data point-in-time (reader.py), walks the dates
and scores the result.
"""

EVALUATOR_VERSION = "1.9.0"  # 1.9: signal tape, independent executor and daily reconciliation (#467); 1.8: index scopes, hindsight_scope warning (#455); 1.7: survivorship_pre_2021 warning (#463); 1.6: rank buffer, churn metrics (#466), name and sector caps, concentration (#465); 1.5: square-root market impact, borrow by size, capacity (#452); 1.4: warns on data-quality flags of held names (#451); 1.3: sector as of each date, no unfiltered fallback universe, hashed ties (#454); 1.2: delisting returns by class, shorts never gain (#448); 1.1: total-return benchmark, Sharpe and alpha over the risk-free rate (#445)
# Plugins declare compatibility with the evaluator's major version.
EVALUATOR_MAJOR = EVALUATOR_VERSION.split(".")[0]
