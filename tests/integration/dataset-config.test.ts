// Real-MongoDB test of dataset sync YAML export/import. Needs MONGODB_URI pointing at an isolated
// test database (e.g. an `openharness-test-*` Compose project).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';

// Direct-database tests: they need their own throwaway MongoDB (scripts/test-stack.sh starts one as the
// `mongo-direct` service of the isolated test project). Skipped when it is not provided.
const DIRECT_MONGO = process.env.TEST_DIRECT_MONGODB_URI;
const skipReason = DIRECT_MONGO ? undefined : 'set TEST_DIRECT_MONGODB_URI (scripts/test-stack.sh does)';
if (DIRECT_MONGO) {
  process.env.MONGODB_URI = DIRECT_MONGO;
  process.env.MONGODB_DATABASE = 'agentic_direct_test';
}
process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { mongo, collection } = await import('../../packages/core/src/db.js');
const { datasetSyncs } = await import('../../packages/core/src/datasetSync.js');
const { exportDatasetSyncConfig, planDatasetSyncImport, applyDatasetSyncImport } =
  await import('../../packages/core/src/datasetSyncConfig.js');

const source = `cfg-src-${randomUUID()}`;
const target = `cfg-dst-${randomUUID()}`;
const schedule = { enabled: true, everyMinutes: 1440, at: '18:30', input: 'daily', timezone: 'UTC' };
const conns = () => collection<Record<string, any>>('connections');
const sync = (id: string, ownerId: string, name: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  ownerId,
  name,
  enabled: true,
  connectionId: `${ownerId}-fmp`,
  dataset: 'eod_prices',
  symbolsMode: 'universe' as const,
  schedule,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});
let exported = '';

before(async () => {
  if (!DIRECT_MONGO) return;
  await mongo.connect();
  // Same connection *name* on both installs, different ids: refs must resolve by name.
  await conns().insertMany([
    {
      _id: `${source}-fmp`,
      ownerId: source,
      name: 'FMP',
      kind: 'mcp',
      enabled: true,
      url: 'https://x/?apikey=k',
    },
    {
      _id: `${target}-fmp`,
      ownerId: target,
      name: 'FMP',
      kind: 'mcp',
      enabled: true,
      url: 'https://x/?apikey=k',
    },
  ]);
  await datasetSyncs().insertMany([
    sync('s1', source, 'EOD prices', { from: '2021-01-01', cursor: '2026-11-01', lastRows: 99 }),
    sync('s2', source, 'Rates', { dataset: 'treasury_rates', targetCollection: 'my_rates', enabled: false }),
    sync('s3', source, 'Tech list', { symbolsMode: 'list', symbols: ['AAPL', 'MSFT'] }),
    // Target already has one matching name (with a cursor to keep) and one extra.
    sync('t1', target, 'EOD prices', { from: '2020-01-01', cursor: '2026-10-15' }),
    sync('t2', target, 'Old sync'),
  ]);
});
after(async () => {
  if (!DIRECT_MONGO) return;
  await datasetSyncs().deleteMany({ ownerId: { $in: [source, target] } });
  await conns().deleteMany({ ownerId: { $in: [source, target] } });
  await mongo.close();
});

test(
  'export writes YAML config with connection names and no server state',
  { skip: skipReason },
  async () => {
    const { yaml, count } = await exportDatasetSyncConfig(source);
    exported = yaml;
    assert.equal(count, 3);
    const doc = parse(yaml);
    assert.equal(doc.kind, 'DatasetSyncs');
    assert.deepEqual(
      doc.syncs.map((s: any) => s.name),
      ['EOD prices', 'Rates', 'Tech list'],
    );
    assert.ok(doc.syncs.every((s: any) => s.connection === 'FMP' && !('connectionId' in s)));
    for (const banned of ['_id', 'id', 'ownerId', 'cursor', 'lastRows', 'createdAt', 'nextRunAt'])
      assert.ok(!yaml.includes(`${banned}:`), `${banned} must not be exported`);
    const subset = parse((await exportDatasetSyncConfig(source, ['s2'])).yaml);
    assert.deepEqual(
      subset.syncs.map((s: any) => s.name),
      ['Rates'],
    );
  },
);

test(
  'merge preview then apply: creates, updates by name, keeps cursor, resolves connection',
  { skip: skipReason },
  async () => {
    const plan = await planDatasetSyncImport(target, exported, 'merge');
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.create.map((c) => c.name).sort(), ['Rates', 'Tech list']);
    assert.deepEqual(
      plan.update.map((u) => [u.name, u.changed]),
      [['EOD prices', ['from']]],
    );
    assert.deepEqual(plan.remove, []);
    assert.equal(await datasetSyncs().countDocuments({ ownerId: target }), 2, 'preview writes nothing');

    const r = await applyDatasetSyncImport(target, exported, 'merge', 'u1');
    assert.equal(r.applied, true);
    const docs = await datasetSyncs().find({ ownerId: target }).toArray();
    const by = Object.fromEntries(docs.map((d) => [d.name, d]));
    assert.equal(docs.length, 4);
    assert.equal(by['EOD prices']._id, 't1');
    assert.equal(by['EOD prices'].from, '2021-01-01');
    assert.equal(by['EOD prices'].cursor, '2026-10-15', 'update keeps the cursor');
    assert.equal(by['Rates'].connectionId, `${target}-fmp`, 'connection resolved by name on the target');
    assert.equal(by['Rates'].enabled, false);
    assert.equal(by['Rates'].targetCollection, 'my_rates');
    assert.deepEqual(by['Tech list'].symbols, ['AAPL', 'MSFT']);
    assert.ok(by['Old sync'], 'merge keeps syncs not in the file');

    const again = await planDatasetSyncImport(target, exported, 'merge');
    assert.equal(again.unchanged.length, 3, 're-importing the same file is a no-op');
    assert.equal(again.create.length + again.update.length, 0);
  },
);

test('replace removes syncs that are not in the file', { skip: skipReason }, async () => {
  const r = await applyDatasetSyncImport(target, exported, 'replace');
  assert.equal(r.applied, true);
  assert.deepEqual(
    r.plan.remove.map((x) => x.name),
    ['Old sync'],
  );
  assert.deepEqual((await datasetSyncs().find({ ownerId: target }).toArray()).map((d) => d.name).sort(), [
    'EOD prices',
    'Rates',
    'Tech list',
  ]);
});

test('any error blocks the whole import', { skip: skipReason }, async () => {
  const before = await datasetSyncs().countDocuments({ ownerId: target });
  const bad = `syncs:
  - { name: New one, dataset: eod_index, connection: FMP, schedule: { enabled: true, everyMinutes: 60, input: x } }
  - { name: Broken, dataset: eod_index, connection: Nope, schedule: { enabled: true, everyMinutes: 60, input: x } }
`;
  const r = await applyDatasetSyncImport(target, bad, 'replace');
  assert.equal(r.applied, false);
  assert.deepEqual(
    r.plan.errors.map((e) => [e.index, e.name]),
    [[1, 'Broken']],
  );
  assert.match(r.plan.errors[0].message, /No connection named "Nope"/);
  assert.equal(await datasetSyncs().countDocuments({ ownerId: target }), before);
  assert.equal(await datasetSyncs().countDocuments({ ownerId: target, name: 'New one' }), 0);
});

test('a file without connection names uses the workspace FMP connection', { skip: skipReason }, async () => {
  const r = await applyDatasetSyncImport(
    target,
    'syncs:\n  - { name: Default conn, dataset: eod_index, schedule: { enabled: true, everyMinutes: 60, input: x } }\n',
    'merge',
  );
  assert.equal(r.applied, true);
  assert.equal(
    (await datasetSyncs().findOne({ ownerId: target, name: 'Default conn' }))!.connectionId,
    `${target}-fmp`,
  );
});
