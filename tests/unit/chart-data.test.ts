// #74 chart helpers: range presets, CSV, histogram bins, escaping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, histogramBins, presetStart, seriesCsv } from '../../apps/studio/src/charts/chartData.js';

test('range presets start at the date N years before the last', () => {
  const dates = ['2016-01-04', '2020-06-01', '2023-11-05', '2024-11-05', '2026-11-04'];
  assert.equal(presetStart(dates, 'Max'), 0);
  assert.equal(presetStart(dates, '1Y'), 4);
  assert.equal(presetStart(dates, '3Y'), 2);
  assert.equal(presetStart(dates, '5Y'), 2);
  assert.equal(presetStart([], '1Y'), 0);
});

test('CSV, histogram bins and HTML escaping', () => {
  assert.equal(
    seriesCsv({ dates: ['2026-01-02'], series: { 'a,b': [1], c: [null] } }),
    'date,"a,b",c\n2026-01-02,1,',
  );
  const bins = histogramBins([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
  assert.equal(bins.length, 5);
  assert.equal(
    bins.reduce((n, b) => n + b.count, 0),
    11,
  );
  assert.equal(bins[4].count, 3, 'the maximum lands in the last bin');
  assert.deepEqual(histogramBins([]), []);
  assert.equal(escapeHtml('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
});
