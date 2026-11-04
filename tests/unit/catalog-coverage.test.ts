// #87 coverage payloads: daily series (rows, symbols) and the year × ISO-week grid.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { coverageFromDays } = await import('../../packages/core/src/catalogCoverage.js');

test('daily series and weekly averages; no symbols series when the data has none', () => {
  const days = [
    { date: '2026-01-02', rows: 10, symbols: 10 }, // ISO 2026-W01
    { date: '2025-12-29', rows: 8, symbols: 6 }, // 2026-W01 too (Monday)
    { date: '2026-01-05', rows: 4, symbols: 4 }, // 2026-W02
    { date: '2025-06-02', rows: 3, symbols: 3 },
  ];
  const c = coverageFromDays(days);
  assert.deepEqual(c.daily.dates, ['2025-06-02', '2025-12-29', '2026-01-02', '2026-01-05']);
  assert.deepEqual(c.daily.series.symbols, [3, 6, 10, 4]);
  assert.deepEqual(c.heatmap.years, ['2025', '2026']);
  assert.equal(c.heatmap.value, 'symbols');
  const cell = (w: number, y: string) =>
    c.heatmap.cells.find((x) => x[0] === w - 1 && x[1] === c.heatmap.years.indexOf(y))?.[2];
  assert.equal(cell(1, '2026'), 8, 'W01 of 2026 averages 6 and 10');
  assert.equal(cell(2, '2026'), 4);
  assert.equal(c.days, 4);
  const plain = coverageFromDays([{ date: '2026-01-02', rows: 5, symbols: 0 }]);
  assert.equal(plain.daily.series.symbols, undefined);
  assert.equal(plain.heatmap.value, 'rows');
});
