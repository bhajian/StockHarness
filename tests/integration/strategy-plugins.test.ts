// #103: StrategyPlugin objects. Versions on every change; YAML export -> import into an empty owner -> export is
// identical (with full history); the code hash is checked on import. Needs TEST_DIRECT_MONGODB_URI.
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
const { exportObjects, planObjectImport, applyObjectImport } = await import('../../apps/api/src/objects.js');
const { SECRET_FIELD_PATTERN } = await import('../../packages/core/src/objectEnvelope.js');
const plugins = await import('../../packages/core/src/strategyPlugins.js');

const S = `sp-src-${randomUUID()}`;
const T = `sp-dst-${randomUUID()}`;
const who = (tenantId: string) => ({ tenantId, user: { _id: `admin-${tenantId}`, role: 'admin' } }) as any;
const V1 = [
  'import numpy as np',
  '',
  'META = {"side": "long", "horizon_days": 40, "rebalance": "weekly", "top_n": 30}',
  '',
  'def signal(ctx):',
  '    f = ctx.read_df("features_ranked", columns=["security_id", "mom_12_1_pct"], lookback_days=7)',
  '    last = f.sort_values("as_of_date").groupby("security_id").tail(1)',
  '    return dict(zip(last.security_id, last.mom_12_1_pct))  # 12-1 — momentum',
  '',
].join('\n');
const V2 = V1.replace('"top_n": 30', '"top_n": 20');

before(async () => {
  if (!DIRECT_MONGO) return;
  await mongo.connect();
});
after(async () => {
  if (!DIRECT_MONGO) return;
  for (const c of ['strategy_plugins', 'strategy_plugin_versions'])
    await collection<any>(c).deleteMany({ ownerId: { $in: [S, T] } });
  await mongo.close();
});

test('versions, hash and save-time checks', { skip: skipReason }, async () => {
  const p = await plugins.createStrategyPlugin(S, { name: 'mom_12_1', code: V1, description: 'Momentum' });
  assert.equal(p.version, 1);
  assert.equal(p.hash, plugins.codeHash(V1));
  const same = await plugins.updateStrategyPlugin(S, p._id, { code: V1, description: 'Momentum' });
  assert.equal(same.version, 1, 'unchanged save is a no-op');
  const p2 = await plugins.updateStrategyPlugin(S, p._id, { code: V2, description: 'Momentum' }, 'u', {
    note: 'smaller book',
  });
  assert.equal(p2.version, 2);
  const versions = await plugins.listStrategyPluginVersions(S, p._id);
  assert.deepEqual(
    versions.map((v) => [v.version, v.hash]),
    [
      [2, plugins.codeHash(V2)],
      [1, plugins.codeHash(V1)],
    ],
  );
  const old = await plugins.resolveStrategyPlugin(S, 'mom_12_1', 1);
  assert.equal(old.code, V1);
  await assert.rejects(
    plugins.createStrategyPlugin(S, { name: 'bad', code: 'import os\n' }),
    /signal\(ctx\).*import os is not allowed/,
  );
  await assert.rejects(plugins.createStrategyPlugin(S, { name: 'mom_12_1', code: V1 }), /already exists/);
});

test('round trip with history: identical YAML, code verbatim, no secrets', { skip: skipReason }, async () => {
  const { yaml } = await exportObjects(S, ['StrategyPlugin'], undefined, { withHistory: true });
  assert.match(yaml, /kind: StrategyPlugin/);
  assert.ok(yaml.includes('code: |'), 'code is a block scalar');
  assert.ok(yaml.includes('# 12-1 — momentum'), 'code verbatim');
  assert.match(yaml, /history:\n\s+- version: 1/);
  assert.ok(
    !SECRET_FIELD_PATTERN.test(yaml) && !/ownerId|createdAt|^\s*_id:/m.test(yaml),
    'no secrets or state',
  );

  const plan = await planObjectImport(who(T), yaml, 'merge');
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(
    plan.items.map((i) => `${i.kind}:${i.name}:${i.action}`),
    ['StrategyPlugin:mom_12_1:create'],
  );
  const r = await applyObjectImport(who(T), yaml, 'merge');
  assert.equal(r.applied, true, JSON.stringify(r));
  const imported = await plugins.strategyPlugins().findOne({ ownerId: T, name: 'mom_12_1' });
  assert.equal(imported!.version, 2);
  assert.equal(imported!.code, V2);
  const v1 = await plugins.resolveStrategyPlugin(T, 'mom_12_1', 1);
  assert.equal(v1.code, V1, 'history restored');
  assert.equal(
    (await exportObjects(T, ['StrategyPlugin'], undefined, { withHistory: true })).yaml,
    yaml,
    'identical round trip',
  );
  const again = await planObjectImport(who(T), yaml, 'merge');
  assert.deepEqual(
    again.items.map((i) => i.action),
    ['unchanged'],
  );
});

test('a tampered hash or a contract violation is refused on import', { skip: skipReason }, async () => {
  const { yaml } = await exportObjects(S, ['StrategyPlugin'], undefined, { withHistory: true });
  const tampered = yaml.replace('"top_n": 20', '"top_n": 5');
  const plan = await planObjectImport(who(T), tampered, 'merge');
  assert.match(plan.errors[0]?.message ?? '', /hash does not match the code/);
  const r = await applyObjectImport(who(T), tampered, 'merge');
  assert.equal(r.applied, false);
  const stillV2 = await plugins.strategyPlugins().findOne({ ownerId: T, name: 'mom_12_1' });
  assert.equal(stillV2!.code, V2, 'nothing written');
});

test('Evaluation records round-trip verbatim and stay immutable', { skip: skipReason }, async () => {
  const { evaluations } = await import('../../packages/core/src/evaluations.js');
  const hash = plugins.codeHash(V2);
  const id = randomUUID();
  await evaluations().insertOne({
    _id: id,
    ownerId: S,
    pluginId: 'x',
    pluginName: 'mom_12_1',
    pluginVersion: 2,
    codeHash: hash,
    theoryId: 'T-7',
    mode: 'explore',
    params: { start: '2023-01-03', end: '2024-12-31', symbols: ['AAPL', 'MSFT'] },
    trial: 3,
    status: 'succeeded',
    record: {
      evaluator_version: '1.0.0',
      plugin: { hash, name: 'mom_12_1', version: 2 },
      summary: { sharpe: 1.2345678901, cagr: 0.1, max_drawdown: -0.25, delisted: [] },
      series: {
        dates: ['2023-01-04', '2023-01-05'],
        series: { equity: [0.9994, 1.0101], drawdown: [0, -0.001] },
      },
      record_hash: 'sha256:' + 'a'.repeat(64),
      trial_context: { dsr: 0.61, trials: 3 },
    },
    durationMs: 42000,
    createdAt: new Date('2026-11-05T03:00:00.000Z'),
    finishedAt: new Date('2026-11-05T03:00:42.000Z'),
  } as any);
  await evaluations().insertOne({
    _id: randomUUID(),
    ownerId: S,
    pluginId: 'x',
    pluginName: 'mom_12_1',
    pluginVersion: 2,
    codeHash: hash,
    mode: 'explore',
    params: { start: '2023-01-03', end: '2023-02-01' },
    trial: 4,
    status: 'running',
    createdAt: new Date(),
  } as any);
  const { yaml } = await exportObjects(S, ['Evaluation']);
  assert.match(yaml, /kind: Evaluation/);
  assert.equal((yaml.match(/kind: Evaluation/g) ?? []).length, 1, 'running evaluations are not exported');
  assert.ok(!SECRET_FIELD_PATTERN.test(yaml) && !/ownerId|pluginId/.test(yaml));
  const r = await applyObjectImport(who(T), yaml, 'merge');
  assert.equal(r.applied, true, JSON.stringify(r));
  const copy = await evaluations().findOne({ ownerId: T, sourceId: id } as any);
  assert.equal(copy!.record!.summary.sharpe, 1.2345678901, 'the record is restored, never re-run');
  assert.equal(
    copy!.pluginId,
    (await plugins.strategyPlugins().findOne({ ownerId: T, name: 'mom_12_1' }))!._id,
  );
  assert.equal((await exportObjects(T, ['Evaluation'])).yaml, yaml, 'identical round trip');
  assert.deepEqual(
    (await planObjectImport(who(T), yaml, 'merge')).items.map((i) => i.action),
    ['unchanged'],
  );
  const edited = yaml.replace('sharpe: 1.2345678901', 'sharpe: 9.9');
  assert.match((await planObjectImport(who(T), edited, 'merge')).errors[0].message, /immutable/);
  const forged = yaml.replace(/codeHash: sha256:[0-9a-f]+/, `codeHash: sha256:${'b'.repeat(64)}`);
  assert.match(
    (await planObjectImport(who(T), forged.replace(id, randomUUID()), 'merge')).errors[0].message,
    /does not match codeHash/,
  );
  await evaluations().deleteMany({ ownerId: { $in: [S, T] } });
});

test(
  'a name-subset Evaluation keeps what it was picked from through the round trip (#325)',
  { skip: skipReason },
  async () => {
    const { evaluations } = await import('../../packages/core/src/evaluations.js');
    const hash = plugins.codeHash(V2);
    const [parent, sub] = [randomUUID(), randomUUID()];
    const base = {
      ownerId: S,
      pluginId: 'x',
      pluginName: 'mom_12_1',
      pluginVersion: 2,
      codeHash: hash,
      mode: 'explore',
      status: 'succeeded',
      durationMs: 1000,
      createdAt: new Date('2026-11-07T03:00:00.000Z'),
      finishedAt: new Date('2026-11-07T03:00:01.000Z'),
    };
    await evaluations().insertOne({
      ...base,
      _id: parent,
      params: { start: '2023-01-03', end: '2024-12-31' },
      trial: 8,
      record: {
        plugin: { hash, name: 'mom_12_1', version: 2 },
        summary: { sharpe: 0.5 },
        record_hash: 'sha256:' + 'c'.repeat(64),
      },
    } as any);
    await evaluations().insertOne({
      ...base,
      _id: sub,
      params: { start: '2023-01-03', end: '2024-12-31' },
      subsetOf: parent,
      select: { top_k: 20, n_random: 40 },
      trial: 9,
      record: {
        plugin: { hash, name: 'mom_12_1', version: 2 },
        summary: { sharpe: 1.5 },
        subset: { passed: true, chosen: [{ security_id: 'SEC_1', ticker: 'AAPL' }] },
        record_hash: 'sha256:' + 'd'.repeat(64),
      },
    } as any);
    const { yaml } = await exportObjects(S, ['Evaluation']);
    assert.match(yaml, new RegExp(`subsetOf: ${parent}`));
    assert.match(yaml, /top_k: 20/);
    const r = await applyObjectImport(who(T), yaml, 'merge');
    assert.equal(r.applied, true, JSON.stringify(r));
    const copy = await evaluations().findOne({ ownerId: T, sourceId: sub } as any);
    assert.equal(copy!.subsetOf, parent);
    assert.deepEqual(copy!.select, { top_k: 20, n_random: 40 });
    assert.equal((await exportObjects(T, ['Evaluation'])).yaml, yaml, 'identical round trip');
    await evaluations().deleteMany({ ownerId: { $in: [S, T] } });
  },
);
