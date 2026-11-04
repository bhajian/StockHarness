import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { PriorityRateLimiter, SyncWorkQueue, defaultPriority } =
  await import('../../packages/core/src/syncScheduler.js');
const { DATASET_CATALOG } = await import('../../packages/core/src/datasetCatalog.js');

test('saturated P2 work never starves P0: the next slot goes to P0', async () => {
  const limiter = new PriorityRateLimiter(6000); // one slot every 10 ms
  const served: string[] = [];
  const p2 = Array.from({ length: 30 }, (_, i) => limiter.acquire('P2').then(() => served.push(`P2-${i}`)));
  await new Promise((r) => setTimeout(r, 35)); // a few P2 slots go out
  const p0 = limiter.acquire('P0').then(() => served.push('P0'));
  const p1 = limiter.acquire('P1').then(() => served.push('P1'));
  await p0;
  await p1;
  const i0 = served.indexOf('P0');
  assert.ok(i0 >= 0 && i0 <= 5, `P0 served within the next slot or two (position ${i0})`);
  assert.equal(served.indexOf('P1'), i0 + 1, 'then P1, before the remaining P2');
  await Promise.all(p2);
  assert.deepEqual(
    served.filter((x) => x.startsWith('P2')),
    Array.from({ length: 30 }, (_, i) => `P2-${i}`),
    'FIFO within a priority',
  );
});

test('slots are spaced by the rate and a cooldown pauses everyone', async () => {
  const limiter = new PriorityRateLimiter(3000); // 20 ms
  const t0 = Date.now();
  await Promise.all([limiter.acquire('P1'), limiter.acquire('P1'), limiter.acquire('P1')]);
  assert.ok(Date.now() - t0 >= 35, 'three slots take at least two intervals');
  limiter.cooldown(120);
  const t1 = Date.now();
  await limiter.acquire('P0');
  assert.ok(Date.now() - t1 >= 100, 'cooldown applies to P0 too');
});

test('work queue: concurrency, priority order, dedupe, errors do not stop it', async () => {
  const q = new SyncWorkQueue(2);
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const job =
    (id: string, ms: number, fail = false) =>
    async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, ms));
      order.push(id);
      active--;
      if (fail) throw new Error('boom');
    };
  q.enqueue('a', 'P2', job('a', 40));
  q.enqueue('b', 'P2', job('b', 40, true));
  q.enqueue('c', 'P2', job('c', 5));
  q.enqueue('d', 'P0', job('d', 5));
  assert.equal(q.enqueue('d', 'P0', job('d', 5)), false, 'already queued');
  assert.equal(q.enqueue('a', 'P2', job('a', 5)), false, 'already running');
  await q.idle();
  assert.equal(maxActive, 2);
  assert.ok(order.indexOf('d') < order.indexOf('c'), 'P0 queued later still runs before the queued P2');
  assert.deepEqual(order.sort(), ['a', 'b', 'c', 'd'], 'a failing job does not stop the queue');
});

test('every catalog dataset has a sensible default priority', () => {
  const by = Object.fromEntries(DATASET_CATALOG.map((d) => [d.id, defaultPriority(d.id)]));
  assert.equal(by.eod_prices, 'P0');
  assert.equal(by.splits_history, 'P0');
  assert.equal(by.universe, 'P0');
  assert.equal(by.income_statement, 'P1');
  assert.equal(by.analyst_estimates, 'P1');
  assert.equal(by.news_stocks, 'P2');
  assert.equal(by.revenue_product_segmentation, 'P2');
  assert.equal(Object.keys(by).length, 42);
});
