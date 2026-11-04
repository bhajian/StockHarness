// #82 event-driven syncs against real MongoDB (TEST_DIRECT_MONGODB_URI) with FMP stubbed: after earnings + N days
// pulls only the reporters; after another sync completes runs once; validation and the YAML round trip.
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
const { datasetSyncs, datasetSyncRuns, runDatasetSync, syncQueue, addDays } =
  await import('../../packages/core/src/datasetSync.js');
const { consumeEvents } = await import('../../packages/core/src/eventSubscriptions.js');
const ST = await import('../../packages/core/src/syncTriggers.js');
const { UPSTREAM_EVENTS } = await import('../../packages/core/src/transformTriggers.js');
const { exportObjects, applyObjectImport } = await import('../../apps/api/src/objects.js');

const owner = `st-${randomUUID()}`;
const owner2 = `st2-${randomUUID()}`;
const consumer = `test-sync-triggers-${randomUUID()}`;
const conn = randomUUID();
const realFetch = globalThis.fetch;
const requested: { endpoint: string; symbol: string | null }[] = [];
const now = new Date();
const day = now.toISOString().slice(0, 10);
const base = (o: object) => ({
  ownerId: owner,
  enabled: true,
  connectionId: conn,
  symbolsMode: 'list',
  schedule: { enabled: false, everyMinutes: 1440, input: 'x' },
  createdAt: new Date(),
  updatedAt: new Date(),
  ...o,
});

before(async () => {
  if (!DIRECT_MONGO) return;
  await mongo.connect();
  for (const o of [owner, owner2])
    await collection<any>('connections').insertOne({
      _id: o === owner ? conn : randomUUID(),
      ownerId: o,
      name: 'FMP',
      kind: 'mcp',
      enabled: true,
      url: 'https://fmp.example.test/mcp?apikey=K',
    });
  await datasetSyncs().insertMany([
    base({
      _id: `${owner}-cal`,
      name: 'Earnings calendar',
      dataset: 'earnings_calendar',
      symbolsMode: 'universe',
      enabled: false,
    }),
    base({ _id: `${owner}-eod`, name: 'EOD', dataset: 'eod_prices', symbols: ['AAA'], from: '2026-10-01' }),
    base({
      _id: `${owner}-stmt`,
      name: 'Statements after earnings',
      dataset: 'income_statement',
      symbols: ['AAA', 'BBB', 'CCC'],
      trigger: { after: [], afterEarnings: { days: 2 } },
    }),
    base({
      _id: `${owner}-follow`,
      name: 'Profiles after EOD',
      dataset: 'company_profiles',
      symbols: ['AAA'],
      trigger: { after: ['dataset:eod_prices'] },
    }),
  ] as any[]);
  await mongo
    .db(workspaceDatabase(owner))
    .collection('earnings_calendar')
    .insertMany([
      { symbol: 'AAA', date: addDays(day, -2) },
      { symbol: 'BBB', date: addDays(day, -3) },
      { symbol: 'ZZZ', date: addDays(day, -2) }, // reported, but not in this sync's list
    ]);
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (!u.startsWith('https://financialmodelingprep.com/')) return realFetch(url);
    const p = new URL(u);
    const symbol = p.searchParams.get('symbol');
    requested.push({ endpoint: p.pathname.replace('/stable/', ''), symbol });
    return new Response(
      JSON.stringify(
        symbol
          ? [{ symbol, date: '2026-11-03', close: 1, period: 'Q3', acceptedDate: '2026-11-02 16:00:00' }]
          : [],
      ),
      { status: 200 },
    );
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  if (!DIRECT_MONGO) return;
  for (const o of [owner, owner2]) {
    for (const c of [
      'dataset_syncs',
      'dataset_sync_runs',
      'connections',
      'harness_events',
      'dataset_catalog',
      'schema_drift',
    ])
      await collection<any>(c).deleteMany({ ownerId: o });
    await mongo.db(workspaceDatabase(o)).dropDatabase();
  }
  await collection<any>('event_consumers').deleteMany({ _id: consumer });
  await collection<any>('event_claims').deleteMany({ consumerId: consumer });
  await mongo.close();
});

test(
  'after earnings + 2 days: only the reporting symbols are pulled, once a day',
  { skip: skipReason },
  async () => {
    const fired = await ST.fireEarningsTriggers(now, { ownerId: owner });
    assert.deepEqual(fired, [{ name: 'Statements after earnings', symbols: ['AAA'] }]);
    await syncQueue.idle();
    assert.deepEqual(
      requested.filter((r) => r.endpoint === 'income-statement').map((r) => r.symbol),
      ['AAA'],
      'BBB reported three days ago; ZZZ is not in the list',
    );
    const [run] = await datasetSyncRuns()
      .find({ syncId: `${owner}-stmt` })
      .toArray();
    assert.deepEqual([run.trigger, run.status, run.symbolsAttempted], ['event', 'succeeded', 1]);
    assert.deepEqual(await ST.fireEarningsTriggers(now, { ownerId: owner }), [], 'checked once per day');
  },
);

test('after another sync completes: the follower runs once', { skip: skipReason }, async () => {
  await runDatasetSync((await datasetSyncs().findOne({ _id: `${owner}-eod` }))!, { trigger: 'manual' });
  await consumeEvents(consumer, { types: UPSTREAM_EVENTS, ownerId: owner }, async (e) => {
    await ST.recordSyncUpstream(e);
  });
  assert.deepEqual(await ST.fireReadySyncTriggers(now, { ownerId: owner }), [], 'debounced');
  const later = new Date(now.getTime() + 61_000);
  assert.deepEqual(await ST.fireReadySyncTriggers(later, { ownerId: owner }), ['Profiles after EOD']);
  await syncQueue.idle();
  assert.deepEqual(
    await ST.fireReadySyncTriggers(later, { ownerId: owner }),
    [],
    'not twice for one completion',
  );
  const runs = await datasetSyncRuns()
    .find({ syncId: `${owner}-follow` })
    .toArray();
  assert.deepEqual(
    runs.map((r) => r.trigger),
    ['event'],
  );
});

test('validation and the YAML round trip keep the triggers', { skip: skipReason }, async () => {
  await assert.rejects(
    ST.assertSyncTriggers(owner, { dataset: 'eod_prices', trigger: { after: ['dataset:eod_prices'] } }),
    /cannot run after itself/,
  );
  await assert.rejects(
    ST.assertSyncTriggers(owner, { dataset: 'company_profiles', trigger: { after: ['dataset:nope'] } }),
    /no other dataset sync writes nope/,
  );
  await assert.rejects(
    ST.assertSyncTriggers(owner, { dataset: 'company_profiles', trigger: { after: ['transform:nope'] } }),
    /no transform named nope/,
  );
  const { yaml } = await exportObjects(owner, ['DatasetSync']);
  assert.match(yaml, /afterEarnings:\n\s+days: 2/);
  assert.match(yaml, /after:\n\s+- dataset:eod_prices/);
  const r = await applyObjectImport(
    { tenantId: owner2, user: { _id: 'u', role: 'admin' } } as any,
    yaml,
    'merge',
  );
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal((await exportObjects(owner2, ['DatasetSync'])).yaml, yaml, 'identical round trip');
});
