// #297: model calls priced per model (USD per 1M tokens; output includes thinking).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { priceOf, usdOf, MODEL_PRICES, UNKNOWN_PRICE } = await import('../../packages/core/src/spendGuard.js');

test('prices: the table, overrides, a flat rate for unknown models, else a high default', () => {
  assert.deepEqual(MODEL_PRICES['gemini-3.8-flash'], { input: 0.75, output: 3.75 });
  assert.deepEqual(
    priceOf('Gemini-3.8-Flash'),
    { input: 0.75, output: 3.75 },
    'model ids are case-insensitive',
  );
  assert.deepEqual(priceOf('gemini-3.8-flash', { 'gemini-3.8-flash': { input: 1.5, output: 7.5 } }), {
    input: 1.5,
    output: 7.5,
  });
  assert.deepEqual(priceOf('mystery-model', {}, 2), { input: 2, output: 2 });
  assert.deepEqual(priceOf('mystery-model'), UNKNOWN_PRICE);
  assert.ok(
    UNKNOWN_PRICE.input > MODEL_PRICES['gemini-3.8-flash']!.input,
    'unknown models err on the safe side',
  );
});

test("a day of yesterday's dev cycles: 2.35M in, 82k out on Gemini 3.8 Flash is about $2.07", () => {
  const usd = usdOf(2_351_024, 81_634, priceOf('gemini-3.8-flash'));
  assert.ok(Math.abs(usd - 2.07) < 0.01, String(usd));
});

test('DeepSeek on Baseten is priced from the table, case-insensitively', async () => {
  const { priceOf } = await import('../../packages/core/src/spendGuard.js');
  assert.deepEqual(priceOf('deepseek-ai/DeepSeek-V4-Pro-0813'), { input: 1.32, output: 3.96 });
});
