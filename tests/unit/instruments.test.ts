// Instrument classifier (#393): the shared vectors also run in pipeline/tests/test_instruments.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { instrumentType, isEquity } = await import('../../packages/core/src/instruments.js');
const { cases } = JSON.parse(await readFile('tests/fixtures/instrument-types.json', 'utf8')) as {
  cases: [string, string, Record<string, boolean>, string][];
};

test('live FMP instruments are classified: equity vs notes, preferreds, warrants, units, rights, funds', () => {
  for (const [symbol, name, flags, want] of cases)
    assert.equal(instrumentType(symbol, name, flags), want, symbol);
  assert.ok(isEquity('AAPL', 'Apple Inc.'));
  assert.ok(isEquity('TSM', 'Taiwan Semiconductor', { isAdr: true }));
  assert.equal(isEquity('DTB', 'DTE Energy Company 2020 Series'), false);
});
