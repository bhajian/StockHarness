import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { plannedWindows, windowFor } = await import('../../packages/core/src/transformRunner.js');
const dr = (lookback_days: number) => ({ incremental: { mode: 'date_range' as const, lookback_days } });

test('last day: one window, with a lookback that covers weekends (10 trading days ≈ 16 calendar days)', () => {
  const [w] = plannedWindows(dr(10), { end: '2026-11-04' });
  assert.deepEqual(w, { start: '2026-11-04', end: '2026-11-04', lookback_start: '2026-10-19' });
  assert.equal(windowFor(dr(0), '2026-11-04', '2026-11-04').lookback_start, '2026-11-04');
});

test('custom range and full backfill in yearly chunks', () => {
  assert.deepEqual(plannedWindows(dr(0), { range: 'custom', start: '2026-01-05', end: '2026-02-01' }), [
    { start: '2026-01-05', end: '2026-02-01', lookback_start: '2026-01-05' },
  ]);
  const chunks = plannedWindows(dr(10), { range: 'full', start: '2016-03-01', end: '2026-11-04' });
  assert.equal(chunks.length, 11);
  assert.deepEqual([chunks[0]!.start, chunks[0]!.end], ['2016-03-01', '2016-12-31']);
  assert.deepEqual([chunks[10]!.start, chunks[10]!.end], ['2026-01-01', '2026-11-04']);
  assert.ok(chunks[1]!.lookback_start < '2017-01-01', 'each chunk carries its own lookback');
  assert.throws(() => plannedWindows(dr(0), { range: 'custom' }), /start date/);
});

test('full-mode transforms get no window (they process everything)', () => {
  assert.deepEqual(plannedWindows({ incremental: { mode: 'full', lookback_days: 0 } }, { range: 'full' }), [
    undefined,
  ]);
});

test('the code-job run id is a valid Kubernetes label value', async () => {
  const src = await (
    await import('node:fs/promises')
  ).readFile('packages/core/src/transformRunner.ts', 'utf8');
  const m = src.match(/runId: `([^`]+)`/);
  assert.ok(m, 'runId template found');
  const sample = m![1].replace('${run._id}', '65f85192-387c-4b42-8430-4f09197e3074');
  assert.match(sample, /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/);
  assert.ok(sample.length <= 63);
});
