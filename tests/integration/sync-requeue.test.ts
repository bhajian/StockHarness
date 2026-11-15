// #439: a sync claimed by the dispatcher but never started (the process died while it was queued) is due again.
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
process.env.DATASET_SYNC_RPM = '60000';
const { mongo, collection } = await import('../../packages/core/src/db.js');
const { workspaceDatabase } = await import('../../packages/core/src/mongoMcp.js');
const ds = await import('../../packages/core/src/datasetSync.js');

const owner = `rq-${randomUUID()}`;
const conn = randomUUID();
const realFetch = globalThis.fetch;

before(async () => {
  if (!DIRECT_MONGO) return;
  await mongo.connect();
  await collection<any>('connections').insertOne({
    _id: conn,
    ownerId: owner,
    name: 'FMP',
    kind: 'mcp',
    enabled: true,
    url: 'https://fmp.example.test/mcp?apikey=K',
  });
  globalThis.fetch = (async (url: string) => {
    if (!String(url).startsWith('https://financialmodelingprep.com/')) return realFetch(url);
    return new Response(JSON.stringify([{ date: '2026-11-13', month1: 3.8 }]), { status: 200 });
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  if (!DIRECT_MONGO) return;
  await ds.datasetSyncs().deleteMany({ ownerId: owner });
  await ds.datasetSyncRuns().deleteMany({ ownerId: owner });
  await collection<any>('connections').deleteMany({ ownerId: owner });
  await mongo.db(workspaceDatabase(owner)).dropDatabase();
  await mongo.close();
});

test(
  'claimed but never started: re-queued at startup; a started run clears the mark',
  { skip: skipReason },
  async () => {
    const id = `s-${randomUUID()}`;
    const nextWeek = new Date(Date.now() + 7 * 86400000);
    // What the dispatcher leaves behind when the process dies after claiming: next slot set, queuedAt stamped.
    await ds.datasetSyncs().insertOne({
      _id: id,
      ownerId: owner,
      connectionId: conn,
      name: 'Rates',
      enabled: true,
      dataset: 'treasury_rates',
      symbolsMode: 'universe',
      schedule: { enabled: true, everyMinutes: 10080, input: 'x' },
      nextRunAt: nextWeek,
      queuedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    assert.equal(await ds.requeueLostDatasetSyncs(), 1);
    const s = (await ds.datasetSyncs().findOne({ _id: id }))!;
    assert.ok(s.nextRunAt!.getTime() <= Date.now(), 'due now, not next week');
    assert.equal(s.queuedAt, undefined);
    // A run clears the mark when it starts.
    await ds.datasetSyncs().updateOne({ _id: id }, { $set: { queuedAt: new Date() } });
    await ds.runDatasetSync((await ds.datasetSyncs().findOne({ _id: id }))!, { trigger: 'manual' });
    assert.equal((await ds.datasetSyncs().findOne({ _id: id }))!.queuedAt, undefined);
    assert.equal(await ds.requeueLostDatasetSyncs(), 0, 'nothing lost');
  },
);
