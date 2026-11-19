// #544: an automatic simulation's name fits the simulation name limit, whatever the idea's title.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { autoName, NAME_MAX } = await import('../../packages/core/src/autoSimulate.js');
const { simulationConfigSchema } = await import('../../packages/core/src/simulations.js');

// The title that was refused on live (T-144), and a longer one.
const long =
  'Positive-Day Breadth Momentum: Long Large Caps with the Highest Share of Up Days over the Last Twelve Months, Skipping the Latest Month';

test('the name keeps its label and fits the limit for both labels', () => {
  for (const label of ['promising', 'successful']) {
    const name = autoName('T-144', long, label);
    assert.ok(name.length <= NAME_MAX, `${name.length} characters`);
    assert.ok(name.startsWith('T-144 Positive-Day Breadth Momentum'));
    assert.ok(name.endsWith(` (${label})`));
    assert.doesNotMatch(name, /\s{2,}/);
  }
});

test('a short title is kept whole', () => {
  assert.equal(autoName('T-1', 'Momentum', 'promising'), 'T-1 Momentum (promising)');
});

test('slashes and control characters, which a simulation name refuses, are replaced', () => {
  assert.equal(
    autoName('T-83', 'Volume-Weighted Moving Average (VWMA / Rolling VWAP)\tCost Basis', 'promising'),
    'T-83 Volume-Weighted Moving Average (VWMA - Rolling VWAP) Cost Basis (promising)',
  );
  assert.equal(
    autoName('T-76', 'Accumulation/Distribution\\Pressure', 'promising'),
    'T-76 Accumulation-Distribution-Pressure (promising)',
  );
});

test('the simulation schema accepts the name', () => {
  assert.equal(NAME_MAX, 120);
  for (const label of ['promising', 'successful'])
    for (const title of [long, `${long} / with a slash`, 'Gini / Rousseeuw-Croux\u0007 bell'])
      assert.ok(simulationConfigSchema.shape.name.safeParse(autoName('T-144', title, label)).success, title);
});
