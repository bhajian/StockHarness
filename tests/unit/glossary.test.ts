// #283: the jargon on KPI cards and table headers has a plain-language tooltip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { termOf } from '../../apps/studio/src/components/glossary.ts';

test('known terms have a meaning, matched case-insensitively; anything else has none', () => {
  assert.match(termOf('Deflated Sharpe')!, /how many strategies were tried/);
  assert.equal(termOf('deflated sharpe'), termOf('Deflated Sharpe'));
  assert.match(termOf('Holdout')!, /once/);
  assert.equal(termOf('Name'), undefined);
  assert.equal(termOf(42), undefined);
});
