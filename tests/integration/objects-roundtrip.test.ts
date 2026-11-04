// Real-MongoDB round trip for "everything is a YAML object" (#152). Needs MONGODB_URI pointing at an
// isolated test database (an `openharness-test-*` Compose project). No network: providers are inserted directly.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

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
const { saveResource } = await import('../../apps/api/src/resources.js');
const { exportObjects, planObjectImport, applyObjectImport } = await import('../../apps/api/src/objects.js');
const { SECRET_FIELD_PATTERN } = await import('../../packages/core/src/objectEnvelope.js');

const S = `obj-src-${randomUUID()}`;
const T = `obj-dst-${randomUUID()}`;
const U = `obj-bare-${randomUUID()}`;
const who = (tenantId: string) => ({ tenantId, user: { _id: `admin-${tenantId}`, role: 'admin' } }) as any;
const PYTHON = [
  'import oh',
  'from pipeline.layer2.prices_logic import compute_symbol_rows',
  '',
  'w = oh.window  # start, end, lookback_start',
  'bars = oh.read_df("eod_prices", {"date": {"$gte": w.lookback_start}})',
  "label = 'adjusted — ok'",
  'if len(bars) == 0:',
  '    raise SystemExit("no bars")',
  'oh.result({"rows": int(len(bars)), "label": label})',
  '',
].join('\n');

async function seedInstall(owner: string) {
  // Secret-bearing resources exist per install, with the same names but different ids.
  await collection<any>('providers').insertOne({
    _id: randomUUID(),
    ownerId: owner,
    name: 'Main LLM',
    kind: 'openai-compatible',
    baseUrl: 'https://llm.example.test/v1',
    model: 'm',
    modelType: 'llm',
    apiKeyEncrypted: 'secret-cipher',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await collection<any>('connections').insertOne({
    _id: randomUUID(),
    ownerId: owner,
    name: 'FMP',
    kind: 'mcp',
    enabled: true,
    url: 'https://fmp.example.test/mcp?apikey=SECRETKEY',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}
const providerId = async (owner: string) =>
  (await collection<any>('providers').findOne({ ownerId: owner }))._id;
const connectionId = async (owner: string) =>
  (await collection<any>('connections').findOne({ ownerId: owner }))._id;
let exported = '';

before(async () => {
  if (!DIRECT_MONGO) return;
  await mongo.connect();
  await seedInstall(S);
  await seedInstall(T);
  const skill = await saveResource('skills', who(S), {
    name: 'pit-rules',
    description: 'Point-in-time rules',
    instructions: '# Rules\n\n1. Use `acceptedDate`.\n',
  });
  await saveResource('agents', who(S), {
    name: 'Analyst',
    systemPrompt: 'Analyse.',
    providerId: await providerId(S),
    skillIds: [skill.id],
  });
  await saveResource('workflows', who(S), {
    name: 'Prices transform',
    startAt: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Start', next: 'prep' },
      {
        id: 'prep',
        type: 'code',
        name: 'Prep prices',
        code: PYTHON,
        params: { lookback: 10 },
        secrets: ['FMP_API_KEY'],
        next: 'review',
      },
      {
        id: 'review',
        type: 'agent',
        name: 'Review',
        config: {
          name: 'Reviewer',
          systemPrompt: 'Check {{last}}',
          providerId: await providerId(S),
          skillIds: [skill.id],
        },
        next: 'finish',
      },
      { id: 'finish', type: 'finish', name: 'Finish' },
    ],
  });
  await collection<any>('dataset_syncs').insertOne({
    _id: randomUUID(),
    ownerId: S,
    name: 'EOD prices',
    enabled: true,
    connectionId: await connectionId(S),
    dataset: 'eod_prices',
    symbolsMode: 'universe',
    from: '2016-01-01',
    schedule: {
      enabled: true,
      everyMinutes: 1440,
      at: '18:49',
      input: 'daily',
      timezone: 'America/New_York',
    },
    cursor: '2026-10-23',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});
after(async () => {
  if (!DIRECT_MONGO) return;
  for (const c of [
    'providers',
    'connections',
    'skills',
    'skill_versions',
    'agents',
    'workflows',
    'dataset_syncs',
    'harness_events',
  ])
    await collection<any>(c).deleteMany({ ownerId: { $in: [S, T, U] } });
  await mongo.close();
});

test('export: by-name references, Python verbatim, no ids or secrets', { skip: skipReason }, async () => {
  const { yaml, count } = await exportObjects(S);
  exported = yaml;
  assert.equal(count, 4);
  assert.ok(yaml.includes('code: |'), 'code is a block scalar');
  for (const line of PYTHON.split('\n').filter(Boolean))
    assert.ok(yaml.includes(line), `code line kept: ${line}`);
  assert.match(yaml, /\$ref:\s*\n\s*type: providers\s*\n\s*name: Main LLM/);
  assert.match(yaml, /connection: FMP/);
  assert.ok(!yaml.includes(await providerId(S)), 'no source ids');
  assert.ok(
    !SECRET_FIELD_PATTERN.test(yaml) && !yaml.includes('SECRETKEY') && !yaml.includes('secret-cipher'),
    'no secrets',
  );
  assert.ok(!/cursor|createdAt|ownerId|revision/.test(yaml), 'no server state');
});

test('import into an empty install, then export again: identical YAML', { skip: skipReason }, async () => {
  const plan = await planObjectImport(who(T), exported, 'merge');
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.items.map((i) => `${i.kind}:${i.name}:${i.action}`).sort(), [
    'Agent:Analyst:create',
    'DatasetSync:EOD prices:create',
    'Harness:Prices transform:create',
    'Skill:pit-rules:create',
  ]);
  assert.equal(await collection('workflows').countDocuments({ ownerId: T }), 0, 'plan writes nothing');
  const r = await applyObjectImport(who(T), exported, 'merge');
  assert.equal(r.applied, true, JSON.stringify(r));
  const wf = await collection<any>('workflows').findOne({ ownerId: T, name: 'Prices transform' });
  assert.equal(wf.nodes[1].code, PYTHON, 'Python byte-for-byte');
  assert.equal(wf.nodes[2].config.providerId, await providerId(T), 'reference resolved to the target id');
  const skill = await collection<any>('skills').findOne({ ownerId: T, name: 'pit-rules' });
  assert.deepEqual(
    wf.nodes[2].config.skillIds,
    [skill._id],
    'reference to an object created by the same import',
  );
  assert.equal((await exportObjects(T)).yaml, exported, 'round trip is identical');
});

test('re-import is a no-op; an edited code line is an update', { skip: skipReason }, async () => {
  const again = await planObjectImport(who(T), exported, 'merge');
  assert.ok(
    again.items.every((i) => i.action === 'unchanged'),
    JSON.stringify(again.items),
  );
  const edited = exported.replace("label = 'adjusted — ok'", "label = 'adjusted v2'");
  const p = await planObjectImport(who(T), edited, 'merge');
  assert.deepEqual(
    p.items.filter((i) => i.action !== 'unchanged').map((i) => `${i.kind}:${i.action}`),
    ['Harness:update'],
  );
  assert.equal((await applyObjectImport(who(T), edited, 'merge')).applied, true);
  const wf = await collection<any>('workflows').findOne({ ownerId: T, name: 'Prices transform' });
  assert.ok(wf.nodes[1].code.includes("label = 'adjusted v2'"));
});

test('missing secret-bearing references are reported, nothing is written', { skip: skipReason }, async () => {
  const p = await planObjectImport(who(U), exported, 'merge');
  assert.ok(
    p.errors.some((e) => /providers "Main LLM" \(create it on this install first\)/.test(e.message)),
    JSON.stringify(p.errors),
  );
  const r = await applyObjectImport(who(U), exported, 'merge');
  assert.equal(r.applied, false);
  assert.equal(await collection('skills').countDocuments({ ownerId: U }), 0);
});

test('replace refuses to remove an object that is still in use', { skip: skipReason }, async () => {
  const onlyOther =
    'apiVersion: stockharness/v1\nkind: Skill\nmetadata: { name: other }\nspec: { description: d, instructions: x }\n';
  const p = await planObjectImport(who(T), onlyOther, 'replace');
  assert.ok(p.items.some((i) => i.name === 'pit-rules' && i.action === 'remove'));
  const r: any = await applyObjectImport(who(T), onlyOther, 'replace');
  assert.equal(r.applied, false);
  assert.match(r.error, /references/);
  assert.equal(
    await collection('skills').countDocuments({ ownerId: T, name: 'pit-rules' }),
    1,
    'still there',
  );
});

test('the committed backup files and legacy bare lists import', { skip: skipReason }, async () => {
  const skills = await planObjectImport(
    who(T),
    await readFile('deploy/config-io/exports/skills.yaml', 'utf8'),
    'merge',
  );
  assert.deepEqual(skills.errors, []);
  assert.ok(skills.items.length >= 1 && skills.items.every((i) => i.kind === 'Skill'));
  const syncs = await planObjectImport(
    who(T),
    await readFile('deploy/config-io/exports/dataset-syncs.yaml', 'utf8'),
    'merge',
  );
  assert.deepEqual(syncs.errors, []);
  assert.equal(syncs.items.length, 43);
  const legacy = await planObjectImport(
    who(T),
    JSON.stringify([
      {
        name: 'Legacy EOD',
        connectionId: { $ref: { type: 'connections', name: 'FMP' } },
        dataset: 'eod_prices',
        schedule: { enabled: true, everyMinutes: 1440, input: 'x' },
      },
    ]),
    'merge',
    'DatasetSync',
  );
  assert.deepEqual(legacy.errors, []);
  assert.deepEqual(
    legacy.items.map((i) => `${i.name}:${i.action}`),
    ['Legacy EOD:create'],
  );
});
