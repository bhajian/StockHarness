// #395: the coverage sweep picks the daily series whose gap strip is missing or out of date, on real MongoDB.
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
const { datasetSyncs } = await import('../../packages/core/src/datasetSync.js');
const { refreshCatalog } = await import('../../packages/core/src/schemaCatalog.js');
const { staleDailyCoverage, dataHealth } = await import('../../packages/core/src/dataHealth.js');
const { collectionCoverage, coverageSettled } = await import('../../packages/core/src/catalogCoverage.js');

const owner = `cov-${randomUUID()}`;
const db = () => mongo.db(workspaceDatabase(owner));
const day = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 86400000).toISOString().slice(0, 10);

before(async () => {
  if (!DIRECT_MONGO) return;
  await mongo.connect();
  const base = {
    ownerId: owner,
    connectionId: 'c',
    enabled: true,
    symbolsMode: 'universe',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await datasetSyncs().insertMany([
    {
      ...base,
      _id: 'eod',
      name: 'EOD',
      dataset: 'eod_prices',
      schedule: { enabled: true, everyMinutes: 1440, input: 'x' },
      lastRunAt: new Date(),
    },
    {
      ...base,
      _id: 'gc',
      name: 'Grades',
      dataset: 'grades_consensus',
      schedule: { enabled: true, everyMinutes: 10080, input: 'x' },
      lastRunAt: new Date(),
    },
  ] as any[]);
  const bars = [];
  for (let i = 0; i < 30; i++)
    for (const symbol of ['AAA', 'BBB']) bars.push({ symbol, date: day(i), close: 10 });
  await db().collection('eod_prices').insertMany(bars);
  await db()
    .collection('grades_consensus')
    .insertOne({ symbol: 'AAA', snapshot_date: day(29), buy: 3 });
  await refreshCatalog(owner);
});
after(async () => {
  if (!DIRECT_MONGO) return;
  await datasetSyncs().deleteMany({ ownerId: owner });
  await collection<any>('dataset_catalog').deleteMany({ ownerId: owner });
  await collection<any>('catalog_coverage').deleteMany({ ownerId: owner });
  await db().dropDatabase();
  await mongo.close();
});

test('the sweep picks daily series without a gap strip, and only them', { skip: skipReason }, async () => {
  assert.deepEqual(
    await staleDailyCoverage(owner),
    ['eod_prices'],
    'the weekly snapshot has no gaps to compute',
  );
  await collectionCoverage(owner, 'eod_prices', { refresh: true });
  await coverageSettled(owner, 'eod_prices');
  assert.deepEqual(await staleDailyCoverage(owner), [], 'computed and current');
  const h = await dataHealth(owner, { days: 20 });
  const eod = h.collections.find((c) => c.collection === 'eod_prices')!;
  assert.equal(eod.gapsApplicable, true);
  assert.ok(eod.gaps && eod.gapSummary, 'the strip is there without a click');
  const gc = h.collections.find((c) => c.collection === 'grades_consensus')!;
  assert.equal(gc.gapsApplicable, false);
  assert.equal(gc.gaps, null);
});
