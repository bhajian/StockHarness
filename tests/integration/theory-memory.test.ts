// #111 on the real stack: theories are embedded with the workspace's embedding provider (a fixture model where
// synonyms share concepts) and stored in the vector store; a paraphrase of an existing theory is flagged with the
// matching theory and its score.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
let cookie = '';
async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + '/api' + path, {
    method,
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return {
    status: r.status,
    data: text && r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
  };
}
async function ok(path: string, body?: unknown, method?: string) {
  const r = await request(path, body, method);
  assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
const theory = (title: string, hypothesis: string, signalLogic: string) => ({
  title,
  hypothesis,
  signalLogic,
  falsification: 'No excess return over the sector benchmark out of sample.',
  submit: true,
});

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
  const isolated = { email: `memory-${randomUUID()}@openharness.test`, password: credentials.password };
  await ok('/users', { ...isolated, name: 'Theory memory', workspace: 'new' });
  await login(isolated);
  await ok('/providers', {
    name: 'Concept embeddings',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-embed-concepts',
    modelType: 'embedding',
  });
});

test('a paraphrase of an existing theory is flagged with the match and its score', async () => {
  const a = await ok(
    '/theories',
    theory(
      'Post-earnings drift in quality names',
      'High-quality companies that beat estimates keep drifting up for 40 days after the report.',
      'Rank names by quality_score among those that reported in the last 5 days; long the top 10.',
    ),
  );
  assert.equal(a.ref, 'T-1');
  assert.equal(a.status, 'pre_review');
  const paraphrase = theory(
    'Quality firms keep rising after they surprise analysts',
    'Profitable firms that surprise analysts continue to rise for two months following their earnings announcement.',
    'Among stocks with results in the past week, buy the most profitable ten.',
  );
  const dup = await request('/theories', paraphrase);
  assert.equal(dup.status, 409);
  assert.match(
    dup.data.error,
    /near-duplicate of T-1 "Post-earnings drift in quality names" \(pre_review, similarity 0\.9\d+ ≥ 0\.9, Concept embeddings:test-embed-concepts\)/,
  );
  const other = await ok(
    '/theories',
    theory(
      'Low volatility in bear markets',
      'The calmest stocks lose less in market downturns and outperform over a full cycle.',
      'Rank by volatility, long the lowest decile, rebalance monthly.',
    ),
  );
  assert.equal(other.ref, 'T-2', 'nothing was created for the refused paraphrase');
  const differs = await ok('/theories', {
    ...paraphrase,
    differsFrom: 'Only Q4 reports, where the drift is strongest.',
  });
  assert.equal(differs.status, 'pre_review');
  const search = await ok(
    `/theories/search?q=${encodeURIComponent('profitable firms rising after earnings surprises')}`,
  );
  assert.equal(search.method, 'Concept embeddings:test-embed-concepts');
  assert.deepEqual(
    search.matches
      .slice(0, 2)
      .map((m: any) => m.ref)
      .sort(),
    ['T-1', 'T-3'],
  );
  assert.equal(search.matches.at(-1).ref, 'T-2');
});
