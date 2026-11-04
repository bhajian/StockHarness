import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { transformInputSchema } = await import('../../packages/core/src/transforms.js');
const base = {
  name: 'prices_daily',
  code: 'import oh\n',
  inputs: ['eod_prices'],
  outputs: [
    {
      collection: 'prices_daily',
      key: ['security_id', 'date'],
      known_at_field: 'known_at',
      as_of_field: 'as_of_date',
    },
  ],
};
const errs = (x: unknown) => {
  const r = transformInputSchema.safeParse(x);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

test('a valid multi-output transform parses with defaults', () => {
  const t = transformInputSchema.parse({
    ...base,
    outputs: [...base.outputs, { collection: 'trading_calendar_copy', key: ['date'], static: true }],
  });
  assert.equal(t.outputs[0].write_mode, 'upsert');
  assert.deepEqual(t.incremental, { mode: 'full', lookback_days: 0 });
  assert.deepEqual(t.trigger, { after: [] });
  assert.equal(t.enabled, true);
});

test('point-in-time is required unless static', () => {
  assert.match(
    errs({ ...base, outputs: [{ collection: 'x', key: ['k'] }] }).join(),
    /needs a known_at field/,
  );
  assert.deepEqual(errs({ ...base, outputs: [{ collection: 'x', key: ['k'], static: true }] }), []);
});

test('duplicates, input = output, self-trigger and bad names are refused', () => {
  assert.match(errs({ ...base, outputs: [base.outputs[0], base.outputs[0]] }).join(), /Duplicate output/);
  assert.match(errs({ ...base, inputs: ['prices_daily'] }).join(), /both an input and an output/);
  assert.match(errs({ ...base, trigger: { after: ['transform:prices_daily'] } }).join(), /after itself/);
  assert.match(errs({ ...base, name: 'Prices Daily' }).join(), /Lowercase/);
  assert.match(errs({ ...base, trigger: { after: ['sync:eod'] } }).join(), /Invalid/);
  assert.match(errs({ ...base, secrets: ['fmp_key'] }).join(), /Invalid/);
});
