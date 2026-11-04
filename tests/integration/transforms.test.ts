// #89 Transform resource against real MongoDB (TEST_DIRECT_MONGODB_URI).
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
const T = await import('../../packages/core/src/transforms.js');
const { exportObjects, planObjectImport, applyObjectImport } = await import('../../apps/api/src/objects.js');

const A = `tr-a-${randomUUID()}`;
const B = `tr-b-${randomUUID()}`;
const who = (t: string) => ({ tenantId: t, user: { _id: 'u', role: 'admin' } }) as any;
const CODE = [
  'import oh',
  'from pipeline.layer2.prices_logic import compute_symbol_rows',
  'w = oh.window',
  'bars = oh.read_df("eod_prices", {"date": {"$gte": w.lookback_start, "$lte": w.end}})',
  'rows, issues = compute_symbol_rows(bars)',
  'oh.output("prices_daily").upsert_df(rows[rows.date >= w.start])  # write only [start, end]',
  '',
].join('\n');
const prices = {
  name: 'prices_daily',
  description: 'Adjusted daily prices.',
  code: CODE,
  inputs: ['eod_prices'],
  outputs: [
    {
      collection: 'prices_daily',
      key: ['security_id', 'date'],
      known_at_field: 'known_at',
      as_of_field: 'as_of_date',
      description: 'Adjusted bars',
      fields: { adj_close: { description: 'Adjusted close', unit: 'USD' } },
    },
    {
      collection: 'prices_daily_dq',
      key: ['security_id', 'date', 'issue_type'],
      known_at_field: 'detected_at',
    },
  ],
  trigger: { after: ['dataset:eod_prices'] },
  incremental: { mode: 'date_range', lookback_days: 10 },
  secrets: ['FMP_API_KEY'],
};
const features = {
  name: 'features_daily',
  code: 'import oh\nprint("features")\n',
  inputs: ['prices_daily'],
  outputs: [{ collection: 'features_daily', key: ['security_id', 'date'], known_at_field: 'known_at' }],
  trigger: { after: ['transform:prices_daily'] },
};

before(async () => {
  if (!DIRECT_MONGO) return;
  await mongo.connect();
  for (const o of [A, B]) {
    await collection<any>('dataset_syncs').insertOne({
      _id: `${o}-eod`,
      ownerId: o,
      name: 'EOD',
      dataset: 'eod_prices',
      enabled: true,
      connectionId: 'c',
      symbolsMode: 'universe',
      schedule: { enabled: false, everyMinutes: 1440, input: 'x' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await mongo
      .db(workspaceDatabase(o))
      .collection('eod_prices')
      .insertOne({ symbol: 'AAPL', date: '2026-11-03' });
  }
});
after(async () => {
  if (!DIRECT_MONGO) return;
  for (const c of ['dataset_syncs', 'transforms', 'transform_versions', 'dataset_catalog'])
    await collection<any>(c).deleteMany({ ownerId: { $in: [A, B] } });
  for (const o of [A, B]) await mongo.db(workspaceDatabase(o)).dropDatabase();
  await mongo.close();
});

test(
  'create, version on change, no-op when unchanged, restore as a new version',
  { skip: skipReason },
  async () => {
    const t = await T.createTransform(A, prices, 'u');
    assert.equal(t.version, 1);
    assert.equal(t.outputs.length, 2);
    const same = await T.updateTransform(A, t._id, prices, 'u');
    assert.equal(same.version, 1, 'unchanged save is a no-op');
    const v2 = await T.updateTransform(A, t._id, { ...prices, description: 'v2' }, 'u');
    assert.equal(v2.version, 2);
    const v3 = await T.restoreTransformVersion(A, t._id, 1, 'u');
    assert.deepEqual([v3.version, v3.description], [3, 'Adjusted daily prices.']);
    const versions = await T.transformVersions().find({ transformId: t._id }).sort({ version: 1 }).toArray();
    assert.deepEqual(
      versions.map((v) => v.version),
      [1, 2, 3],
    );
    assert.equal(versions[2].note, 'Restored from v1');
    assert.equal(versions[0].spec.code, CODE);
  },
);

test(
  'one producer per collection; never a Layer 1 sync target; inputs must exist',
  { skip: skipReason },
  async () => {
    await assert.rejects(
      T.createTransform(A, { ...prices, name: 'other_prices' }),
      /already produced by the transform prices_daily/,
    );
    await assert.rejects(
      T.createTransform(A, {
        ...features,
        name: 'bad',
        outputs: [{ collection: 'eod_prices', key: ['symbol'], known_at_field: 'k' }],
        inputs: [],
      }),
      /written by the Layer 1 sync/,
    );
    await assert.rejects(
      T.createTransform(A, { ...features, inputs: ['nope'] }),
      /Input nope does not exist/,
    );
    await assert.rejects(
      T.createTransform(A, { ...features, trigger: { after: ['transform:ghost'] } }),
      /no transform named ghost/,
    );
    const f = await T.createTransform(A, features, 'u');
    const p = (await T.transforms().findOne({ ownerId: A, name: 'prices_daily' }))!;
    await assert.rejects(T.deleteTransform(A, p._id), /Used by features_daily/);
    await T.deleteTransform(A, f._id);
  },
);

test(
  'YAML round trip: two dependent transforms with Python code into an empty workspace',
  { skip: skipReason },
  async () => {
    await T.createTransform(A, features, 'u');
    const { yaml } = await exportObjects(A, ['Transform']);
    assert.match(yaml, /kind: Transform\nmetadata:\n  name: features_daily/);
    assert.ok(yaml.includes('code: |'));
    for (const line of CODE.split('\n').filter(Boolean)) assert.ok(yaml.includes(line), `code kept: ${line}`);
    assert.ok(!/ownerId|createdAt|_id:/.test(yaml));
    const plan = await planObjectImport(who(B), yaml, 'merge');
    assert.deepEqual(plan.errors, [], 'features_daily may depend on prices_daily from the same file');
    assert.deepEqual(plan.items.map((i) => `${i.name}:${i.action}`).sort(), [
      'features_daily:create',
      'prices_daily:create',
    ]);
    const r = await applyObjectImport(who(B), yaml, 'merge');
    assert.equal(r.applied, true, JSON.stringify(r));
    const b = (await T.transforms().findOne({ ownerId: B, name: 'prices_daily' }))!;
    assert.equal(b.code, CODE, 'Python byte-for-byte');
    const again = (await exportObjects(B, ['Transform'])).yaml.replace(/version: "\d+"/g, '');
    assert.equal(again, yaml.replace(/version: "\d+"/g, ''), 'identical apart from the version counter');
    assert.ok((await planObjectImport(who(B), yaml, 'merge')).items.every((i) => i.action === 'unchanged'));
  },
);
