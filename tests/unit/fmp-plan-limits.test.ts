// #291: FMP plan limits are told apart from throttles (the bodies are FMP's own answers, seen live), and a failed
// scheduled sync backs off instead of retrying every minute.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { planLimitOf, FmpPlanLimit, retryAt, PAUSE_AFTER_PLAN_FAILURES } =
  await import('../../packages/core/src/datasetSync.js');

const PAGE =
  "Premium Query Parameter: 'Special Parameters : The values for 'page' can only be 0 based on your current subscription. Please visit our subscription page to upgrade your plan at https://financialmodelingprep.com/";
const FROM =
  "Premium Query Parameter: 'Special Endpoint : This value set for 'from' is not available under your current subscription please visit our subscription page to upgrade your plan at https://financialmodelingprep.com/";
const SYMBOL =
  "Premium Query Parameter: 'Special Endpoint : This value set for 'symbol' is not available under your current subscription please visit our subscription page to upgrade your plan at https://financialmodelingprep.com/";

test('402 bodies: page, from and symbol limits; a restricted endpoint; a throttle is not a plan limit', () => {
  const page = planLimitOf('grades-latest-news', PAGE)!;
  assert.ok(page instanceof FmpPlanLimit);
  assert.equal(page.param, 'page');
  assert.equal(page.status, 402);
  assert.match(page.message, /grades-latest-news: this 'page' value is not available on the current plan \(it can only be 0\)$/);
  assert.equal(planLimitOf('earnings-calendar', FROM)!.param, 'from');
  assert.equal(planLimitOf('historical-price-eod/full', SYMBOL)!.param, 'symbol');
  const endpoint = planLimitOf('x', '{"Error Message":"Restricted Endpoint: This endpoint is not available"}')!;
  assert.equal(endpoint.param, 'endpoint');
  assert.match(endpoint.message, /FMP endpoint x is not in the current plan/);
  assert.equal(planLimitOf('x', ''), undefined, 'an empty 402 is a throttle');
  assert.equal(planLimitOf('x', '{"Error Message":"Limit Reach . Please upgrade your plan"}'), undefined);
});

test('backoff: 5, 15, then 60 minutes, never past the next regular slot; plan limits wait for the slot', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const tomorrow = new Date('2026-11-07T00:00:00Z');
  const mins = (d: Date) => (d.getTime() - now) / 60000;
  assert.deepEqual(
    [1, 2, 3, 4, 9].map((f) => mins(retryAt(f, false, tomorrow, now))),
    [5, 15, 60, 60, 60],
  );
  const soon = new Date(now + 10 * 60000);
  assert.equal(mins(retryAt(3, false, soon, now)), 10, 'the regular slot comes first');
  assert.equal(retryAt(1, true, tomorrow, now), tomorrow, 'a plan limit never retries early');
  assert.equal(PAUSE_AFTER_PLAN_FAILURES, 3);
});
