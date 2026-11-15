// #366: the evaluation header names its scope; a top-N run is not "whole universe".
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { scopeLabel } = await import('../../apps/studio/src/components/evaluationScope.js');

test('the evaluation scope label', () => {
  assert.equal(scopeLabel({ symbols: ['AAPL', 'MSFT'] }), '2 symbols');
  assert.equal(scopeLabel({ universe: { top_by_market_cap: 500 } }), 'S&P 500 proxy (top 500 by market cap)');
  assert.equal(scopeLabel({ universe: { top_by_market_cap: 100 } }), 'top 100 by market cap');
  assert.equal(scopeLabel({}), 'whole universe');
  assert.equal(scopeLabel({ symbols: [] }), 'whole universe');
});
