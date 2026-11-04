// #92 dependency triggers against real MongoDB (TEST_DIRECT_MONGODB_URI): a sync completes -> transform A runs
// -> A completes -> B runs, each exactly once; a transform with two upstreams waits for both; cycles refused.
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
process.env.TRANSFORM_TRIGGER_DEBOUNCE_SECONDS = '30';
const { mongo, collection } = await import('../../packages/core/src/db.js');
const { workspaceDatabase } = await import('../../packages/core/src/mongoMcp.js');
const { datasetSyncs, runDatasetSync } = await import('../../packages/core/src/datasetSync.js');
const { consumeEvents } = await import('../../packages/core/src/eventSubscriptions.js');
const T = await import('../../packages/core/src/transforms.js');
const { transformRuns, executeTransformRun, adoptQueuedRuns, requestTransformRun, transformQueue } =
  await import('../../packages/core/src/transformRunner.js');
const { recordUpstream, fireReadyTriggers, UPSTREAM_EVENTS } =
  await import('../../packages/core/src/transformTriggers.js');

const owner = `trg-${randomUUID()}`;
const conn = randomUUID();
const consumer = `test-triggers-${randomUUID()}`;
const realFetch = globalThis.fetch;
const out = (c: string) => [{ collection: c, key: ['symbol', 'date'], known_at_field: 'known_at' }];
const base = { code: 'import oh\n', incremental: { mode: 'date_range' as const, lookback_days: 0 } };

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
  await datasetSyncs().insertOne({
    _id: `${owner}-eod`,
    ownerId: owner,
    name: 'EOD list',
    enabled: true,
    connectionId: conn,
    dataset: 'eod_prices',
    symbolsMode: 'list',
    symbols: ['AAA'],
    from: '2026-10-01',
    schedule: { enabled: false, everyMinutes: 1440, input: 'x' },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);
  globalThis.fetch = (async (url: string) => {
    if (!String(url).startsWith('https://financialmodelingprep.com/')) return realFetch(url);
    return new Response(JSON.stringify([{ symbol: 'AAA', date: '2026-11-03', close: 1 }]), { status: 200 });
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
    'dataset_catalog',
    'transforms',
    'transform_versions',
    'transform_runs',
  ])
    await collection<any>(c).deleteMany({ ownerId: owner });
  await collection<any>('event_consumers').deleteMany({ _id: consumer });
  await collection<any>('event_claims').deleteMany({ consumerId: consumer });
  await mongo.db(workspaceDatabase(owner)).dropDatabase();
  await mongo.close();
});

/** One dispatcher tick for this owner, at a time past the debounce (or now). */
async function tick(settled = true) {
  await consumeEvents(consumer, { types: UPSTREAM_EVENTS, ownerId: owner }, async (e) => {
    await recordUpstream(e);
  });
  return fireReadyTriggers(new Date(Date.now() + (settled ? 31_000 : 0)), {
    autostart: false,
    ownerId: owner,
  });
}
const runsOf = (name: string) => transformRuns().find({ ownerId: owner, transformName: name }).toArray();
/** Execute the queued runs of a transform with a stub executor (emits transform.completed). */
async function complete(name: string) {
  for (const r of (await runsOf(name)).filter((x) => x.status === 'queued'))
    assert.ok(
      await executeTransformRun(r._id, async () => ({
        id: randomUUID(),
        status: 'succeeded',
        stdout: '',
        stderr: '',
        durationMs: 1,
        meta: { stats: {} },
      })),
    );
}

test(
  'sync -> A -> B, each exactly once; C waits for both of its upstreams',
  { skip: skipReason },
  async () => {
    await T.createTransform(owner, {
      ...base,
      name: 'tg_a',
      inputs: ['eod_prices'],
      outputs: out('tg_a'),
      trigger: { after: ['dataset:eod_prices'] },
    });
    await T.createTransform(owner, {
      ...base,
      name: 'tg_b',
      inputs: ['tg_a'],
      outputs: out('tg_b'),
      trigger: { after: ['transform:tg_a'] },
    });
    await T.createTransform(owner, {
      ...base,
      name: 'tg_c',
      inputs: ['tg_b'],
      outputs: out('tg_c'),
      trigger: { after: ['dataset:eod_prices', 'transform:tg_b'] },
    });

    await runDatasetSync((await datasetSyncs().findOne({ _id: `${owner}-eod` }))!, { trigger: 'manual' });
    assert.deepEqual(await tick(false), [], 'debounced: nothing fires until upstream events settle');
    assert.deepEqual(await tick(), ['tg_a']);
    const [a] = await runsOf('tg_a');
    assert.equal(a.trigger, 'event');
    assert.deepEqual([a.window?.start, a.window?.end], ['2026-10-01', a.window?.end]);
    assert.ok(a.window!.end >= '2026-11-03', "the window comes from the sync's date range");
    assert.deepEqual(await tick(), [], 'the same event never fires twice');
    assert.equal((await runsOf('tg_b')).length, 0, 'B waits for A');

    await complete('tg_a');
    assert.deepEqual(await tick(), ['tg_b']);
    const [b] = await runsOf('tg_b');
    assert.deepEqual(b.window, a.window, "B's window is A's window");
    assert.equal((await runsOf('tg_c')).length, 0, 'C has the dataset mark but still waits for B');

    await complete('tg_b');
    assert.deepEqual(await tick(), ['tg_c']);
    await complete('tg_c');
    assert.deepEqual(await tick(), []);
    assert.deepEqual(
      [(await runsOf('tg_a')).length, (await runsOf('tg_b')).length, (await runsOf('tg_c')).length],
      [1, 1, 1],
      'each ran exactly once',
    );
  },
);

test(
  'a trigger cycle is refused when saving; a disabled transform is not triggered',
  { skip: skipReason },
  async () => {
    const a = (await T.transforms().findOne({ ownerId: owner, name: 'tg_a' }))!;
    await assert.rejects(
      T.updateTransform(owner, a._id, { ...T.transformSpec(a), trigger: { after: ['transform:tg_c'] } }),
      /Trigger cycle: tg_a → tg_c → tg_b → tg_a/,
    );
    await T.updateTransform(owner, a._id, { ...T.transformSpec(a), enabled: false });
    await runDatasetSync((await datasetSyncs().findOne({ _id: `${owner}-eod` }))!, { trigger: 'manual' });
    assert.deepEqual(await tick(), []);
    assert.equal((await runsOf('tg_a')).length, 1);
  },
);

test(
  'runs queued by another process are adopted by the dispatcher after a minute',
  { skip: skipReason },
  async () => {
    const b = (await T.transforms().findOne({ ownerId: owner, name: 'tg_b' }))!;
    const [run] = await requestTransformRun(owner, b._id, {
      range: 'custom',
      start: '2026-01-05',
      end: '2026-01-05',
      autostart: false,
    });
    const stub = async () => ({
      id: randomUUID(),
      status: 'succeeded' as const,
      stdout: '',
      stderr: '',
      durationMs: 1,
      meta: { stats: {} },
    });
    assert.equal(await adoptQueuedRuns(new Date(), stub), 0, 'too fresh: its own process may still start it');
    assert.equal(await adoptQueuedRuns(new Date(Date.now() + 61_000), stub), 1);
    assert.equal(await adoptQueuedRuns(new Date(Date.now() + 61_000), stub), 0, 'not adopted twice');
    await transformQueue.idle();
    assert.equal((await transformRuns().findOne({ _id: run._id }))!.status, 'succeeded');
  },
);
