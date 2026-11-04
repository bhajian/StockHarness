// #94 every "New transform" template is a valid transform; Flatten has several outputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, readSnippet } from '../../apps/studio/src/transformTemplates.js';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { transformInputSchema } = await import('../../packages/core/src/transforms.js');

test('templates validate against the transform schema', () => {
  assert.deepEqual(
    TEMPLATES.map((t) => t.id),
    ['blank', 'join', 'flatten', 'feature', 'snapshot_diff'],
  );
  for (const t of TEMPLATES) {
    const r = transformInputSchema.safeParse(t.draft);
    assert.ok(r.success, `${t.id}: ${JSON.stringify(!r.success && r.error.issues)}`);
    for (const o of t.draft.outputs)
      assert.match(
        t.draft.code,
        new RegExp(`oh\\.output\\("${o.collection}"\\)`),
        `${t.id} writes ${o.collection}`,
      );
  }
  assert.ok(TEMPLATES.find((t) => t.id === 'flatten')!.draft.outputs.length >= 3);
});

test('the read snippet filters the window and projects the fields', () => {
  assert.equal(
    readSnippet('eod_prices', ['symbol', 'close'], 'date'),
    'eod_prices = oh.read_df("eod_prices", {"date": {"$gte": oh.window.start, "$lte": oh.window.end}} if oh.window else {}, columns=["symbol", "close"])\n',
  );
  assert.equal(readSnippet('x', []), 'x = oh.read_df("x", {})\n');
});
