// #83 ingest validation: error payloads, missing fields, type changes, added fields, null rates.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { errorShape, validateRows, ingestChecker } =
  await import('../../packages/core/src/ingestValidation.js');

const expected = [
  { name: 'symbol', type: 'string', null_pct: 0 },
  { name: 'date', type: 'date', null_pct: 0 },
  { name: 'close', type: 'number', null_pct: 0 },
  { name: 'volume', type: 'integer', null_pct: 0 },
  { name: 'vwap', type: 'number', null_pct: 80 },
];
const opts = { keyFields: ['symbol', 'date'], dateField: 'date' };
const row = (o: object = {}) => ({ date: '2026-11-03', close: 101.5, volume: 1000, ...o });

test('error-shaped payloads', () => {
  assert.equal(
    errorShape({ 'Error Message': 'Invalid API KEY. Please retry.' }),
    'Invalid API KEY. Please retry.',
  );
  assert.equal(errorShape('Limit Reach'), 'Limit Reach');
  assert.equal(errorShape([row()]), undefined);
  assert.equal(
    errorShape({ symbol: 'AAA', date: '2026-11-03', close: 1, message: 'x', volume: 2 }),
    undefined,
    'a data row with a message field',
  );
});

test('missing fields, type changes, added fields and null rates', () => {
  assert.deepEqual(validateRows([row()], expected, opts), []);
  assert.deepEqual(validateRows([row({ vwap: 101 })], expected, opts), [], 'an often-null field may appear');
  const d = validateRows([{ date: '2026-11-03', close: '101.5', adjClose: 1 }], expected, opts);
  assert.deepEqual(
    d.map((x) => [x.kind, x.field, x.breaking]),
    [
      ['type_change', 'close', false],
      ['missing_field', 'volume', false],
      ['added_field', 'adjClose', false],
    ],
  );
  const noDate = validateRows([{ close: 1, volume: 1 }], expected, opts);
  assert.deepEqual(
    noDate.map((x) => [x.kind, x.field, x.breaking]),
    [['missing_field', 'date', true]],
    'the date field is critical',
  );
  const typed = validateRows([row({ date: 20261103 })], expected, opts);
  assert.equal(typed[0].breaking, true, 'a key/date field changing type is breaking');
  const many = Array.from({ length: 30 }, (_, i) => row({ close: i < 20 ? null : 1 }));
  assert.deepEqual(
    validateRows(many, expected, opts).map((x) => x.kind),
    ['null_rate'],
  );
  assert.deepEqual(validateRows([row()], [], opts), [], 'no schema known yet: nothing to compare');
});

test('the checker fails breaking items instead of writing and collects drift once', () => {
  const c = ingestChecker(expected, { collection: 'eod_prices', ...opts });
  assert.equal(c.check([row()]).length, 1);
  assert.throws(() => c.check({ 'Error Message': 'Invalid API KEY.' }), /error instead of data/);
  assert.throws(
    () => c.check([{ close: 1, volume: 1 }]),
    /Schema drift in eod_prices, not written: date missing field/,
  );
  c.check([row({ adjClose: 1 })]);
  c.check([row({ adjClose: 2 })]);
  assert.deepEqual(
    c
      .drift()
      .map((d) => `${d.kind}:${d.field}`)
      .sort(),
    ['added_field:adjClose', 'missing_field:date'],
  );
});
