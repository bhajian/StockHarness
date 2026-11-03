import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { collectionsToDrop, syncCollection, datasetBulkInput } =
  await import('../../packages/core/src/datasetSync.js');

const s = (id: string, dataset: string, targetCollection?: string) => ({
  _id: id,
  dataset,
  targetCollection,
});

test('syncCollection prefers the override, else the catalog default', () => {
  assert.equal(syncCollection(s('a', 'eod_prices')), 'eod_prices');
  assert.equal(syncCollection(s('a', 'eod_prices', 'my_prices')), 'my_prices');
  assert.equal(syncCollection(s('a', 'not_a_dataset')), '');
});

test('collectionsToDrop keeps collections still written by unselected syncs and dedupes', () => {
  const all = [
    s('1', 'eod_prices'),
    s('2', 'eod_prices'), // shares eod_prices with 1
    s('3', 'treasury_rates'),
    s('4', 'eod_index'),
    s('5', 'eod_index'), // shares eod_index with 4, both selected
  ];
  const selected = [all[0], all[2], all[3], all[4]];
  const { drop, keep } = collectionsToDrop(selected, all);
  assert.deepEqual(drop.sort(), ['eod_index', 'treasury_rates']);
  assert.deepEqual(keep, ['eod_prices']);
});

test('collectionsToDrop drops everything when all syncs are selected', () => {
  const all = [s('1', 'eod_prices'), s('2', 'treasury_rates', 'rates')];
  assert.deepEqual(collectionsToDrop(all, all), { drop: ['eod_prices', 'rates'], keep: [] });
});

test('datasetBulkInput validates actions and ids', () => {
  assert.equal(datasetBulkInput.parse({ ids: ['a'], action: 'purge' }).dropCollections, false);
  assert.throws(() => datasetBulkInput.parse({ ids: [], action: 'run' }));
  assert.throws(() => datasetBulkInput.parse({ ids: ['a'], action: 'truncate' }));
});
