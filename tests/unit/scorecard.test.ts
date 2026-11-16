// #460: research scorecards by model and family.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { scorecard, scorecards } = await import('../../packages/core/src/scorecard.js');

const row = (o: Record<string, unknown>) => ({
  model: 'm1',
  family: 'momentum',
  status: 'failed',
  createdAt: new Date('2026-11-10T00:00:00Z'),
  approved: true,
  evaluated: true,
  codeAttempts: 1,
  sharpe: 0.2,
  excess: -0.01,
  ...o,
});

test('a scorecard counts yield, approval, medians and attempts', () => {
  const c = scorecard('m1', [
    row({ status: 'promising', sharpe: 0.9, excess: 0.04 }),
    row({ status: 'failed', sharpe: 0.1, codeAttempts: 3 }),
    row({ status: 'rejected_untestable', approved: false, evaluated: false, sharpe: null, excess: null }),
    row({ status: 'successful', sharpe: 1.2, excess: 0.06 }),
  ]);
  assert.equal(c.proposed, 4);
  assert.equal(c.promising, 1);
  assert.equal(c.successful, 1);
  assert.equal(c.yieldPer100, 50);
  assert.equal(c.approvedRate, 0.75);
  assert.equal(c.medianSharpe, 0.9);
  assert.equal(c.meanCodeAttempts, 1.5);
});

test('scorecards split by model, family and window', () => {
  const now = new Date('2026-11-16T00:00:00Z');
  const rows = [
    row({ model: 'a' }),
    row({ model: 'b', family: 'value', status: 'promising' }),
    row({ model: 'a', createdAt: new Date('2026-01-01T00:00:00Z') }),
  ];
  const s = scorecards(rows, now);
  assert.equal(s.all.overall.proposed, 3);
  assert.equal(s.last30.overall.proposed, 2);
  assert.deepEqual(
    s.all.byModel.map((c: any) => [c.key, c.proposed]),
    [
      ['a', 2],
      ['b', 1],
    ],
  );
  assert.equal(s.all.byFamily.find((c: any) => c.key === 'value').yieldPer100, 100);
});
