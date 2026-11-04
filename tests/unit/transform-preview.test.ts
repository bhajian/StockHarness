// #95 preview checks per output: rows, key present/unique, known_at, schema vs the catalog, nulls.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { previewChecks } = await import('../../packages/core/src/transformPreview.js');
const out = {
  collection: 'p',
  key: ['symbol', 'date'],
  write_mode: 'upsert' as const,
  known_at_field: 'known_at',
  static: false,
};
const cap = (patch: object = {}) => ({
  count: 10,
  rows: [],
  dup_keys: 0,
  missing_key: 0,
  missing_known_at: 0,
  fields: {
    symbol: { type: 'str', null_pct: 0 },
    date: { type: 'str', null_pct: 0 },
    known_at: { type: 'str', null_pct: 0 },
  },
  ...patch,
});
const status = (checks: { id: string; status: string }[]) =>
  Object.fromEntries(checks.map((c) => [c.id, c.status]));

test('a clean capture passes; a new collection has no earlier schema', () => {
  assert.deepEqual(status(previewChecks(out, cap())), {
    rows: 'pass',
    key_present: 'pass',
    key_unique: 'pass',
    known_at: 'pass',
    schema: 'pass',
  });
  assert.equal(
    previewChecks(out, cap(), ['symbol', 'date', 'known_at']).find((c) => c.id === 'schema')!.text,
    'Schema matches the last run',
  );
});

test('duplicates, missing keys and missing known_at fail; schema drift and nulls warn', () => {
  const checks = previewChecks(
    out,
    cap({
      dup_keys: 2,
      missing_key: 1,
      missing_known_at: 3,
      fields: { ...cap().fields, extra: { type: null, null_pct: 90 } },
    }),
    ['symbol', 'date', 'known_at', 'close'],
  );
  assert.deepEqual(status(checks), {
    rows: 'pass',
    key_present: 'fail',
    key_unique: 'fail',
    known_at: 'fail',
    schema: 'warn',
    nulls: 'warn',
  });
  assert.match(checks.find((c) => c.id === 'schema')!.text, /\+extra; −close/);
  assert.match(checks.find((c) => c.id === 'nulls')!.text, /extra 90%/);
});

test('static outputs skip known_at; an empty capture warns', () => {
  const s = status(
    previewChecks({ ...out, static: true, known_at_field: undefined }, cap({ count: 0, fields: {} })),
  );
  assert.equal(s.known_at, undefined);
  assert.equal(s.rows, 'warn');
});
