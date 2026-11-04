// #80 backfill against real MongoDB (TEST_DIRECT_MONGODB_URI); FMP is an in-process fake.
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
process.env.DATASET_SYNC_RPM = '60000'; // fast fake FMP
const { mongo, collection } = await import('../../packages/core/src/db.js');
const { workspaceDatabase } = await import('../../packages/core/src/mongoMcp.js');
const { datasetSyncs } = await import('../../packages/core/src/datasetSync.js');
const bf = await import('../../packages/core/src/datasetBackfill.js');

const owner = `bf-${randomUUID()}`;
const conn = randomUUID();
const realFetch = globalThis.fetch;
let calls = 0;
let onCall: (() => Promise<void>) | undefined;
const symbols = Array.from({ length: 30 }, (_, i) => `T${String(i).padStart(2, '0')}`);
const db = () => mongo.db(workspaceDatabase(owner));

async function claimAndRun(id: string) {
  const job = await bf
    .backfills()
    .findOneAndUpdate(
      { _id: id, status: 'queued' },
      { $set: { status: 'running' } },
      { returnDocument: 'after' },
    );
  assert.ok(job, 'claimed');
  await bf.runBackfill(job!);
  return (await bf.backfills().findOne({ _id: id }))!;
}

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
  const base = {
    ownerId: owner,
    connectionId: conn,
    enabled: true,
    schedule: { enabled: false, everyMinutes: 1440, input: 'x' },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await datasetSyncs().insertMany([
    {
      ...base,
      _id: 'eod',
      name: 'EOD',
      dataset: 'eod_prices',
      symbolsMode: 'list',
      symbols,
      cursor: '2026-10-23',
    },
    { ...base, _id: 'earn', name: 'Earnings', dataset: 'earnings_calendar', symbolsMode: 'universe' },
    { ...base, _id: 'est', name: 'Estimates', dataset: 'analyst_estimates', symbolsMode: 'list', symbols },
  ] as any[]);
  globalThis.fetch = (async (url: string) => {
    if (!String(url).startsWith('https://financialmodelingprep.com/')) return realFetch(url);
    calls++;
    if (onCall) await onCall();
    const u = new URL(String(url));
    if (u.pathname.endsWith('/earnings-calendar'))
      return new Response(
        JSON.stringify([{ symbol: 'AAPL', date: u.searchParams.get('from'), epsActual: 1, epsEstimated: 1 }]),
        { status: 200 },
      );
    // Two bars per request: the first and last day of the requested range.
    const s = u.searchParams.get('symbol');
    return new Response(
      JSON.stringify([
        { symbol: s, date: u.searchParams.get('from'), close: 1 },
        { symbol: s, date: u.searchParams.get('to'), close: 2 },
      ]),
      { status: 200 },
    );
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  if (!DIRECT_MONGO) return;
  await datasetSyncs().deleteMany({ ownerId: owner });
  await bf.backfills().deleteMany({ ownerId: owner });
  await collection<any>('connections').deleteMany({ ownerId: owner });
  await collection<any>('dataset_catalog').deleteMany({ ownerId: owner });
  await db().dropDatabase();
  await mongo.close();
});

test(
  'a 21-year backfill: 2 ranges per symbol, every row written, the cursor untouched',
  { skip: skipReason },
  async () => {
    calls = 0;
    const job = await bf.createBackfill(owner, 'eod', {
      from: '2005-01-01',
      to: '2026-11-04',
      batchSize: 25,
      autostart: false,
    });
    assert.equal(job.batches.length, 2);
    const done = await claimAndRun(job._id);
    assert.equal(done.status, 'completed', done.lastError);
    assert.equal(calls, 60, '30 symbols × 2 ranges');
    assert.equal(done.calls, 60);
    assert.equal(await db().collection('eod_prices').countDocuments(), 120);
    assert.equal(
      (await datasetSyncs().findOne({ _id: 'eod' }))!.cursor,
      '2026-10-23',
      'incremental cursor untouched',
    );
    await assert.rejects(bf.createBackfill(owner, 'est', { autostart: false }), /snapshot/i);
  },
);

test(
  'pause then resume re-pulls nothing that was already done; a restart resumes too',
  { skip: skipReason },
  async () => {
    await db().collection('eod_prices').deleteMany({});
    calls = 0;
    const job = await bf.createBackfill(owner, 'eod', {
      from: '2016-01-01',
      to: '2026-11-04',
      batchSize: 25,
      autostart: false,
    });
    // Pause after the 7th FMP call; the run stops at its next check.
    onCall = async () => {
      if (calls === 7) await bf.backfillAction(owner, 'eod', 'pause', { autostart: false });
    };
    const paused = await claimAndRun(job._id);
    onCall = undefined;
    assert.equal(paused.status, 'paused');
    const doneSoFar = calls;
    assert.ok(doneSoFar >= 7 && doneSoFar < 30, `stopped early (${doneSoFar} calls)`);
    assert.equal(paused.batches[0].next, doneSoFar, 'resume point persisted');
    await assert.rejects(
      bf.createBackfill(owner, 'eod', { autostart: false }),
      /already queued, running or paused/,
    );
    await bf.backfillAction(owner, 'eod', 'resume', { autostart: false });
    // Simulate a crash right after it resumed: running -> the restart recovery puts it back in the queue.
    await bf.backfills().updateOne({ _id: job._id }, { $set: { status: 'running' } });
    assert.equal(await bf.recoverBackfills(), 1);
    const final = await claimAndRun(job._id);
    assert.equal(final.status, 'completed', final.lastError);
    assert.equal(calls, 30, 'every symbol fetched exactly once across pause, resume and restart');
    assert.equal(await db().collection('eod_prices').countDocuments(), 60);
  },
);

test('calendar backfill walks date windows', { skip: skipReason }, async () => {
  calls = 0;
  const job = await bf.createBackfill(owner, 'earn', {
    from: '2026-01-01',
    to: '2026-04-30',
    autostart: false,
  });
  assert.equal(job.mode, 'windows');
  const done = await claimAndRun(job._id);
  assert.equal(done.status, 'completed', done.lastError);
  assert.equal(calls, job.batches.length);
  assert.equal(await db().collection('earnings_calendar').countDocuments(), job.batches.length);
});
