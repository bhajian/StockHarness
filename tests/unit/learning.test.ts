// #528: why an idea failed, and which ideas came close enough to refine.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { causeOf, isNearMiss } = await import('../../packages/core/src/learning.js');

const g = (gate: string, passed: boolean, value: any = null, threshold: any = 0) => ({
  gate,
  passed,
  value,
  threshold,
});
const passing = ['sharpe', 'deflated_sharpe', 'positive_excess_years', 'trades', 'holdings', 'alpha_t'].map(
  (x) => g(x, true, 1, 0.5),
);
const swap = (name: string, r: any) => passing.map((x) => (x.gate === name ? r : x));

test('the cause of a failure, in order of what explains it', () => {
  assert.equal(
    causeOf([...passing, g('no_blocking_warnings', false, 'reconciliation_breach', 'x')]).cause,
    'data',
  );
  assert.equal(causeOf(swap('trades', g('trades', false, 40, 100))).cause, 'few_trades');
  assert.equal(causeOf(swap('holdings', g('holdings', false, 3, 10))).cause, 'concentration');
  const costly = {
    series: { series: { returns_before_costs: [0.01, 0.01], returns: [-0.01, -0.01] } },
    summary: { total_return: -0.02 },
  };
  assert.equal(causeOf(swap('sharpe', g('sharpe', false, -0.2, 0.5)), costly).cause, 'costs');
  assert.equal(
    causeOf(swap('sharpe', g('sharpe', false, 0.2, 0.5)), { excess: { spx: { excess_cagr: -0.03 } } }).cause,
    'no_excess',
  );
  const regime = {
    excess: { spx: { excess_cagr: 0.02 } },
    by_regime: { trend: { up: { total_return: 0.4 }, down: { total_return: -0.2 } } },
  };
  assert.equal(causeOf(swap('sharpe', g('sharpe', false, 0.3, 0.5)), regime).cause, 'regime');
  const proof = passing.map((x) => (x.gate === 'alpha_t' ? g('alpha_t', false, 1.2, 2) : x));
  assert.equal(causeOf(proof, { excess: { spx: { excess_cagr: 0.02 } } }).cause, 'proof');
});

test('a near miss: promising, or at most two gates short and each within 80% of its threshold', () => {
  assert.equal(isNearMiss('promising', []), true);
  assert.equal(
    isNearMiss('failed', swap('sharpe', g('sharpe', false, 0.42, 0.5))),
    true,
    '0.42 of 0.5 is close',
  );
  assert.equal(isNearMiss('failed', swap('sharpe', g('sharpe', false, 0.2, 0.5))), false, 'far off');
  const three = passing.map((x) =>
    ['sharpe', 'alpha_t', 'trades'].includes(x.gate) ? { ...x, passed: false, value: x.threshold } : x,
  );
  assert.equal(isNearMiss('failed', three), false, 'three gates short');
  assert.equal(
    isNearMiss('failed', [...passing, g('no_blocking_warnings', false, 'empty_book', 'x')]),
    false,
  );
  assert.equal(isNearMiss('successful', []), false);
});
