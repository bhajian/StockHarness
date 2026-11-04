// #81 dataset.sync.completed events + exactly-once consumers, against real MongoDB (TEST_DIRECT_MONGODB_URI).
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
const { datasetSyncs, runDatasetSync } = await import('../../packages/core/src/datasetSync.js');
const { consumeEvents, syncEvents } = await import('../../packages/core/src/eventSubscriptions.js');

const owner = `ev-${randomUUID()}`;
const conn = randomUUID();
const consumer = `test-consumer-${randomUUID()}`;
const realFetch = globalThis.fetch;
let fail = false;

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
  await collection<any>('harness_webhooks').insertOne({
    _id: `wh-${owner}`,
    ownerId: owner,
    url: 'https://hooks.example.test/x',
    events: ['dataset.sync.completed'],
    secretEncrypted: 'x',
    enabled: true,
    createdAt: new Date(),
  });
  await datasetSyncs().insertOne({
    _id: `${owner}-eod`,
    ownerId: owner,
    name: 'EOD list',
    enabled: true,
    connectionId: conn,
    dataset: 'eod_prices',
    symbolsMode: 'list',
    symbols: ['AAA', 'BBB', 'CCC'],
    from: '2026-10-01',
    schedule: { enabled: false, everyMinutes: 1440, input: 'x' },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);
  globalThis.fetch = (async (url: string) => {
    if (!String(url).startsWith('https://financialmodelingprep.com/')) return realFetch(url);
    if (fail) return new Response('nope', { status: 400 });
    const s = new URL(String(url)).searchParams.get('symbol');
    // CCC has no data: covered = 2 of 3.
    return new Response(JSON.stringify(s === 'CCC' ? [] : [{ symbol: s, date: '2026-11-03', close: 1 }]), {
      status: 200,
    });
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  if (!DIRECT_MONGO) return;
  for (const c of [
    'dataset_syncs',
    'dataset_sync_runs',
    'connections',
    'harness_events',
    'harness_webhooks',
    'webhook_deliveries',
    'dataset_catalog',
  ])
    await collection<any>(c).deleteMany({ ownerId: owner });
  await collection<any>('event_consumers').deleteMany({ _id: consumer });
  await collection<any>('event_claims').deleteMany({ consumerId: consumer });
  await mongo.db(workspaceDatabase(owner)).dropDatabase();
  await mongo.close();
});

const sync = async () => (await datasetSyncs().findOne({ _id: `${owner}-eod` }))!;
const filter = { types: ['dataset.sync.completed'], ownerId: owner };

test(
  'a completed sync emits dataset.sync.completed with its payload, and webhooks get it',
  { skip: skipReason },
  async () => {
    await runDatasetSync(await sync(), { trigger: 'manual' });
    const [e] = await syncEvents(owner, `${owner}-eod`);
    assert.equal(e.type, 'dataset.sync.completed');
    assert.deepEqual(
      [
        e.data.collection,
        e.data.rows,
        e.data.symbols_attempted,
        e.data.symbols_covered,
        e.data.date_from,
        e.data.trigger,
      ],
      ['eod_prices', 2, 3, 2, '2026-10-01', 'manual'],
    );
    assert.equal(
      await collection('webhook_deliveries').countDocuments({ ownerId: owner, eventId: e._id }),
      1,
    );
  },
);

test(
  'a consumer handles each event exactly once, also with concurrent pollers and after a restart',
  { skip: skipReason },
  async () => {
    const seen: string[] = [];
    const handler = async (e: any) => {
      seen.push(e._id);
    };
    const [a, b] = await Promise.all([
      consumeEvents(consumer, filter, handler),
      consumeEvents(consumer, filter, handler),
    ]);
    assert.equal(a + b, 1);
    assert.equal(seen.length, 1);
    // "Restart": nothing in memory matters; state is in MongoDB.
    assert.equal(await consumeEvents(consumer, filter, handler), 0);
    await runDatasetSync(await sync(), { trigger: 'schedule' });
    assert.equal(await consumeEvents(consumer, filter, handler), 1);
    assert.equal(new Set(seen).size, 2);
  },
);

test(
  'a crashing handler is redelivered after its lease expires; failures emit dataset.sync.failed',
  { skip: skipReason },
  async () => {
    await runDatasetSync(await sync(), { trigger: 'manual' });
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
    };
    assert.equal(await consumeEvents(consumer, filter, flaky), 0, 'first attempt crashed');
    assert.equal(await consumeEvents(consumer, filter, flaky), 0, 'not redelivered while the lease holds');
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(await consumeEvents(consumer, filter, flaky), 1, 'redelivered once the lease expired');
    assert.equal(calls, 2);
    fail = true;
    await assert.rejects(runDatasetSync(await sync(), { trigger: 'manual' }));
    fail = false;
    const failed = (await syncEvents(owner, `${owner}-eod`)).find((e) => e.type === 'dataset.sync.failed');
    assert.ok(failed && failed.data.run_id);
  },
);
