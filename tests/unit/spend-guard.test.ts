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
  assert.deepEqual(priceOf('moonshotai/Kimi-K3.1-Pro'), { input: 2, output: 10 });
});

test('#365: a daily-cap pause lifts after 00:00 UTC unless a cap is still reached; a total cap waits for the owner', async () => {
  const { dailyPauseLifts, stopKindOf } = await import('../../packages/core/src/spendGuard.js');
  const daily = "today's spend $5.10 reached the daily cap of $5.00";
  const model = "gemini: today's $2.00 reached its daily cap of $2.00";
  const total = '$51.00 since the cap started reached the cap of $50.00';
  assert.equal(stopKindOf(daily), 'daily');
  assert.equal(stopKindOf(model), 'daily');
  assert.equal(stopKindOf(total), 'total');
  const stoppedAt = '2026-11-15T21:00:00Z';
  const sameDay = new Date('2026-11-15T23:59:00Z');
  const nextDay = new Date('2026-11-16T00:01:00Z');
  const stop = { paused: true, stoppedAt, stopKind: 'daily' as const };
  assert.equal(dailyPauseLifts(stop, false, sameDay), false, 'not the same UTC day');
  assert.equal(dailyPauseLifts(stop, false, nextDay), true);
  assert.equal(dailyPauseLifts(stop, true, nextDay), false, 'a cap still reached keeps it paused');
  assert.equal(dailyPauseLifts({ ...stop, stopKind: 'total' }, false, nextDay), false);
  assert.equal(dailyPauseLifts({ ...stop, paused: false }, false, nextDay), false);
  // Stops recorded before #365 have no kind: read it from the reason.
  assert.equal(dailyPauseLifts({ paused: true, stoppedAt, stopReason: model }, false, nextDay), true);
  assert.equal(dailyPauseLifts({ paused: true, stoppedAt, stopReason: total }, false, nextDay), false);
});
