// #74 LTTB downsampling of the standard series payload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downsample, lttbIndices } from '../../packages/core/src/series.js';

const days = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.UTC(2016, 0, 1) + i * 86400000).toISOString().slice(0, 10),
  );

test('LTTB keeps first and last, returns the threshold, and small inputs untouched', () => {
  const v = Array.from({ length: 10000 }, (_, i) => Math.sin(i / 50) * 100);
  const idx = lttbIndices(v, 500);
  assert.equal(idx.length, 500);
  assert.equal(idx[0], 0);
  assert.equal(idx.at(-1), 9999);
  assert.ok(
    idx.every((x, i) => i === 0 || x > idx[i - 1]),
    'increasing',
  );
  assert.deepEqual(lttbIndices([1, 2, 3], 500), [0, 1, 2]);
});

test('downsample keeps every series extreme and leaves small payloads alone', () => {
  const n = 12000;
  const a = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 30));
  a[4321] = 999; // a one-day spike
  const b = Array.from({ length: n }, (_, i) =>
    i === 7777 ? -50 : i % 7 === 0 ? null : 10 + Math.cos(i / 40),
  );
  const p = { dates: days(n), series: { close: a, volume: b } };
  const d = downsample(p, 2000);
  assert.ok(d.dates.length <= 2000 + 6 && d.dates.length >= 1000, `${d.dates.length} points`);
  assert.equal(d.downsampled, n);
  assert.equal(d.dates[0], p.dates[0]);
  assert.equal(d.dates.at(-1), p.dates.at(-1));
  assert.ok(d.series.close.includes(999), 'the spike survives');
  assert.ok(d.series.volume.includes(-50), 'the trough survives');
  assert.equal(d.series.close.length, d.dates.length);
  const small = { dates: days(10), series: { x: Array(10).fill(1) } };
  assert.equal(downsample(small), small);
});
