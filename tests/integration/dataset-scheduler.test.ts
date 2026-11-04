// #78: dataset syncs run in a background priority queue; the dispatcher tick never waits for them.
// Real MongoDB (TEST_DIRECT_MONGODB_URI); FMP is a slow in-process fake (no network).
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
const { datasetSyncs, datasetSyncRuns, dispatchDatasetSyncs, syncQueue, effectivePriority } =
  await import('../../packages/core/src/datasetSync.js');

const owner = `sched-${randomUUID()}`;
const conn = randomUUID();
const realFetch = globalThis.fetch;
let fmpCalls = 0;

before(async () => {
  if (!DIRECT_MONGO) return;
  await mongo.connect();
  await collection<any>('connections').insertOne({
    _id: conn,
    ownerId: owner,
    name: 'FMP',
    kind: 'mcp',
    enabled: true,
    url: 'https://fmp.example.test/mcp?apikey=TESTKEY',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const base = {
    ownerId: owner,
    connectionId: conn,
    symbolsMode: 'universe',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await datasetSyncs().insertMany([
    {
      ...base,
      _id: 'rates',
      name: 'Rates',
      enabled: true,
      dataset: 'treasury_rates',
      schedule: { enabled: true, everyMinutes: 60, input: 'x' },
      nextRunAt: new Date(Date.now() - 1000),
    },
    {
      ...base,
      _id: 'gdp',
      name: 'GDP',
      enabled: true,
      dataset: 'economic_gdp',
      priority: 'P0',
      schedule: { enabled: true, everyMinutes: 60, input: 'x' },
      nextRunAt: new Date(Date.now() - 1000),
    },
  ] as any[]);
  // A slow FMP: every call takes 800 ms.
  globalThis.fetch = (async (url: string) => {
    if (!String(url).startsWith('https://financialmodelingprep.com/')) return realFetch(url);
    fmpCalls++;
    await new Promise((r) => setTimeout(r, 800));
    const body = String(url).includes('treasury-rates')
      ? [{ date: '2026-11-03', month1: 3.8, year10: 4.7 }]
      : [{ name: 'GDP', date: '2026-07-01', value: 31900 }];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  if (!DIRECT_MONGO) return;
  await datasetSyncs().deleteMany({ ownerId: owner });
  await datasetSyncRuns().deleteMany({ ownerId: owner });
  await collection<any>('connections').deleteMany({ ownerId: owner });
  await mongo.db(workspaceDatabase(owner)).dropDatabase();
  await mongo.close();
});

test('priority: explicit beats the dataset default', { skip: skipReason }, async () => {
  assert.equal(effectivePriority({ dataset: 'treasury_rates' } as any), 'P0');
  assert.equal(effectivePriority({ dataset: 'economic_gdp' } as any), 'P2');
  assert.equal(effectivePriority({ dataset: 'economic_gdp', priority: 'P0' } as any), 'P0');
});

test(
  'the dispatcher returns immediately; syncs run in the background and complete',
  { skip: skipReason },
  async () => {
    const t0 = Date.now();
    await dispatchDatasetSyncs();
    const took = Date.now() - t0;
    assert.ok(took < 600, `dispatch returned in ${took} ms while each FMP call takes 800 ms`);
    assert.ok(syncQueue.has('rates') && syncQueue.has('gdp'), 'both queued or running');
    // A second tick must not double-queue them.
    await dispatchDatasetSyncs();
    assert.equal(
      syncQueue.status().queued.filter((j) => j.id === 'rates').length +
        syncQueue.status().running.filter((j) => j.id === 'rates').length,
      1,
    );
    await syncQueue.idle();
    const runs = await datasetSyncRuns().find({ ownerId: owner }).toArray();
    assert.deepEqual(runs.map((r) => `${r.syncId}:${r.status}`).sort(), ['gdp:succeeded', 'rates:succeeded']);
    assert.equal(fmpCalls, 2);
    const rows = await mongo.db(workspaceDatabase(owner)).collection('treasury_rates').countDocuments();
    assert.equal(rows, 1);
  },
);
