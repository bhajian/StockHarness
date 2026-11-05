#!/bin/sh
# Local check target for the trusted evaluator (#107, the M3 exit gate): contract, reader, engine, metrics and the
# synthetic sanity suite. Hosted CI stays off unless enabled (#33). The 2022 momentum check runs on real data:
# evaluate pipeline/strategy/sanity.py MOMENTUM_12_1 over 2021-07-01..2023-06-30 and pass the record to
# sanity.momentum_2022 (docs/strategies.md).
set -e
cd "$(dirname "$0")/.."
python3 -m unittest pipeline.tests.test_strategy_contract pipeline.tests.test_strategy_engine \
  pipeline.tests.test_strategy_metrics pipeline.tests.test_strategy_sanity
python3 -m pipeline.strategy.sanity
