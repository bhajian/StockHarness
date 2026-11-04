import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { planBackfill, yearRanges, backfillUnsupported, backfillProgress } =
  await import('../../packages/core/src/datasetBackfill.js');
const { catalogById } = await import('../../packages/core/src/datasetCatalog.js');
const { PriorityRateLimiter } = await import('../../packages/core/src/syncScheduler.js');
const def = (id: string) => catalogById.get(id)!;

test('per-symbol datasets: symbol batches; ranges split under the per-request cap', () => {
  const syms = Array.from({ length: 60 }, (_, i) => `S${i}`);
  const p = planBackfill(def('eod_prices'), '2016-01-01', '2026-11-04', syms, 25);
  assert.equal(p.mode, 'symbols');
  assert.deepEqual(
    p.batches.map((b) => [b.start, b.end]),
    [
      [0, 25],
      [25, 50],
      [50, 60],
    ],
  );
  assert.equal(yearRanges('2016-01-01', '2026-11-04').length, 1, '10 years: one call per symbol');
  const long = yearRanges('1990-01-01', '2026-11-04');
  assert.equal(long.length, 3);
  assert.equal(long[0][0], '1990-01-01');
  assert.equal(long[long.length - 1][1], '2026-11-04');
});

test('calendars: 60-day windows; index levels: fixed symbols', () => {
  const w = planBackfill(def('earnings_calendar'), '2026-01-01', '2026-04-30');
  assert.equal(w.mode, 'windows');
  assert.ok(w.batches.length >= 2 && w.batches[0].from === '2026-01-01');
  assert.equal(planBackfill(def('eod_index'), '2016-01-01', '2026-11-04').mode, 'fixed');
});

test('datasets without history are refused with a reason', () => {
  assert.match(backfillUnsupported(def('analyst_estimates'))!, /snapshot/i);
  assert.match(backfillUnsupported(def('insider_trades'))!, /feed/i);
  assert.match(backfillUnsupported(def('company_profiles'))!, /current values/i);
  assert.equal(backfillUnsupported(def('eod_prices')), undefined);
  assert.equal(backfillUnsupported(def('income_statement')), undefined);
  assert.equal(backfillUnsupported(def('dividends_history')), undefined);
});

test('progress counts partial batches; BACKFILL always yields to scheduled syncs', async () => {
  const p = backfillProgress({
    status: 'running',
    startedAt: new Date(Date.now() - 60000),
    batches: [
      { i: 0, label: '', status: 'done', rows: 0, errors: 0, attempts: 1, start: 0, end: 10, next: 10 },
      { i: 1, label: '', status: 'running', rows: 0, errors: 0, attempts: 1, start: 10, end: 20, next: 15 },
    ],
  } as any);
  assert.equal(p.pct, 75);
  assert.ok(p.etaMs! > 0);
  const limiter = new PriorityRateLimiter(6000);
  const order: string[] = [];
  const b = Array.from({ length: 5 }, () => limiter.acquire('BACKFILL').then(() => order.push('B')));
  await new Promise((r) => setTimeout(r, 12));
  await limiter.acquire('P2').then(() => order.push('P2'));
  await Promise.all(b);
  assert.ok(order.indexOf('P2') <= 2, `P2 jumps the backfill queue (${order.join('')})`);
});
