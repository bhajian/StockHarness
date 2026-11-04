import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { parseObjects, renderObjects, toRefs, fromRefs, refsIn, stableJson } =
  await import('../../packages/core/src/objectEnvelope.js');

const code =
  'import oh\n\nrows = oh.read_df("eod_prices", {"date": {"$gte": "2026-01-01"}})\nprint(f"{len(rows)} rows — ok")\n';

test('render → parse round-trips multi-document envelopes, code verbatim', () => {
  const yaml = renderObjects([
    {
      apiVersion: 'stockharness/v1',
      kind: 'Skill',
      metadata: { name: 'b' },
      spec: { description: 'd', instructions: 'x' },
    },
    {
      apiVersion: 'stockharness/v1',
      kind: 'Harness',
      metadata: { name: 'Prices' },
      spec: { nodes: [{ type: 'code', code }] },
    },
    {
      apiVersion: 'stockharness/v1',
      kind: 'Skill',
      metadata: { name: 'a' },
      spec: { description: 'd', instructions: 'y' },
    },
  ]);
  const { docs, errors } = parseObjects(yaml);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    docs.map((d) => `${d.kind}:${d.metadata.name}`),
    ['Skill:a', 'Skill:b', 'Harness:Prices'],
    'sorted by kind order, then name',
  );
  assert.equal((docs[2].spec.nodes as { code: string }[])[0].code, code);
  assert.match(yaml, /code: \|/, 'multi-line code is a YAML block scalar');
  assert.equal(renderObjects(docs), yaml, 'deterministic');
});

test('accepts kind: List, the Datasets DatasetSyncs export and config-io bare lists', async () => {
  const list = parseObjects(
    'apiVersion: stockharness/v1\nkind: List\nitems:\n  - { apiVersion: stockharness/v1, kind: Skill, metadata: { name: s }, spec: {} }\n',
  );
  assert.equal(list.docs[0].kind, 'Skill');
  const syncs = parseObjects(
    'apiVersion: stockharness/v1\nkind: DatasetSyncs\nsyncs:\n  - { name: EOD, dataset: eod_prices }\n',
  );
  assert.deepEqual(
    [syncs.docs[0].kind, syncs.docs[0].metadata.name, syncs.docs[0].spec.dataset],
    ['DatasetSync', 'EOD', 'eod_prices'],
  );
  // Legacy config-io files are bare lists; their kind comes from the file name.
  const legacy = parseObjects('- { name: stock, description: d, instructions: x }\n', 'Skill');
  assert.deepEqual([legacy.errors, legacy.docs[0]?.metadata.name], [[], 'stock']);
  // The committed backup (#149) is stockharness/v1 objects.
  const skills = parseObjects(await readFile('deploy/config-io/exports/skills.yaml', 'utf8'));
  assert.deepEqual(skills.errors, []);
  assert.ok(skills.docs.length >= 1 && skills.docs.every((d) => d.kind === 'Skill'));
  const syncsRepo = parseObjects(await readFile('deploy/config-io/exports/dataset-syncs.yaml', 'utf8'));
  assert.deepEqual(syncsRepo.errors, []);
  assert.equal(syncsRepo.docs.length, 43);
  const json = parseObjects(
    '[{"name":"EOD","dataset":"eod_prices"},{"name":"Rates","dataset":"treasury_rates"}]',
    'DatasetSync',
  );
  assert.deepEqual([json.errors, json.docs.length], [[], 2]);
  assert.match(parseObjects('[{ "name": "x" }]').errors[0].message, /needs its kind/);
});

test('reports bad envelopes and duplicates', () => {
  const r = parseObjects(
    [
      'apiVersion: stockharness/v2\nkind: Skill\nmetadata: { name: a }\nspec: {}',
      'apiVersion: stockharness/v1\nkind: Widget\nmetadata: { name: a }\nspec: {}',
      'apiVersion: stockharness/v1\nkind: Skill\nmetadata: {}\nspec: {}',
      'apiVersion: stockharness/v1\nkind: Skill\nmetadata: { name: dup }\nspec: {}',
      'apiVersion: stockharness/v1\nkind: Skill\nmetadata: { name: dup }\nspec: {}',
    ].join('\n---\n'),
  );
  const msgs = r.errors.map((e) => e.message).join(' | ');
  assert.match(msgs, /Unsupported apiVersion/);
  assert.match(msgs, /Unknown kind Widget/);
  assert.match(msgs, /metadata.name is required/);
  assert.match(msgs, /Duplicate Skill named "dup"/);
  assert.throws(() => parseObjects('a: [unclosed'), /Not valid YAML/);
});

test('ids become by-name refs and resolve back', () => {
  const byId = new Map([['11111111-1111-4111-8111-111111111111', { type: 'providers', name: 'Main LLM' }]]);
  const spec = {
    providerId: '11111111-1111-4111-8111-111111111111',
    nodes: [{ id: 'start', next: 'finish' }],
  };
  const withRefs = toRefs(spec, byId) as any;
  assert.deepEqual(withRefs.providerId, { $ref: { type: 'providers', name: 'Main LLM' } });
  assert.equal(withRefs.nodes[0].id, 'start', 'non-id strings are untouched');
  assert.deepEqual(refsIn(withRefs), [{ type: 'providers', name: 'Main LLM' }]);
  const missing: { type: string; name: string }[] = [];
  const back = fromRefs(
    withRefs,
    (t, n) => (t === 'providers' && n === 'Main LLM' ? 'target-id' : undefined),
    missing,
  ) as any;
  assert.equal(back.providerId, 'target-id');
  assert.deepEqual(missing, []);
  fromRefs({ x: { $ref: { type: 'connections', name: 'Nope' } } }, () => undefined, missing);
  assert.deepEqual(missing, [{ type: 'connections', name: 'Nope' }]);
  assert.equal(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] }), stableJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
});
