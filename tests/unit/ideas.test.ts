// #118 / #121: numbers the agents cite are linked to the evaluation that produced them, or flagged as unsourced.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { sourceNumbers, humanActions } = await import('../../packages/core/src/ideas.js');

const values = [
  { value: 0.35312, evaluationId: 'E1' }, // sharpe
  { value: -0.06779, evaluationId: 'E1' }, // excess CAGR
  { value: 45, evaluationId: 'E1' }, // trades
  { value: 16.1032, evaluationId: 'E1' }, // a t-stat
];

test('cited numbers are sourced at their shown precision, in decimal or percent', () => {
  const chips = sourceNumbers(
    'Failed: Sharpe 0.353 (< 0.50), excess -6.78% vs SPX, 45 trades, low_vol t = 16.10. Claimed Sharpe 1.42 in 2023 on T-2 v3.',
    values,
  );
  const by = Object.fromEntries(chips.map((c) => [c.text, c.evaluationId]));
  assert.equal(by['0.353'], 'E1');
  assert.equal(by['-6.78%'], 'E1');
  assert.equal(by['45'], 'E1');
  assert.equal(by['16.10'], 'E1');
  assert.equal(by['1.42'], null, 'a number no evaluation produced is unsourced');
  assert.equal(by['0.50'], null, 'a threshold is not an evaluation number');
  assert.ok(!('2023' in by), 'years are skipped');
  assert.ok(!('2' in by) && !('3' in by), 'ids and small counts are skipped');
});

test('what a person can do depends on the status', () => {
  assert.deepEqual(humanActions({ status: 'successful' }), {
    approve: true,
    park: true,
    reject: true,
    sendBack: true,
  });
  assert.deepEqual(humanActions({ status: 'failed' }), {
    approve: false,
    park: false,
    reject: false,
    sendBack: true,
  });
  assert.deepEqual(humanActions({ status: 'coding' }), {
    approve: false,
    park: false,
    reject: false,
    sendBack: false,
  });
});
