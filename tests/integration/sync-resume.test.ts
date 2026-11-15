// #416 against real MongoDB (TEST_DIRECT_MONGODB_URI); FMP is an in-process fake. A per-symbol run dies after K
// symbols (its FMP call never answers, as when the process is killed); startup recovery gives it a new attempt,
// which resumes at K with the same symbol list and snapshot date: every symbol answered once, no duplicate keys.
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
process.env.SYNC_PROGRESS_EVERY = '1'; // save after every symbol
const { mongo, collection } = await import('../../packages/core/src/db.js');
const { workspaceDatabase } = await import('../../packages/core/src/mongoMcp.js');
const {
  datasetSyncs,
  datasetSyncRuns,
  runDatasetSync,
  resumeInterruptedDatasetSyncRuns,
  resumeDatasetSyncRun,
} = await import('../../packages/core/src/datasetSync.js');
const { auditDuplicates } = await import('../../scripts/duplicate-audit.js');

const owner = `resume-${randomUUID()}`;
const conn = randomUUID();
const realFetch = globalThis.fetch;
const db = () => mongo.db(workspaceDatabase(owner));
const SYMBOLS = Array.from({ length: 12 }, (_, i) => `S${String(i).padStart(2, '0')}`);
const K = 5;
const answered = new Map<string, number>();
let hangAfter: number | undefined;
let treasuryCalls = 0;

const sync = (id: string, dataset: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  ownerId: owner,
  connectionId: conn,
  name: id,
  enabled: true,
  dataset,
  symbolsMode: 'list',
  symbols: SYMBOLS,
  consecutiveFailures: 0,
  schedule: { enabled: false, everyMinutes: 1440, input: 'x' },
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});
const runsOf = (syncId: string) => datasetSyncRuns().find({ syncId }).toArray();

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
    sync('gc', 'grades_consensus'),
    sync('rates', 'treasury_rates', { symbolsMode: 'universe', symbols: undefined }),
    sync('off', 'grades_consensus', { enabled: false }),
    sync('busy', 'grades_consensus'),
  ] as any[]);
  globalThis.fetch = (async (url: string) => {
    if (!String(url).startsWith('https://financialmodelingprep.com/')) return realFetch(url);
    const u = new URL(String(url));
    if (u.pathname.endsWith('/treasury-rates')) {
      treasuryCalls++;
      return new Response(JSON.stringify([{ date: '2026-01-02', year10: 4.1 }]), { status: 200 });
    }
    const s = String(u.searchParams.get('symbol'));
    const total = [...answered.values()].reduce((a, b) => a + b, 0);
    // The process "dies": this call never answers.
    if (hangAfter !== undefined && total >= hangAfter) return new Promise<Response>(() => undefined);
    answered.set(s, (answered.get(s) ?? 0) + 1);
    return new Response(JSON.stringify([{ symbol: s, strongBuy: 2, buy: 5, hold: 3 }]), { status: 200 });
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  if (!DIRECT_MONGO) return;
  await datasetSyncs().deleteMany({ ownerId: owner });
  await datasetSyncRuns().deleteMany({ ownerId: owner });
  await collection<any>('connections').deleteMany({ ownerId: owner });
  await collection<any>('dataset_catalog').deleteMany({ ownerId: owner });
  await db().dropDatabase();
  await mongo.close();
});

test(
  'a per-symbol run interrupted after K symbols resumes at K: once per symbol, one snapshot, no duplicates',
  { skip: skipReason },
  async () => {
    hangAfter = K;
    const s = (await datasetSyncs().findOne({ _id: 'gc' }))!;
    // Attempt 1, dated 2026-01-02 (not today) so the resumed attempt must take the date from the run, not today().
    void runDatasetSync(s, { trigger: 'manual', runDate: '2026-01-02' });
    let run;
    for (let i = 0; i < 200; i++) {
      [run] = await runsOf('gc');
      if (run?.progress?.next === K) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(run?.progress?.next, K, 'attempt 1 saved its progress through symbol K');
    assert.equal(run!.status, 'running');
    assert.deepEqual(run!.progress!.symbols, SYMBOLS);

    // The server restarts: recovery plans a second attempt at K.
    hangAfter = undefined;
    const { resumed } = await resumeInterruptedDatasetSyncRuns({ enqueue: false });
    const mine = resumed.find((r) => r.runId === run!._id)!;
    assert.deepEqual({ attempt: mine.attempt, next: mine.next }, { attempt: 2, next: K });
    await resumeDatasetSyncRun(mine.runId, mine.attempt);

    const [done] = await runsOf('gc');
    assert.equal(done!.status, 'succeeded', done!.error);
    assert.equal(done!.attempt, 2);
    assert.equal(done!.interruptions?.length, 1);
    assert.equal(done!.interruptions![0]!.next, K);
    assert.equal(done!.symbolsAttempted, SYMBOLS.length);
    assert.equal(done!.symbolsCovered, SYMBOLS.length);
    assert.equal(done!.rows, SYMBOLS.length, 'rows of both attempts');
    assert.equal(done!.calls, SYMBOLS.length, 'the unanswered call of attempt 1 is not double-counted');
    assert.deepEqual(
      SYMBOLS.map((x) => answered.get(x)),
      SYMBOLS.map(() => 1),
      'each symbol answered once over both attempts',
    );
    const rows = db().collection('grades_consensus');
    assert.equal(await rows.countDocuments(), SYMBOLS.length);
    assert.deepEqual(
      await rows.distinct('snapshot_date'),
      ['2026-01-02'],
      'one snapshot, not split by the restart',
    );
    const audit = (await auditDuplicates(db())).find((r) => r.collection === 'grades_consensus')!;
    assert.deepEqual([audit.documents, audit.duplicateKeys, audit.extraDocuments], [SYMBOLS.length, 0, 0]);
    const fresh = (await datasetSyncs().findOne({ _id: 'gc' }))!;
    assert.equal(fresh.consecutiveFailures, 0, 'an interruption is not a failure');
    assert.equal(fresh.lastError, undefined);
  },
);

test(
  'a short run (market window) starts again from the beginning; a disabled sync is closed',
  { skip: skipReason },
  async () => {
    const legacy = randomUUID();
    // A run left behind by a process without #416 (no attempt, no progress).
    await datasetSyncRuns().insertOne({
      _id: legacy,
      ownerId: owner,
      syncId: 'rates',
      trigger: 'schedule',
      status: 'running',
      startedAt: new Date(Date.now() - 3600_000),
    } as any);
    const off = randomUUID();
    await datasetSyncRuns().insertOne({
      _id: off,
      ownerId: owner,
      syncId: 'off',
      trigger: 'manual',
      status: 'running',
      startedAt: new Date(),
      attempt: 1,
      progress: {
        next: 2,
        symbols: SYMBOLS,
        runDate: '2026-01-02',
        rows: 2,
        covered: 2,
        errors: 0,
        calls: 2,
      },
    } as any);
    const { resumed } = await resumeInterruptedDatasetSyncRuns({ enqueue: false });
    const r = resumed.find((x) => x.runId === legacy)!;
    assert.deepEqual({ attempt: r.attempt, next: r.next }, { attempt: 2, next: 0 });
    await resumeDatasetSyncRun(legacy, 2);
    const run = (await datasetSyncRuns().findOne({ _id: legacy }))!;
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(treasuryCalls, 1);
    assert.equal((await datasetSyncs().findOne({ _id: 'rates' }))!.consecutiveFailures, 0);
    const closed = (await datasetSyncRuns().findOne({ _id: off }))!;
    assert.equal(closed.status, 'failed');
    assert.match(closed.error!, /disabled/);
    // An attempt that was superseded cannot touch the run: attempt 1 of the resumed run matches nothing.
    const stale = await datasetSyncRuns().updateOne(
      { _id: legacy, status: 'running', attempt: 1 },
      { $set: { rows: 999 } },
    );
    assert.equal(stale.matchedCount, 0);
  },
);

test(
  'never two attempts at once: a new run of a sync with a live run returns that run',
  { skip: skipReason },
  async () => {
    const live = randomUUID();
    await datasetSyncRuns().insertOne({
      _id: live,
      ownerId: owner,
      syncId: 'busy',
      trigger: 'manual',
      status: 'running',
      startedAt: new Date(),
      attempt: 1,
      heartbeatAt: new Date(),
    } as any);
    const s = (await datasetSyncs().findOne({ _id: 'busy' }))!;
    const r = await runDatasetSync(s, { trigger: 'manual' });
    assert.equal(r._id, live);
    assert.equal((await runsOf('busy')).length, 1, 'no second run was started');
    await datasetSyncRuns().updateOne({ _id: live }, { $set: { status: 'succeeded' } });
  },
);
