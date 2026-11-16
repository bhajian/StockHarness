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

test('#279: design parameters are neutral chips, not unsourced claims', () => {
  const chips = sourceNumbers(
    'Rank by 252-day momentum and 63-day volatility, hold the top 20% (at most 30 names), rebalance every 21 days, 10 bps costs.',
    values,
  );
  assert.ok(chips.length >= 6, JSON.stringify(chips));
  assert.ok(
    chips.every((c) => c.kind === 'parameter' && c.evaluationId === null),
    JSON.stringify(chips),
  );
  // A design number that happens to equal a result (45 trades vs 45 names) is still a parameter.
  assert.equal(sourceNumbers('long 45 names', values)[0].kind, 'parameter');
});

test('#279: claims keep their chips; a proposal or an idea without evaluations shows no red', () => {
  const judge = sourceNumbers('Sharpe 0.35 and excess -6.78%; it claimed Sharpe 1.42.', values);
  const by = Object.fromEntries(judge.map((c) => [c.text, c.kind]));
  assert.equal(by['0.35'], 'sourced');
  assert.equal(by['-6.78%'], 'sourced');
  assert.equal(by['1.42'], 'unsourced', 'a made-up metric is still red');
  const proposal = sourceNumbers('Expect a Sharpe near 1.42 and excess -4.3%.', values, { claims: false });
  assert.ok(
    proposal.every((c) => c.kind !== 'unsourced'),
    JSON.stringify(proposal),
  );
  assert.equal(
    sourceNumbers('Sharpe 0.35', values, { claims: false })[0].kind,
    'sourced',
    'a proposal that cites a real result still links it',
  );
});

test('what a person can do depends on the status', () => {
  assert.deepEqual(humanActions({ status: 'successful' }), {
    approve: true,
    park: true,
    reject: true,
    sendBack: true,
    resume: false,
  });
  assert.deepEqual(humanActions({ status: 'failed' }), {
    approve: false,
    park: false,
    reject: false,
    sendBack: true,
    resume: false,
  });
  // #379: an idea in progress can be set aside.
  assert.deepEqual(humanActions({ status: 'coding' }), {
    approve: false,
    park: true,
    reject: false,
    sendBack: false,
    resume: false,
  });
});
