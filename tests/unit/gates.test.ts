// #113: each success gate, the per-year excess, the downgrade-only verdict rule and forward_only tagging.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const G = await import('../../packages/core/src/gates.js');

// Two years: the strategy beats the S&P 500 in 2023 (+10% vs +5%) and lags in 2024 (+1% vs +4%).
const series = {
  dates: ['2023-03-01', '2023-09-01', '2024-03-01', '2024-09-01'],
  series: { returns: [0.05, 0.047619, 0.01, 0], spx_returns: [0.05, 0, 0.04, 0] },
};
const good = {
  summary: { sharpe: 0.9, trades: 240 },
  trial_context: { dsr: 0.97, trials: 40 },
  factors: { alpha_t: 2.6 },
  warnings: [],
  rebalances: [
    { long: 12, short: 0 },
    { long: 10, short: 0 },
  ],
  series: {
    dates: ['2023-01-03', '2024-01-03'],
    series: { returns: [0.02, 0.01], spx_returns: [0.01, 0.0] },
  },
};
const holdout = { summary: { sharpe: 0.6 }, excess: { spx: { excess_cagr: 0.03 } } };
const byGate = (results: { gate: string; passed: boolean }[]) =>
  Object.fromEntries(results.map((r) => [r.gate, r.passed]));

test('per-year excess from the daily series', () => {
  const y = G.yearlyExcess({ series });
  assert.deepEqual(
    y.map((x) => x.year),
    ['2023', '2024'],
  );
  assert.ok(Math.abs(y[0].excess - 0.05) < 1e-4);
  assert.ok(Math.abs(y[1].excess - -0.03) < 1e-9);
});

test('a strong record passes every gate, and each gate fails on its own threshold', () => {
  const all = G.evaluateGates(G.DEFAULT_GATES, good, holdout);
  assert.ok(G.allGatesPass(all), JSON.stringify(all.filter((r) => !r.passed)));
  const cases: [string, Record<string, any>][] = [
    ['sharpe', { summary: { ...good.summary, sharpe: 0.4 } }],
    ['deflated_sharpe', { trial_context: { dsr: 0.9, trials: 400 } }],
    ['positive_excess_years', { series }],
    ['trades', { summary: { ...good.summary, trades: 99 } }],
    ['holdings', { rebalances: [{ long: 5, short: 3 }] }],
    ['alpha_t', { factors: { alpha_t: 1.9 } }],
    ['no_blocking_warnings', { warnings: [{ code: 'extreme_returns' }] }],
  ];
  for (const [gate, patch] of cases) {
    const r = byGate(G.evaluateGates(G.DEFAULT_GATES, { ...good, ...patch }, holdout));
    assert.equal(r[gate], false, gate);
    assert.equal(Object.values(r).filter((p) => !p).length, 1, `only ${gate} fails`);
  }
  const weakHoldout = byGate(
    G.evaluateGates(G.DEFAULT_GATES, good, {
      summary: { sharpe: 0.2 },
      excess: { spx: { excess_cagr: -0.01 } },
    }),
  );
  assert.deepEqual([weakHoldout.holdout_excess, weakHoldout.holdout_sharpe], [false, false]);
  const pending = G.evaluateGates(G.DEFAULT_GATES, good);
  assert.ok(G.exploreGatesPass(pending) && !G.allGatesPass(pending), 'no holdout yet: pending');
  assert.deepEqual(
    G.evaluateGates(G.DEFAULT_GATES, undefined).map((r) => r.passed),
    [false],
  );
});

test('the Judge can downgrade with reasons but never upgrade', () => {
  assert.match(G.verdictProblem('successful', 'failed', 'Looks great to me')!, /never upgrade/);
  assert.match(G.verdictProblem('failed', 'successful', 'meh')!, /needs the reasons/);
  assert.equal(
    G.verdictProblem(
      'failed',
      'successful',
      'Alpha comes from a single sector in 2023; a factor in disguise.',
    ),
    undefined,
  );
  assert.equal(G.verdictProblem('successful', 'successful', ''), undefined);
  assert.equal(G.verdictProblem('failed', 'failed', ''), undefined);
});

test('estimate-based theories are forward_only; analyst_events proxies are not', () => {
  assert.equal(G.isForwardOnly(['analyst_estimates.epsAvg', 'prices_daily.tr_1d']), true);
  assert.equal(G.isForwardOnly(['price_target_consensus']), true);
  assert.equal(G.isForwardOnly(['analyst_events.revision', 'features_ranked.mom_12_1_pct']), false);
  assert.equal(G.gatesSchema.parse({}).minDeflatedSharpe, 0.95);
});
