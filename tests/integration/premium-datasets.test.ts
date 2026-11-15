// Premium plan datasets (#387) against real MongoDB (TEST_DIRECT_MONGODB_URI); FMP is an in-process fake.
// The universe pages every delisted page, keeps common stock only and drops names that no longer qualify; index
// constituents drop members that left; sector history is one call per sector and window; feeds stop paging at a
// page with nothing new; a backfill pages per-symbol history and takes its own depth.
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
const { datasetSyncs, datasetSyncRuns, runDatasetSync } =
  await import('../../packages/core/src/datasetSync.js');
const bf = await import('../../packages/core/src/datasetBackfill.js');
const { FMP_SECTORS } = await import('../../packages/core/src/datasetCatalog.js');

const owner = `prem-${randomUUID()}`;
const conn = randomUUID();
const realFetch = globalThis.fetch;
const db = () => mongo.db(workspaceDatabase(owner));
const seen: URL[] = [];
const state = {
  activeCount: 600, // above the pruning guard
  sp500: ['AAPL', 'MSFT', 'KVUE'],
  newsPages: 0,
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const sync = (id: string, dataset: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  ownerId: owner,
  connectionId: conn,
  name: id,
  enabled: true,
  dataset,
  symbolsMode: 'universe',
  schedule: { enabled: false, everyMinutes: 1440, input: 'x' },
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});
const run = async (id: string) => {
  const s = (await datasetSyncs().findOne({ _id: id }))!;
  await runDatasetSync(s, { trigger: 'manual' });
  return (await datasetSyncRuns().find({ syncId: id }).sort({ startedAt: -1 }).limit(1).next())!;
};

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
    sync('uni', 'universe'),
    sync('idx', 'index_constituents'),
    sync('sec', 'sector_performance'),
    sync('news', 'news_stocks'),
    sync('ins', 'insider_trades_history', { symbolsMode: 'list', symbols: ['AAPL', 'TINY'] }),
    sync('km', 'key_metrics_quarterly', { symbolsMode: 'list', symbols: ['AAPL'] }),
    sync('prof', 'company_profiles'),
  ] as any[]);
  globalThis.fetch = (async (url: string) => {
    if (!String(url).startsWith('https://financialmodelingprep.com/')) return realFetch(url);
    const u = new URL(String(url));
    seen.push(u);
    const p = (k: string) => u.searchParams.get(k);
    const path = u.pathname.replace('/stable/', '');
    if (path === 'company-screener')
      return json([
        ...Array.from({ length: state.activeCount }, (_, i) => ({
          symbol: `A${i}`,
          exchangeShortName: 'NYSE',
        })),
        { symbol: 'AAPL', exchangeShortName: 'NASDAQ', marketCap: 4e12 },
        { symbol: 'ACHRW', exchangeShortName: 'NYSE' }, // a warrant
        { symbol: 'CFR-PB', exchangeShortName: 'NYSE' }, // a preferred
      ]);
    if (path === 'delisted-companies') {
      const page = Number(p('page'));
      // Three pages, then an empty one: the list was read to its end.
      if (page > 2) return json([]);
      return json([
        { symbol: `D${page}`, exchange: 'NASDAQ', delistedDate: `2022-0${page + 1}-01` },
        { symbol: `X${page}.L`, exchange: 'LSE', delistedDate: '2022-01-01' }, // foreign
        { symbol: `DLS${'ABC'[page]}U`, exchange: 'NASDAQ', delistedDate: '2022-01-01' }, // a unit (5 letters, U)
      ]);
    }
    if (path === 'sp500-constituent') return json(state.sp500.map((symbol) => ({ symbol })));
    if (path === 'nasdaq-constituent') return json([{ symbol: 'AAPL' }]);
    if (path === 'dowjones-constituent') return json([{ symbol: 'MSFT' }]);
    if (path === 'historical-sector-performance')
      return json([{ date: p('to'), sector: p('sector'), exchange: 'NASDAQ', averageChange: 0.1 }]);
    if (path === 'news/stock-latest') {
      state.newsPages++;
      const page = Number(p('page'));
      // Pages 0-1 are new; page 2 repeats page 1 (already stored), so paging stops there.
      const at = Math.min(page, 1);
      return json(
        Array.from({ length: 3 }, (_, i) => ({
          symbol: 'AAPL',
          publishedDate: `2026-11-1${at} 0${i}:00:00`,
          title: `t${at}-${i}`,
        })),
      );
    }
    if (path === 'insider-trading/search') {
      const page = Number(p('page'));
      const limit = Number(p('limit'));
      // AAPL: two full pages and a short third; TINY: one short page.
      const n = p('symbol') === 'AAPL' ? (page < 2 ? limit : 3) : page === 0 ? 2 : 0;
      return json(
        Array.from({ length: n }, (_, i) => ({
          symbol: p('symbol'),
          filingDate: `20${10 + page}-01-0${(i % 9) + 1}`,
          transactionDate: `20${10 + page}-01-0${(i % 9) + 1}`,
          reportingCik: String(i),
          transactionType: 'S-Sale',
          price: i,
        })),
      );
    }
    if (path === 'key-metrics')
      return json(
        Array.from({ length: Number(p('limit')) }, (_, i) => ({
          symbol: 'AAPL',
          date: `${2026 - Math.floor(i / 4)}-0${(i % 4) * 3 + 1}-01`,
          period: `Q${(i % 4) + 1}`,
        })),
      );
    return json([]);
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  if (!DIRECT_MONGO) return;
  await datasetSyncs().deleteMany({ ownerId: owner });
  await datasetSyncRuns().deleteMany({ ownerId: owner });
  await bf.backfills().deleteMany({ ownerId: owner });
  await collection<any>('connections').deleteMany({ ownerId: owner });
  await collection<any>('dataset_catalog').deleteMany({ ownerId: owner });
  await db().dropDatabase();
  await mongo.close();
});

test(
  'universe: every delisted page, US equity only, sticky, junk removed',
  { skip: skipReason },
  async () => {
    // Leftovers from an earlier, broader universe: a foreign listing and exchange-traded debt (junk), and a real
    // second share class the screener no longer returns (sticky).
    await db()
      .collection('universe')
      .insertMany([
        { symbol: '0HMG.L', exchange: 'LSE', is_delisted: true },
        {
          symbol: 'DTB',
          companyName: 'DTE Energy Company 2020 Series',
          exchange: 'NYSE',
          is_delisted: false,
        },
        { symbol: 'FOXA', companyName: 'Fox Corporation', exchange: 'NASDAQ', is_delisted: false },
      ]);
    // A trading profile we hold for a name that is not in the universe comes back; a fund's does not.
    await db()
      .collection('company_profiles')
      .insertMany([
        { symbol: 'NWSA', companyName: 'News Corporation', exchange: 'NASDAQ', isActivelyTrading: true },
        { symbol: 'BXSL', companyName: 'Blackstone Secured Lending Fund', exchange: 'NYSE', isFund: true },
      ]);
    const r = await run('uni');
    assert.equal(r.status, 'succeeded', r.error);
    const screener = seen.find((u) => u.pathname.endsWith('/company-screener'))!;
    assert.equal(screener.searchParams.get('marketCapMoreThan'), '300000000');
    assert.equal(
      seen.filter((u) => u.pathname.endsWith('/delisted-companies')).length,
      4,
      'paged to the end',
    );
    const syms = new Set((await db().collection('universe').distinct('symbol')) as string[]);
    for (const s of ['AAPL', 'D0', 'D1', 'D2', 'A0', 'FOXA', 'NWSA']) assert.ok(syms.has(s), s);
    for (const s of ['ACHRW', 'CFR-PB', 'X0.L', 'DLSAU', '0HMG.L', 'DTB', 'BXSL']) assert.ok(!syms.has(s), s);
    assert.equal(syms.size, state.activeCount + 1 + 3 + 2);
    assert.equal((r as any).removed, 2, 'the foreign listing and the debt');
    // US only: the foreign delisted rows are not stored.
    assert.equal(await db().collection('delisted_companies').countDocuments(), 6);
    assert.equal(await db().collection('delisted_companies').countDocuments({ exchange: 'LSE' }), 0);
  },
);

test('universe: a name the screener stops returning stays (sticky)', { skip: skipReason }, async () => {
  state.activeCount = 10;
  const before = await db().collection('universe').countDocuments();
  const r = await run('uni');
  assert.equal(r.status, 'succeeded', r.error);
  assert.equal(await db().collection('universe').countDocuments(), before, 'nothing removed');
  state.activeCount = 600;
});

test(
  'index constituents: tagged per index; members that left are removed',
  { skip: skipReason },
  async () => {
    await run('idx');
    const rows = await db()
      .collection('index_constituents')
      .find({}, { projection: { _id: 0, index: 1, symbol: 1 } })
      .toArray();
    assert.deepEqual(rows.map((r) => `${r.index}:${r.symbol}`).sort(), [
      'dji:MSFT',
      'ndx:AAPL',
      'sp500:AAPL',
      'sp500:KVUE',
      'sp500:MSFT',
    ]);
    state.sp500 = ['AAPL', 'MSFT', 'OKTA']; // KVUE replaced by OKTA
    const r = await run('idx');
    assert.equal((r as any).removed, 1);
    assert.deepEqual(
      (
        (await db().collection('index_constituents').distinct('symbol', { index: 'sp500' })) as string[]
      ).sort(),
      ['AAPL', 'MSFT', 'OKTA'],
    );
  },
);

test(
  'sector performance: one call per sector for the rolling window, then a backfill',
  { skip: skipReason },
  async () => {
    seen.length = 0;
    await run('sec');
    const calls = seen.filter((u) => u.pathname.endsWith('/historical-sector-performance'));
    assert.deepEqual(calls.map((u) => u.searchParams.get('sector')).sort(), [...FMP_SECTORS].sort());
    assert.equal(await db().collection('sector_performance').countDocuments(), FMP_SECTORS.length);
    seen.length = 0;
    const job = await bf.createBackfill(owner, 'sec', {
      from: '2016-01-01',
      to: '2026-11-14',
      autostart: false,
    });
    assert.equal(job.mode, 'windows');
    await bf.backfills().updateOne({ _id: job._id }, { $set: { status: 'running' } });
    await bf.runBackfill((await bf.backfills().findOne({ _id: job._id }))!);
    const done = (await bf.backfills().findOne({ _id: job._id }))!;
    assert.equal(done.status, 'completed', done.lastError);
    assert.equal(done.calls, job.batches.length * FMP_SECTORS.length);
  },
);

test('feeds page until a page brings nothing new', { skip: skipReason }, async () => {
  state.newsPages = 0;
  await run('news');
  assert.equal(state.newsPages, 3, 'pages 0 and 1 are new, page 2 repeats page 1');
  assert.equal(await db().collection('news_stocks').countDocuments(), 6);
  state.newsPages = 0;
  await run('news');
  assert.equal(state.newsPages, 1, 'nothing new on page 0: stop');
});

test(
  'backfill: paged per-symbol history into the feed collection, and its own depth',
  { skip: skipReason },
  async () => {
    const job = await bf.createBackfill(owner, 'ins', { historyPeriods: 50, autostart: false });
    await bf.backfills().updateOne({ _id: job._id }, { $set: { status: 'running' } });
    await bf.runBackfill((await bf.backfills().findOne({ _id: job._id }))!);
    const done = (await bf.backfills().findOne({ _id: job._id }))!;
    assert.equal(done.status, 'completed', done.lastError);
    // AAPL: pages 0, 1 (full, 50 each) and 2 (short) = 3 calls; TINY: one short page.
    assert.equal(done.calls, 4);
    const pages = seen.filter((u) => u.pathname.endsWith('/insider-trading/search'));
    assert.ok(pages.every((u) => u.searchParams.get('limit') === '50'));
    assert.equal(await db().collection('insider_trades').countDocuments({ symbol: 'AAPL' }), 50 + 50 + 3);
    // The weekly run keeps its own small depth: 8 quarters; the backfill asked for 48.
    seen.length = 0;
    await run('km');
    assert.equal(seen.find((u) => u.pathname.endsWith('/key-metrics'))!.searchParams.get('limit'), '8');
    const kb = await bf.createBackfill(owner, 'km', { historyPeriods: 48, autostart: false });
    await bf.backfills().updateOne({ _id: kb._id }, { $set: { status: 'running' } });
    await bf.runBackfill((await bf.backfills().findOne({ _id: kb._id }))!);
    assert.equal(await db().collection('key_metrics_quarterly').countDocuments(), 48);
    assert.equal(
      (await datasetSyncs().findOne({ _id: 'km' }))!.historyPeriods,
      undefined,
      'sync depth untouched',
    );
  },
);

test(
  'routine runs skip names delisted long ago; backfills include them (#398)',
  { skip: skipReason },
  async () => {
    // The universe from the tests above: D0-D2 were delisted in 2022; add one delisted last week.
    const recent = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    await db()
      .collection('universe')
      .insertOne({ symbol: 'JUSTGONE', exchange: 'NYSE', is_delisted: true, delisted_date: recent });
    const all = await db().collection('universe').countDocuments();
    const r = await run('prof');
    assert.equal(r.status, 'succeeded', r.error);
    assert.equal(r.symbolsAttempted, all - 3, 'D0, D1, D2 skipped; JUSTGONE still pulled');
    const job = await bf.createBackfill(owner, 'ins', { autostart: false });
    assert.equal(job.symbols!.length, 2, 'list mode is untouched');
    const kb = await bf.createBackfill(owner, 'sec', { from: '2026-01-01', autostart: false });
    assert.equal(kb.mode, 'windows');
    await bf.backfills().deleteMany({ _id: { $in: [job._id, kb._id] } });
    const uni = await datasetSyncs().findOne({ _id: 'prof' });
    const pb = await bf.createBackfill(owner, uni!._id, { autostart: false }).catch((e) => e);
    // company_profiles has no history to backfill; use a limit-based dataset for the universe check.
    assert.match(String(pb?.message ?? ''), /history/i);
    await datasetSyncs().insertOne(sync('div', 'dividends_history') as any);
    const db2 = await bf.createBackfill(owner, 'div', { autostart: false });
    assert.equal(db2.symbols!.length, all, 'a backfill pulls every name once, the long-dead ones included');
  },
);
