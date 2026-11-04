// #73 Datasets tab routing and the DataGrid CSV export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datasetsPath, parseDatasetsPath, toCsv } from '../../apps/studio/src/datasetsRoute.js';

test('datasets paths parse to a tab and optional item, and round-trip', () => {
  assert.deepEqual(parseDatasetsPath('/datasets'), { tab: 'syncs' });
  assert.deepEqual(parseDatasetsPath('/datasets/health'), { tab: 'health' });
  assert.deepEqual(parseDatasetsPath('/datasets/nope'), { tab: 'syncs' });
  assert.deepEqual(parseDatasetsPath('/datasets/transforms/prices_daily'), {
    tab: 'transforms',
    item: 'prices_daily',
  });
  assert.deepEqual(parseDatasetsPath('/harnesses'), { tab: 'syncs' });
  for (const r of [{ tab: 'catalog', item: 'fmp eod/x' }, { tab: 'syncs' }] as const)
    assert.deepEqual(parseDatasetsPath(datasetsPath(r)), r);
});

test('CSV quotes commas, quotes and newlines; objects become JSON', () => {
  const csv = toCsv(
    [
      { a: 'x,y', b: 'say "hi"', c: { k: 1 }, d: null },
      { a: 1, b: 'line\nbreak' },
    ],
    ['a', 'b', 'c', 'd'],
  );
  assert.equal(csv, 'a,b,c,d\n"x,y","say ""hi""","{""k"":1}",\n1,"line\nbreak",,');
});
