// Schema Catalog v1 (#84) against real MongoDB (TEST_DIRECT_MONGODB_URI).
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
const { refreshCatalog, listCatalog, patchCatalogEntry, catalogEntries } =
  await import('../../packages/core/src/schemaCatalog.js');
const { exportObjects, planObjectImport, applyObjectImport } = await import('../../apps/api/src/objects.js');

const A = `cat-a-${randomUUID()}`;
const B = `cat-b-${randomUUID()}`;
const who = (t: string) => ({ tenantId: t, user: { _id: 'u', role: 'admin' } }) as any;
const ws = (o: string) => mongo.db(workspaceDatabase(o));
const sched = { enabled: true, everyMinutes: 1440, at: '18:49', input: 'x', timezone: 'America/New_York' };

before(async () => {
  if (!DIRECT_MONGO) return;
  await mongo.connect();
  for (const o of [A, B])
    await collection<any>('dataset_syncs').insertMany([
      {
        _id: `${o}-eod`,
        ownerId: o,
        name: 'EOD prices',
        enabled: true,
        connectionId: 'c',
        dataset: 'eod_prices',
        symbolsMode: 'universe',
        schedule: sched,
        lastRunAt: new Date('2026-11-03T23:00:00Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: `${o}-prof`,
        ownerId: o,
        name: 'Profiles',
        enabled: true,
        connectionId: 'c',
        dataset: 'company_profiles',
        symbolsMode: 'universe',
        schedule: sched,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: `${o}-ins`,
        ownerId: o,
        name: 'Insiders',
        enabled: true,
        connectionId: 'c',
        dataset: 'insider_trades',
        symbolsMode: 'universe',
        schedule: sched,
        lastError: 'FMP 429',
        lastRunAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
  const db = ws(A);
  await db
    .collection('universe')
    .insertMany([{ symbol: 'AAPL' }, { symbol: 'MSFT' }, { symbol: 'NVDA' }, { symbol: 'AMZN' }]);
  await db.collection('eod_prices').insertMany([
    { symbol: 'AAPL', date: '2021-10-25', close: 148.6, volume: 1, _syncedAt: new Date() },
    { symbol: 'AAPL', date: '2026-10-23', close: 347.73, volume: 39323315, _syncedAt: new Date() },
    { symbol: 'MSFT', date: '2026-10-23', close: 512.1, volume: 2, _syncedAt: new Date() },
  ]);
  await db.collection('company_profiles').insertOne({ symbol: 'AAPL', sector: 'Technology', beta: 1.1 });
  await db.collection('fin_income').insertOne({ symbol: 'ZZZ', date: '2025-05-31', netIncome: 1 });
  await db.collection('prices_daily').insertOne({
    security_id: 'SEC_000008',
    date: '2026-10-23',
    adj_close: 347.73,
    known_at: '2026-10-23T20:00:00Z',
    as_of_date: '2026-10-23',
  });
});
after(async () => {
  if (!DIRECT_MONGO) return;
  await collection<any>('dataset_syncs').deleteMany({ ownerId: { $in: [A, B] } });
  await catalogEntries().deleteMany({ ownerId: { $in: [A, B] } });
  for (const o of [A, B]) await ws(o).dropDatabase();
  await mongo.close();
});

test(
  'every collection and every sync target gets an entry, with layer, PIT status and coverage',
  { skip: skipReason },
  async () => {
    const n = await refreshCatalog(A);
    const by = Object.fromEntries((await listCatalog(A)).map((e) => [e.collection, e]));
    assert.equal(n, Object.keys(by).length);
    assert.ok(by.insider_trades, 'an empty sync target still has an entry');
    const eod = by.eod_prices;
    assert.equal(eod.layer, 1);
    assert.equal(eod.timeSemantics.status, 'pit');
    assert.match(eod.timeSemantics.text, /16:00 ET close/);
    assert.deepEqual(eod.primaryKey, ['symbol', 'date']);
    assert.deepEqual(
      [eod.coverage.rows, eod.coverage.symbols, eod.coverage.dateMin, eod.coverage.dateMax],
      [3, 2, '2021-10-25', '2026-10-23'],
    );
    assert.equal(eod.coverage.universeCoveragePct, 50);
    assert.equal(eod.producedBy[0].name, 'EOD prices');
    assert.ok(eod.freshness.cadence && eod.freshness.lastStatus === 'ok');
    assert.equal(eod.fields.find((f) => f.name === 'close')!.unit, 'USD');
    assert.equal(by.company_profiles.timeSemantics.status, 'current_only');
    assert.equal(by.insider_trades.freshness.lastStatus, 'failed');
    assert.equal(by.fin_income.layer, null, 'leftover collection: no producer');
    assert.equal(by.fin_income.timeSemantics.status, 'unknown');
    assert.equal(by.prices_daily.layer, 2);
    assert.equal(by.prices_daily.producedBy[0].type, 'pipeline');
  },
);

test('curated docs survive refreshes and round-trip as CatalogEntry YAML', { skip: skipReason }, async () => {
  await patchCatalogEntry(A, 'eod_prices', {
    description: 'Raw EOD bars from FMP (unadjusted).',
    fields: { vwap: { description: 'FMP-computed VWAP', unit: 'USD' } },
  });
  await refreshCatalog(A);
  const e = (await catalogEntries().findOne({ ownerId: A, collection: 'eod_prices' }))!;
  assert.equal(e.description, 'Raw EOD bars from FMP (unadjusted).');
  const { yaml } = await exportObjects(A, ['CatalogEntry']);
  assert.match(yaml, /kind: CatalogEntry\nmetadata:\n  name: eod_prices/);
  assert.ok(!/\b(rows|null_pct|refreshedAt|coverage):/.test(yaml), 'only curated content is exported');
  const plan = await planObjectImport(who(B), yaml, 'merge');
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(
    plan.items.map((i) => `${i.kind}:${i.name}:${i.action}`),
    ['CatalogEntry:eod_prices:create'],
  );
  assert.equal((await applyObjectImport(who(B), yaml, 'merge')).applied, true);
  const b = (await catalogEntries().findOne({ ownerId: B, collection: 'eod_prices' }))!;
  assert.equal(b.description, 'Raw EOD bars from FMP (unadjusted).');
  assert.equal((await exportObjects(B, ['CatalogEntry'])).yaml, yaml, 'identical round trip');
  assert.ok((await planObjectImport(who(B), yaml, 'merge')).items.every((i) => i.action === 'unchanged'));
});

test(
  'caveats: built-in plan limits, live dates, dismiss + custom, in the agent view and YAML',
  { skip: skipReason },
  async () => {
    const { agentView } = await import('../../packages/core/src/schemaCatalog.js');
    await ws(A)
      .collection('insider_trades')
      .insertOne({ symbol: 'UXIN', filingDate: '2026-10-22', transactionType: 'P-Purchase' });
    await refreshCatalog(A);
    const ins = (await catalogEntries().findOne({ ownerId: A, collection: 'insider_trades' }))!;
    assert.deepEqual(
      ins.caveats.map((c) => c.id),
      ['feed-history'],
    );
    const eod = (await catalogEntries().findOne({ ownerId: A, collection: 'eod_prices' }))!;
    assert.ok(eod.caveats.some((c) => c.id === 'delisted-coverage' && c.severity === 'warn'));
    assert.match(agentView(eod).text, /Caveats:\n- \[WARN\] Survivorship bias/);
    await patchCatalogEntry(A, 'eod_prices', {
      dismissedCaveats: ['delisted-coverage'],
      caveats: [{ id: 'gap-2024', severity: 'warn', text: 'Missing 2024-03-01 for 40 symbols.' }],
    });
    const after = (await catalogEntries().findOne({ ownerId: A, collection: 'eod_prices' }))!;
    assert.deepEqual(
      after.caveats.map((c) => `${c.id}:${c.source}`),
      ['gap-2024:curated'],
    );
    const { yaml } = await exportObjects(A, ['CatalogEntry']);
    assert.match(yaml, /dismissedCaveats:\n\s+- delisted-coverage/);
    assert.equal((await applyObjectImport(who(B), yaml, 'merge')).applied, true);
    const b = (await catalogEntries().findOne({ ownerId: B, collection: 'eod_prices' }))!;
    assert.deepEqual(
      b.caveats.map((c) => c.id),
      ['gap-2024'],
      'dismissals and custom caveats round-trip',
    );
  },
);
