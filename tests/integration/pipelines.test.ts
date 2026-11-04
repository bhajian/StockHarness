// #156 pipelines against real MongoDB (TEST_DIRECT_MONGODB_URI) with the real sync code (FMP stubbed) and the
// real transform runner (code execution stubbed): ordering, gates, blocking, shared nodes, re-run from here,
// resume, backfill, and the YAML round trip.
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
const { datasetSyncs, datasetSyncRuns } = await import('../../packages/core/src/datasetSync.js');
const T = await import('../../packages/core/src/transforms.js');
const { requestTransformRun, executeTransformRun, transformRuns } =
  await import('../../packages/core/src/transformRunner.js');
const P = await import('../../packages/core/src/pipelines.js');
const E = await import('../../packages/core/src/pipelineEngine.js');
const { exportObjects, applyObjectImport } = await import('../../apps/api/src/objects.js');

const owner = `pl-${randomUUID()}`;
const owner2 = `pl2-${randomUUID()}`;
const conn = randomUUID();
const realFetch = globalThis.fetch;
const who = (t: string) => ({ tenantId: t, user: { _id: 'u', role: 'admin' } }) as any;
const calls: { type: string; period: string; node: string; at: number }[] = [];

// Transforms run for real through the runner; only the Python execution is stubbed.
const builtinTransform = E.nodeExecutor('transform')!;
E.registerNodeExecutor('transform', {
  async start(ctx) {
    const t = (await T.transforms().findOne({ ownerId: ctx.ownerId, name: P.refName(ctx.node.ref) }))!;
    calls.push({ type: 'transform', period: ctx.run.period.id, node: ctx.nodeId, at: Date.now() });
    const runs = await requestTransformRun(ctx.ownerId, t._id, {
      trigger: 'pipeline',
      range: 'custom',
      start: ctx.run.period.start,
      end: ctx.run.period.end,
      autostart: false,
    });
    for (const r of runs)
      await executeTransformRun(r._id, async () => ({
        id: randomUUID(),
        status: 'succeeded',
        stdout: '',
        stderr: '',
        durationMs: 1,
        meta: { stats: { [t.outputs[0].collection]: { written: 7 } } },
      }));
    return { runIds: runs.map((r) => r._id) };
  },
  poll: builtinTransform.poll,
});
for (const type of ['research', 'live'] as const)
  E.registerNodeExecutor(type, {
    start: async (ctx) => (
      calls.push({ type, period: ctx.run.period.id, node: ctx.nodeId, at: Date.now() }),
      {}
    ),
    poll: async () => ({ status: 'succeeded', stats: { rows: 1 } }),
  });

const sync = (id: string, name: string, target: string, symbols: string[]) => ({
  _id: id,
  ownerId: owner,
  name,
  enabled: true,
  connectionId: conn,
  dataset: 'eod_prices',
  targetCollection: target,
  symbolsMode: 'list',
  symbols,
  from: '2026-10-01',
  schedule: { enabled: false, everyMinutes: 1440, input: 'x' },
  createdAt: new Date(),
  updatedAt: new Date(),
});
const graph = (gated: boolean) => [
  { id: 'eod', ref: 'sync:EOD', gate: { min_symbol_coverage: 0.95 } },
  { id: 'eod_b', ref: 'sync:EOD B', gate: gated ? { min_symbol_coverage: 0.95 } : {} },
  { id: 'prices', ref: 'transform:pl_prices', after: ['eod'] },
  { id: 'prices_b', ref: 'transform:pl_prices_b', after: ['eod_b'] },
  { id: 'research', ref: 'research:loop', after: ['prices', 'prices_b'] },
  { id: 'live', ref: 'live:all-approved', after: ['research'] },
];
let weekly = '';
let gated = '';

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
  await datasetSyncs().insertMany([
    sync(`${owner}-a`, 'EOD', 'pl_eod', ['AAA', 'BBB']),
    // 3 of 5 symbols return rows: 60% coverage.
    sync(`${owner}-b`, 'EOD B', 'pl_eod_b', ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']),
  ] as any[]);
  globalThis.fetch = (async (url: string) => {
    if (!String(url).startsWith('https://financialmodelingprep.com/')) return realFetch(url);
    const s = new URL(String(url)).searchParams.get('symbol') ?? '';
    return new Response(
      JSON.stringify(['AAA', 'BBB', 'CCC'].includes(s) ? [{ symbol: s, date: '2026-11-03', close: 1 }] : []),
      {
        status: 200,
      },
    );
  }) as typeof fetch;
  for (const [name, input] of [
    ['pl_prices', 'pl_eod'],
    ['pl_prices_b', 'pl_eod_b'],
  ])
    await T.createTransform(owner, {
      name,
      code: 'import oh\n',
      inputs: [input],
      outputs: [{ collection: `${name}_out`, key: ['symbol', 'date'], known_at_field: 'known_at' }],
      incremental: { mode: 'date_range', lookback_days: 0 },
    });
  weekly = (await P.createPipeline(owner, { name: 'weekly', period: 'week', nodes: graph(false) }))._id;
  gated = (await P.createPipeline(owner, { name: 'weekly-gated', period: 'week', nodes: graph(true) }))._id;
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
      'transforms',
      'transform_versions',
      'transform_runs',
      'pipelines',
      'pipeline_runs',
      'pipeline_node_executions',
    ])
      await collection<any>(c).deleteMany({ ownerId: o });
    await mongo.db(workspaceDatabase(o)).dropDatabase();
  }
  await mongo.close();
});

/** Tick the dispatcher (this owner only) until `done` or the timeout. */
async function until(done: () => Promise<boolean>, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await E.dispatchPipelines(new Date(), { ownerId: owner });
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('timed out');
}
const runOf = async (pipelineId: string, period: string) =>
  (await E.pipelineRuns().findOne({ ownerId: owner, pipelineId, 'period.id': period }))!;
const finished = (pipelineId: string, period: string) => async () =>
  !['running', 'queued'].includes((await runOf(pipelineId, period)).status);
const syncRuns = (syncId: string) => datasetSyncRuns().countDocuments({ ownerId: owner, syncId });

test(
  'a weekly run: L1 -> L2 -> L3 -> L5 in order; a 60% sync fails its gate and blocks downstream; shared nodes run once',
  { skip: skipReason },
  async () => {
    await E.startPipelineRun(owner, weekly, { period: '2026-W45' });
    await E.startPipelineRun(owner, gated, { period: '2026-W45' });
    await until(async () => (await finished(weekly, '2026-W45')()) && (await finished(gated, '2026-W45')()));

    const run = await runOf(weekly, '2026-W45');
    assert.equal(run.status, 'succeeded', JSON.stringify(run.nodes, null, 1));
    const n = run.nodes;
    for (const [down, up] of [
      ['prices', 'eod'],
      ['prices_b', 'eod_b'],
      ['research', 'prices'],
      ['research', 'prices_b'],
      ['live', 'research'],
    ])
      assert.ok(n[down].startedAt! >= n[up].finishedAt!, `${down} started after ${up} finished`);
    assert.deepEqual(n.eod.gate, [{ name: 'symbol coverage', value: 100, threshold: '≥ 95%', pass: true }]);
    assert.deepEqual(n.prices.stats, { written: 7, rows: 7, dq: 0 });
    const [tr] = await transformRuns().find({ ownerId: owner, transformName: 'pl_prices' }).toArray();
    assert.deepEqual(
      [tr.trigger, tr.window?.start, tr.window?.end],
      ['pipeline', '2026-11-02', '2026-11-08'],
      "the period is the transform's window",
    );

    const g = (await runOf(gated, '2026-W45')).nodes;
    assert.equal(g.eod_b.status, 'gate_failed');
    assert.equal(g.eod_b.gate![0].value, 60);
    assert.deepEqual(
      [g.prices_b.status, g.research.status, g.live.status],
      ['blocked', 'blocked', 'blocked'],
    );
    assert.equal(g.prices.status, 'succeeded');
    assert.equal((await runOf(gated, '2026-W45')).status, 'failed');

    // Both pipelines share the four L1/L2 nodes for W45: each executed once.
    assert.equal(await syncRuns(`${owner}-a`), 1);
    assert.equal(await syncRuns(`${owner}-b`), 1);
    assert.equal(await transformRuns().countDocuments({ ownerId: owner, transformName: 'pl_prices' }), 1);
    assert.equal(calls.filter((c) => c.type === 'research' && c.period === '2026-W45').length, 1);
  },
);

test(
  're-run from here re-runs only the downstream nodes; retry after fixing the data unblocks',
  { skip: skipReason },
  async () => {
    const before = await transformRuns().countDocuments({ ownerId: owner, transformName: 'pl_prices' });
    const r = await runOf(weekly, '2026-W45');
    await E.rerunFrom(owner, r._id, 'prices_b');
    await until(finished(weekly, '2026-W45'));
    const after = await runOf(weekly, '2026-W45');
    assert.equal(after.status, 'succeeded');
    assert.equal(
      await transformRuns().countDocuments({ ownerId: owner, transformName: 'pl_prices' }),
      before,
      'prices untouched',
    );
    assert.equal(
      await transformRuns().countDocuments({ ownerId: owner, transformName: 'pl_prices_b' }),
      2,
      'prices_b ran again',
    );
    assert.equal(after.nodes.prices_b.generation, 1);
    assert.equal(after.nodes.eod.generation, 0);
    assert.equal(await syncRuns(`${owner}-a`), 1, 'upstream syncs did not re-run');
    assert.equal(calls.filter((c) => c.type === 'research' && c.period === '2026-W45').length, 2);

    // The gated run: skip the failing gate's node with a reason; its blocked downstream runs.
    const gr = await runOf(gated, '2026-W45');
    await assert.rejects(E.retryNode(owner, gr._id, 'prices'), /Only failed or blocked/);
    await E.skipNode(owner, gr._id, 'eod_b', 'Coverage accepted for this week');
    await until(finished(gated, '2026-W45'));
    const g = (await runOf(gated, '2026-W45')).nodes;
    assert.deepEqual(
      [g.eod_b.status, g.prices_b.status, g.live.status],
      ['skipped', 'succeeded', 'succeeded'],
    );
    assert.equal(g.eod_b.reason, 'Coverage accepted for this week');
  },
);

test('a restart mid-run resumes without re-running completed nodes', { skip: skipReason }, async () => {
  const { run } = await E.startPipelineRun(owner, weekly, { period: '2026-W46' });
  // Run until both syncs are done, then "restart": nothing is kept in memory except what is in MongoDB.
  await until(async () => {
    const n = (await runOf(weekly, '2026-W46')).nodes;
    return n.eod.status === 'succeeded' && n.eod_b.status === 'succeeded';
  });
  const syncsBefore = [await syncRuns(`${owner}-a`), await syncRuns(`${owner}-b`)];
  await E.pipelineRuns().updateOne({ _id: run._id }, { $set: { 'nodes.prices.status': 'pending' } }); // as if interrupted before starting
  await until(finished(weekly, '2026-W46'));
  assert.equal((await runOf(weekly, '2026-W46')).status, 'succeeded');
  assert.deepEqual(
    [await syncRuns(`${owner}-a`), await syncRuns(`${owner}-b`)],
    syncsBefore,
    'the syncs were not re-run',
  );
  assert.equal(
    await transformRuns().countDocuments({
      ownerId: owner,
      transformName: 'pl_prices',
      'window.start': '2026-11-09',
    }),
    1,
    'the shared execution of prices for W46 was reused, not repeated',
  );
});

test('a backfill over 4 past weeks produces 4 complete runs in order', { skip: skipReason }, async () => {
  const { queued } = await E.backfillPipeline(owner, weekly, { from: '2026-W41', to: '2026-W44' });
  assert.deepEqual(
    queued.map((q) => q.period.id),
    ['2026-W41', '2026-W42', '2026-W43', '2026-W44'],
  );
  await until(
    async () =>
      (await E.pipelineRuns().countDocuments({
        ownerId: owner,
        backfillId: queued[0].backfillId,
        status: { $in: ['queued', 'running'] },
      })) === 0,
    120000,
  );
  const runs = await E.pipelineRuns()
    .find({ ownerId: owner, backfillId: queued[0].backfillId })
    .sort({ 'period.start': 1 })
    .toArray();
  assert.deepEqual(
    runs.map((r) => r.status),
    ['succeeded', 'succeeded', 'succeeded', 'succeeded'],
  );
  for (let i = 1; i < runs.length; i++)
    assert.ok(runs[i].startedAt! >= runs[i - 1].finishedAt!, 'one at a time, oldest first');
  const research = calls
    .filter((c) => c.type === 'research' && /W4[1-4]/.test(c.period))
    .map((c) => c.period);
  assert.deepEqual(research, ['2026-W41', '2026-W42', '2026-W43', '2026-W44']);
});

test('validation and the YAML round trip (kind Pipeline)', { skip: skipReason }, async () => {
  await assert.rejects(
    P.createPipeline(owner, {
      name: 'bad',
      nodes: [
        { id: 'a', ref: 'transform:pl_prices', after: ['b'] },
        { id: 'b', ref: 'transform:pl_prices_b', after: ['a'] },
      ],
    }),
    /Cycle: a → b → a/,
  );
  await assert.rejects(
    P.createPipeline(owner, { name: 'bad2', nodes: [{ id: 'a', ref: 'sync:Nope' }] }),
    /no dataset sync named "Nope"/,
  );
  const { warnings } = await P.pipelineProblems(
    owner,
    P.pipelineInputSchema.parse({ name: 'w', nodes: [{ id: 'p', ref: 'transform:pl_prices' }] }),
  );
  assert.match(warnings.join(' '), /reads pl_eod, produced by sync:EOD, which is not upstream/);
  const suggested = await P.suggestPipelineNodes(owner, ['pl_prices']);
  assert.deepEqual(
    suggested.map((n) => [n.id, n.ref, n.after]),
    [
      ['pl_prices', 'transform:pl_prices', ['sync_eod']],
      ['sync_eod', 'sync:EOD', []],
    ],
  );

  // Export the syncs, transforms and pipelines; import into an empty workspace; export again: identical.
  const kinds = ['DatasetSync', 'Transform', 'Pipeline'] as const;
  const { yaml } = await exportObjects(owner, [...kinds]);
  assert.match(yaml, /kind: Pipeline\nmetadata:\n  name: weekly\n/);
  await collection<any>('connections').insertOne({
    _id: randomUUID(),
    ownerId: owner2,
    name: 'FMP',
    kind: 'mcp',
    enabled: true,
    url: 'https://x.test/mcp',
  });
  const r = await applyObjectImport(who(owner2), yaml, 'merge');
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal((await exportObjects(owner2, [...kinds])).yaml, yaml, 'identical round trip');
});
