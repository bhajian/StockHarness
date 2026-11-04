// #87 coverage is aggregated in the background against real MongoDB (TEST_DIRECT_MONGODB_URI) and cached.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const DIRECT_MONGO = process.env.TEST_DIRECT_MONGODB_URI;
const skipReason = DIRECT_MONGO ? undefined : 'set TEST_DIRECT_MONGODB_URI (scripts/test-stack.sh does)';
if (DIRECT_MONGO) {
  process.env.MONGODB_URI = DIRECT_MONGO;
  process.env.MONGODB_DATABASE = 'agentic_direct_test';
}
process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { mongo, collection } = await import('../../packages/core/src/db.js');
const { workspaceDatabase } = await import('../../packages/core/src/mongoMcp.js');
const { refreshCatalogEntry } = await import('../../packages/core/src/schemaCatalog.js');
const { collectionCoverage, coverageSettled } = await import('../../packages/core/src/catalogCoverage.js');

const owner = `cov-${randomUUID()}`;
before(async () => {
  if (!DIRECT_MONGO) return;
  await mongo.connect();
  const docs = [];
  for (const date of ['2026-01-05', '2026-01-06', '2026-01-07'])
    for (const symbol of date === '2026-01-06' ? ['AAA'] : ['AAA', 'BBB'])
      docs.push({ symbol, date, close: 1 });
  docs.push({ symbol: 'AAA', date: new Date('2026-01-08T21:00:00Z'), close: 2 }); // a BSON date works too
  await mongo.db(workspaceDatabase(owner)).collection('cov_prices').insertMany(docs);
  await refreshCatalogEntry(owner, 'cov_prices');
});
after(async () => {
  if (!DIRECT_MONGO) return;
  await collection<any>('dataset_catalog').deleteMany({ ownerId: owner });
  await collection<any>('catalog_coverage').deleteMany({ ownerId: owner });
  await mongo.db(workspaceDatabase(owner)).dropDatabase();
  await mongo.close();
});

test(
  'first call computes in the background; then rows and symbols per day are cached',
  { skip: skipReason },
  async () => {
    const first = await collectionCoverage(owner, 'cov_prices');
    assert.equal(first.coverage, null);
    assert.equal(first.computing, true);
    await coverageSettled(owner, 'cov_prices');
    const { coverage, computing } = await collectionCoverage(owner, 'cov_prices');
    assert.equal(computing, false, 'the cache is fresh');
    assert.equal(coverage!.dateField, 'date');
    assert.deepEqual(coverage!.daily.dates, ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08']);
    assert.deepEqual(coverage!.daily.series.rows, [2, 1, 2, 1]);
    assert.deepEqual(coverage!.daily.series.symbols, [2, 1, 2, 1]);
    assert.deepEqual(coverage!.heatmap.years, ['2026']);
    assert.equal(
      (await collectionCoverage(owner, 'cov_prices', { refresh: true })).computing,
      true,
      'refresh recomputes',
    );
    await coverageSettled(owner, 'cov_prices');
  },
);
