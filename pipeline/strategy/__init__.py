"""Layer 3: strategy plugins and the trusted evaluator (M3, #103–#107).

Agents write plugins (contract.py); fixed platform code reads data point-in-time (reader.py), walks the dates
and scores the result.
"""

EVALUATOR_VERSION = "1.0.0"
# Plugins declare compatibility with the evaluator's major version.
EVALUATOR_MAJOR = EVALUATOR_VERSION.split(".")[0]
