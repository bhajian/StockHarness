// #83 against the real stack: a dataset sync pulls from the fixture FMP; a drifted payload records an alert,
// breaking drift fails that item without writing, and Health and the catalog show it.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
let cookie = '';
let mongoId = '';
let fmpId = '';
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
async function syncAndWait(name: string, symbols: string[]) {
  const sync = await ok('/dataset-syncs', {
    name,
    connectionId: fmpId,
    dataset: 'eod_prices',
    symbolsMode: 'list',
    symbols,
    from: '2026-10-26',
    enabled: true,
    schedule: { enabled: false, everyMinutes: 1440, input: 'Run the scheduled task.' },
  });
  await ok(`/dataset-syncs/${sync.id}/run`, {});
  for (let i = 0; i < 120; i++) {
    const runs = await ok(`/dataset-syncs/${sync.id}/runs`);
    const run = Array.isArray(runs) ? runs[0] : runs.runs?.[0];
    if (run && run.status !== 'running') return run;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${name} did not finish`);
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
  const isolated = { email: `drift-${randomUUID()}@openharness.test`, password: credentials.password };
  await ok('/users', { ...isolated, name: 'Drift', workspace: 'new' });
  await login(isolated);
  mongoId = (await ok('/connections', { name: 'MongoDB', kind: 'mongodb', builtIn: true, url: '' })).id;
  fmpId = (await ok('/connections', { name: 'FMP', url: 'http://fixtures:9090/mcp?apikey=test-key' })).id;
});

test('a drifted payload records an alert; breaking drift fails the item instead of writing', async () => {
  // A clean pull establishes the schema.
  const good = await syncAndWait('EOD good', ['GOOD']);
  assert.equal(good.status, 'succeeded', JSON.stringify(good));
  await ok('/catalog/refresh', { collection: 'eod_prices' });
  // Next pull: DRIFTS changes a type (written + alert), BREAK drops the date (not written + alert), ERR errors.
  const drifted = await syncAndWait('EOD drifted', ['DRIFTS', 'BREAK', 'ERR']);
  assert.equal(drifted.status, 'succeeded', 'some symbols succeeded, so the sync did not fail');
  const rows = await ok(`/mongodb/${mongoId}/collections/eod_prices/documents?limit=50`);
  const bySymbol = (s: string) => rows.documents.filter((d: any) => d.symbol === s).length;
  assert.deepEqual([bySymbol('GOOD'), bySymbol('DRIFTS'), bySymbol('BREAK'), bySymbol('ERR')], [3, 3, 0, 0]);
  const alerts = await ok('/datasets/drift');
  const got = alerts.map((a: any) => `${a.collection}:${a.kind}:${a.field}:${a.breaking}`).sort();
  assert.deepEqual(got, ['eod_prices:missing_field:date:true', 'eod_prices:type_change:close:false']);
  const health = await ok('/datasets/health');
  assert.equal(health.kpis.drift, 2);
  const cat = await ok('/catalog/eod_prices');
  assert.ok(
    cat.caveats.some((c: any) => c.severity === 'blocking' && /date missing field/.test(c.text)),
    JSON.stringify(cat.caveats),
  );
  // Resolving clears it from Health and the catalog.
  for (const a of alerts) await ok(`/datasets/drift/${encodeURIComponent(a.id)}/resolve`, {});
  assert.equal((await ok('/datasets/health')).kpis.drift, 0);
  assert.ok(!(await ok('/catalog/eod_prices')).caveats.some((c: any) => /Schema drift/.test(c.text)));
});
