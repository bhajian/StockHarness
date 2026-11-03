// Real-MongoDB test of the Datasets toolbar bulk actions. Needs MONGODB_URI pointing at an
// isolated test database (e.g. an `openharness-test-*` Compose project); it never calls FMP.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { mongo } = await import('../../packages/core/src/db.js');
const { workspaceDatabase } = await import('../../packages/core/src/mongoMcp.js');
const { datasetSyncs, datasetSyncRuns, applyDatasetSyncBulk, recoverInterruptedDatasetSyncRuns } =
  await import('../../packages/core/src/datasetSync.js');

const ownerId = `bulk-test-${randomUUID()}`;
const otherOwner = `bulk-other-${randomUUID()}`;
const ws = () => mongo.db(workspaceDatabase(ownerId));
const schedule = { enabled: true, everyMinutes: 1440, input: 'x', timezone: 'UTC' };
const sync = (id: string, dataset: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  ownerId,
  name: id,
  enabled: true,
  connectionId: 'missing-connection',
  dataset,
  symbolsMode: 'universe' as const,
  schedule,
  cursor: '2026-01-01',
  lastRows: 10,
  nextRunAt: new Date(Date.now() + 3600_000),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});

before(async () => {
  await mongo.connect();
  await datasetSyncs().insertMany([
    sync('prices-a', 'eod_prices'),
    sync('prices-b', 'eod_prices'), // shares eod_prices
    sync('rates', 'treasury_rates', { targetCollection: 'my_rates' }),
    sync('index', 'eod_index'),
    { ...sync('foreign', 'eod_prices'), ownerId: otherOwner },
  ]);
  await ws()
    .collection('eod_prices')
    .insertMany([{ s: 1 }, { s: 2 }, { s: 3 }]);
  await ws()
    .collection('my_rates')
    .insertMany([{ r: 1 }]);
  await ws()
    .collection('eod_index')
    .insertMany([{ i: 1 }]);
});
after(async () => {
  await datasetSyncs().deleteMany({ ownerId: { $in: [ownerId, otherOwner] } });
  await datasetSyncRuns().deleteMany({ ownerId: { $in: [ownerId, otherOwner] } });
  await ws().dropDatabase();
  await mongo.close();
});

test('disable/enable update only the selected syncs of this tenant and re-seed the schedule', async () => {
  const r = await applyDatasetSyncBulk(ownerId, {
    ids: ['prices-a', 'rates', 'foreign'],
    action: 'disable',
    dropCollections: false,
  });
  assert.equal(r.matched, 2, 'another tenant’s sync is never matched');
  const docs = await datasetSyncs()
    .find({ _id: { $in: ['prices-a', 'rates', 'prices-b', 'foreign'] } })
    .toArray();
  const by = Object.fromEntries(docs.map((d) => [d._id, d]));
  assert.equal(by['prices-a'].enabled, false);
  assert.equal(by['rates'].enabled, false);
  assert.equal(by['prices-a'].nextRunAt, undefined);
  assert.equal(by['prices-b'].enabled, true);
  assert.equal(by['foreign'].enabled, true);
  await applyDatasetSyncBulk(ownerId, {
    ids: ['prices-a', 'rates'],
    action: 'enable',
    dropCollections: false,
  });
  assert.equal((await datasetSyncs().findOne({ _id: 'rates' }))!.enabled, true);
});

test('reset clears the cursor but keeps records', async () => {
  await applyDatasetSyncBulk(ownerId, { ids: ['index'], action: 'reset', dropCollections: false });
  assert.equal((await datasetSyncs().findOne({ _id: 'index' }))!.cursor, undefined);
  assert.equal(await ws().collection('eod_index').countDocuments(), 1);
});

test('purge empties each collection once and resets every sync writing to it', async () => {
  const r = await applyDatasetSyncBulk(ownerId, {
    ids: ['prices-a', 'rates'],
    action: 'purge',
    dropCollections: false,
  });
  assert.deepEqual(
    r.collections!.sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'eod_prices', deleted: 3 },
      { name: 'my_rates', deleted: 1 },
    ],
  );
  assert.equal(await ws().collection('eod_prices').countDocuments(), 0);
  assert.equal(await ws().collection('eod_index').countDocuments(), 1, 'unselected collection untouched');
  const b = (await datasetSyncs().findOne({ _id: 'prices-b' }))!;
  assert.equal(b.cursor, undefined, 'unselected sync sharing the purged collection is reset too');
  assert.equal((await datasetSyncs().findOne({ _id: 'foreign' }))!.cursor, '2026-01-01');
});

test('run queues selected syncs and skips ones already running', async () => {
  await datasetSyncRuns().insertOne({
    _id: randomUUID(),
    ownerId,
    syncId: 'index',
    trigger: 'manual',
    status: 'running',
    startedAt: new Date(),
  });
  const r = await applyDatasetSyncBulk(ownerId, {
    ids: ['rates', 'index'],
    action: 'run',
    dropCollections: false,
  });
  assert.deepEqual(r.queued, ['rates']);
  assert.deepEqual(r.alreadyRunning, ['index']);
  // The queued run fails fast (no such connection) and records the error on the sync.
  for (let i = 0; i < 50; i++) {
    const run = await datasetSyncRuns().findOne({ syncId: 'rates', status: { $ne: 'running' } });
    if (run) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  const run = await datasetSyncRuns().findOne({ syncId: 'rates' });
  assert.equal(run?.status, 'failed');
});

test('delete with dropCollections drops only collections no remaining sync writes to', async () => {
  await ws().collection('eod_prices').insertOne({ s: 9 });
  const r = await applyDatasetSyncBulk(ownerId, {
    ids: ['prices-a', 'index'],
    action: 'delete',
    dropCollections: true,
  });
  assert.equal(r.matched, 2);
  assert.deepEqual(r.collections, [{ name: 'eod_index', dropped: true }]);
  assert.deepEqual(r.keptCollections, ['eod_prices']);
  assert.equal(await ws().collection('eod_prices').countDocuments(), 1);
  const names = (await ws().listCollections().toArray()).map((c) => c.name);
  assert.ok(!names.includes('eod_index'));
  assert.equal(await datasetSyncs().countDocuments({ _id: { $in: ['prices-a', 'index'] } }), 0);
  assert.equal(await datasetSyncs().countDocuments({ _id: 'foreign' }), 1);
});

test('startup recovery fails runs orphaned by a restart', async () => {
  const id = randomUUID();
  await datasetSyncRuns().insertOne({
    _id: id,
    ownerId,
    syncId: 'rates',
    trigger: 'manual',
    status: 'running',
    startedAt: new Date(),
  });
  assert.ok((await recoverInterruptedDatasetSyncRuns()) >= 1);
  const run = (await datasetSyncRuns().findOne({ _id: id }))!;
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'Interrupted by a server restart');
  assert.equal(
    (await datasetSyncs().findOne({ _id: 'rates' }))!.lastError,
    'Interrupted by a server restart',
  );
  const r = await applyDatasetSyncBulk(ownerId, { ids: ['rates'], action: 'run', dropCollections: false });
  assert.deepEqual(r.alreadyRunning, []);
});
