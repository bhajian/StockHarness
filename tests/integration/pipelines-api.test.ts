// #156 pipelines through the API on the real stack: the dispatcher tick runs a daily pipeline
// (check -> transform in the Python executor -> research stub), in order, with the period as the window.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
let cookie = '';
let connectionId = '';
async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    data: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
  };
}
async function ok(path: string, body?: unknown, method?: string) {
  const r = await request(path, body, method);
  assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

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
  const isolated = { email: `pipelines-${randomUUID()}@openharness.test`, password: credentials.password };
  await ok('/users', { ...isolated, name: 'Pipelines', workspace: 'new' });
  await login(isolated);
  connectionId = (await ok('/connections', { name: 'MongoDB', kind: 'mongodb', builtIn: true, url: '' })).id;
  await ok(`/mongodb/${connectionId}/collections`, { name: 'pa_raw' });
  await ok(`/mongodb/${connectionId}/collections/pa_raw/documents`, {
    documents: ['2026-01-15', '2026-01-16'].flatMap((date) =>
      ['AAA', 'BBB'].map((symbol) => ({ symbol, date, close: 10 })),
    ),
  });
});

test('a daily pipeline runs check -> transform (executor) -> research in order, then exports as YAML', async () => {
  await ok('/transforms', {
    name: 'pa_daily',
    code: [
      'import oh',
      'w = oh.window',
      'rows = oh.read("pa_raw", {"date": {"$gte": w.start, "$lte": w.end}})',
      'oh.output("pa_daily_out").upsert([{**r, "known_at": r["date"] + "T21:00:00Z"} for r in rows])',
      '',
    ].join('\n'),
    inputs: ['pa_raw'],
    outputs: [{ collection: 'pa_daily_out', key: ['symbol', 'date'], known_at_field: 'known_at' }],
    incremental: { mode: 'date_range', lookback_days: 0 },
  });
  const spec = {
    name: 'daily-test',
    period: 'day',
    nodes: [
      {
        id: 'raw_ready',
        ref: 'check:collection_rows',
        params: { collection: 'pa_raw' },
        gate: { min_rows: 2 },
      },
      { id: 'daily', ref: 'transform:pa_daily', after: ['raw_ready'], gate: { min_rows: 2 } },
      { id: 'research', ref: 'research:stub', after: ['daily'] },
    ],
  };
  assert.deepEqual((await ok('/pipelines/validate', spec)).errors, []);
  const p = await ok('/pipelines', spec);
  const started = await ok(`/pipelines/${p.id}/run`, { period: '2026-01-16' });
  assert.equal(started.created, true);
  assert.equal(
    (await ok(`/pipelines/${p.id}/run`, { period: '2026-01-16' })).created,
    false,
    'one run per period',
  );
  let run: any;
  for (let i = 0; i < 300; i++) {
    run = await ok(`/pipeline-runs/${started.id}`);
    if (!['running', 'queued'].includes(run.status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(run.status, 'succeeded', JSON.stringify(run.nodes, null, 1));
  assert.deepEqual(run.nodes.raw_ready.gate, [{ name: 'rows', value: 2, threshold: '≥ 2', pass: true }]);
  assert.ok(run.nodes.daily.startedAt >= run.nodes.raw_ready.finishedAt);
  assert.ok(run.nodes.research.startedAt >= run.nodes.daily.finishedAt);
  assert.equal(run.nodes.daily.stats.written, 2, 'only the period (2026-01-16) was written');
  const [tr] = await ok(`/transforms/${(await ok('/transforms'))[0].id}/runs`);
  assert.deepEqual([tr.trigger, tr.window.start, tr.window.end], ['pipeline', '2026-01-16', '2026-01-16']);
  const listed = (await ok('/pipelines'))[0];
  assert.equal(listed.lastRun.status, 'succeeded');
  // Controls: re-run from the transform.
  await ok(`/pipeline-runs/${started.id}/nodes/daily/rerun`, {});
  for (let i = 0; i < 300; i++) {
    run = await ok(`/pipeline-runs/${started.id}`);
    if (run.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(run.status, 'succeeded');
  assert.equal(run.nodes.daily.generation, 1);
  assert.equal(run.nodes.raw_ready.generation, 0);
  const yaml = await ok('/objects/export?kinds=Pipeline');
  assert.match(yaml, /kind: Pipeline\nmetadata:\n  name: daily-test\n/);
  assert.match(yaml, /ref: check:collection_rows/);
  // A cycle is refused.
  const bad = await request('/pipelines', {
    ...spec,
    name: 'cyclic',
    nodes: [{ ...spec.nodes[0], after: ['research'] }, ...spec.nodes.slice(1)],
  });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Cycle/);
});
