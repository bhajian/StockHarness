// #148 on the real stack: an agent whose MongoDB connection binds collections gets errors for unbound
// collections and missing permissions, can't join into an unbound collection, and always has its fixed filter
// applied. A scripted fixture model makes the calls through the platform's agent loop.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
let cookie = '';
async function ok(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + '/api' + path, {
    method,
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  assert.ok(r.status < 300, `${path}: ${r.status} ${text}`);
  return text && r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
}
let mongo: any;
let providerId = '';

before(async () => {
  const credentials = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  if ((await ok('/auth/status')).needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((l) => l.startsWith('SETUP_TOKEN='))!
      .slice(12);
    await ok('/auth/setup', { ...credentials, name: 'Test administrator', setupToken });
  }
  const login = async (c: { email: string; password: string }) => {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    });
    assert.equal(r.status, 200);
    cookie = r.headers.get('set-cookie')!.split(';')[0];
  };
  await login(credentials);
  const isolated = { email: `bindings-${randomUUID()}@openharness.test`, password: credentials.password };
  await ok('/users', { ...isolated, name: 'Bindings', workspace: 'new' });
  await login(isolated);
  mongo = await ok('/connections', { name: 'MongoDB', kind: 'mongodb', builtIn: true, url: '' });
  await ok(`/connections/${mongo.id}/discover`, {});
  for (const [c, docs] of [
    [
      'prices',
      [
        { symbol: 'AAA', close: 1 },
        { symbol: 'BBB', close: 2 },
        { symbol: 'AAA', close: 3 },
      ],
    ],
    ['secret_col', [{ symbol: 'AAA', secret: 'do not read' }]],
    ['watch', [{ symbol: 'ZZZ', note: 'seed' }]],
  ] as const) {
    await ok(`/mongodb/${mongo.id}/collections`, { name: c });
    await ok(`/mongodb/${mongo.id}/collections/${c}/documents`, { documents: docs });
  }
  providerId = (
    await ok('/providers', {
      name: 'Bindings fixture',
      kind: 'openai-compatible',
      baseUrl: 'http://fixtures:9090/v1',
      model: 'test-bindings',
      contextWindow: 200000,
      maxOutputTokens: 1024,
    })
  ).id;
});

test('bindings: unbound and under-permitted calls fail, joins stay inside, the fixed filter is applied', async () => {
  const agent = await ok('/agents', {
    name: 'Bound analyst',
    providerId,
    systemPrompt: 'Use the bound collections.',
    maxTurns: 10,
    connections: [
      {
        connectionId: mongo.id,
        tools: ['find', 'aggregate', 'delete-many', 'insert-many', 'drop-collection', 'list-collections'],
        collections: [
          { name: 'prices', permissions: ['read'], filter: { symbol: 'AAA' } },
          { name: 'watch', permissions: ['read', 'insert'] },
          { name: 'scratch', permissions: ['delete'] },
        ],
      },
    ],
  });
  let run = await ok('/runs', { agentId: agent.id, input: 'collection bindings check' });
  for (let i = 0; i < 120 && ['queued', 'running'].includes(run.status); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    run = await ok(`/runs/${run.id}`);
  }
  assert.equal(run.status, 'succeeded', run.error);
  const out = JSON.parse(run.output);
  const offered = out.offered
    .filter((d: string) => d.startsWith('MongoDB / '))
    .map((d: string) => d.split(' / ')[1])
    .sort();
  assert.deepEqual(
    offered,
    ['aggregate', 'delete-many', 'find', 'insert-many'],
    'no admin or database-wide tools',
  );
  assert.deepEqual(out.findEnum, ['prices', 'watch']);
  assert.match(out.findDescription, /- prices \(read\)/);
  const [unbound, deleteRead, lookup, deleteInsert, insert, filtered] = out.results;
  assert.match(unbound, /must be equal to one of the allowed values|not bound/);
  assert.match(deleteRead, /prices is bound with read; delete-many needs delete/);
  assert.match(lookup, /reaches secret_col, which is not bound/);
  assert.match(deleteInsert, /watch is bound with read, insert; delete-many needs delete/);
  assert.doesNotMatch(insert, /error|not bound|needs/i);
  assert.match(filtered, /AAA/);
  assert.doesNotMatch(filtered, /BBB/, 'the fixed filter is always applied');
  const watch = await ok(`/mongodb/${mongo.id}/collections/watch/documents?limit=10`);
  const rows = watch.documents ?? watch;
  assert.equal(rows.length, 2, 'the insert went through, and nothing was deleted');
  const secret = await ok(`/mongodb/${mongo.id}/collections/secret_col/documents?limit=10`);
  assert.equal((secret.documents ?? secret).length, 1);
  const started = run.events.filter((e: any) => e.type === 'tool_started');
  assert.ok(
    started.some((e: any) => e.data.collection === 'prices'),
    'the trace names the collection',
  );
});

test('bindings round-trip in the Agent YAML by connection name', async () => {
  const yaml = await ok('/objects/export?kinds=Agent&names=Bound%20analyst');
  assert.match(
    yaml,
    /collections:\n\s+- name: prices\n\s+permissions:\n\s+- read\n\s+filter:\n\s+symbol: AAA/,
  );
  assert.match(yaml, /\$ref:\s*\n\s*type: connections\s*\n\s*name: MongoDB/);
});
