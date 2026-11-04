// #98/#99 the migrated Layer 2 transforms, imported from the repo YAML (deploy/config-io/exports/transforms.yaml)
// into an isolated workspace and run in the real Python executor. Real stack.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
let cookie = '';
let mongoId = '';
const repoYaml = await readFile('deploy/config-io/exports/transforms.yaml', 'utf8');
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
/** A date from the documents API (BSON dates come back as Extended JSON). */
const day = (v: any) => String(v?.$date ?? v).slice(0, 10);
const docs = async (c: string, q = '') => ok(`/mongodb/${mongoId}/collections/${c}/documents?limit=200${q}`);
const insert = (c: string, documents: object[]) =>
  ok(`/mongodb/${mongoId}/collections`, { name: c })
    .catch(() => undefined)
    .then(() => ok(`/mongodb/${mongoId}/collections/${c}/documents`, { documents }));
const transformId = async (name: string) => (await ok('/transforms')).find((t: any) => t.name === name).id;
async function runAndWait(name: string, body: object = {}) {
  const id = await transformId(name);
  const before = (await ok(`/transforms/${id}/runs`)).length;
  await ok(`/transforms/${id}/run`, body);
  for (let i = 0; i < 300; i++) {
    const runs = await ok(`/transforms/${id}/runs`);
    if (
      runs.length > before &&
      runs.slice(0, runs.length - before).every((r: any) => !['queued', 'running'].includes(r.status))
    ) {
      const detail = await ok(`/transform-runs/${runs[0].id}`);
      return detail;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${name} did not finish`);
}
const weekdays = (from: string, to: string) => {
  const out: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000)
    if (![0, 6].includes(new Date(t).getUTCDay())) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

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
  const isolated = { email: `layer2-${randomUUID()}@openharness.test`, password: credentials.password };
  await ok('/users', { ...isolated, name: 'Layer 2', workspace: 'new' });
  await login(isolated);
  mongoId = (await ok('/connections', { name: 'MongoDB', kind: 'mongodb', builtIn: true, url: '' })).id;
  // A disabled company_profiles sync, so the securities trigger (after dataset:company_profiles) validates.
  const fmp = await ok('/connections', { name: 'FMP', url: 'http://fixtures:9090/mcp' });
  await ok('/dataset-syncs', {
    name: 'L1 — Company profiles',
    connectionId: fmp.id,
    dataset: 'company_profiles',
    symbolsMode: 'list',
    symbols: ['AAA'],
    enabled: false,
    schedule: { enabled: false, everyMinutes: 1440, input: 'Run the scheduled task.' },
  });
  await insert('company_profiles', [
    {
      symbol: 'AAA',
      companyName: 'Alpha Inc',
      cik: '0000000001',
      sector: 'Technology',
      industry: 'Software',
      exchange: 'NASDAQ',
      ipoDate: '1999-01-04',
      isActivelyTrading: true,
    },
    {
      symbol: 'CCC',
      companyName: 'Gamma Corp',
      cik: '0000000003',
      sector: 'Energy',
      industry: 'Oil & Gas',
      exchange: 'NYSE',
      ipoDate: '2001-06-01',
      isActivelyTrading: true,
    },
    { symbol: 'EEE', companyName: 'An ETF', exchange: 'NYSE', isEtf: true },
  ]);
  await insert('stock_list', [
    { symbol: 'AAA', companyName: 'Alpha Inc' },
    { symbol: 'ZZZ', companyName: 'Not in the universe' },
  ]);
  await insert('delisted_companies', [
    { symbol: 'DDD', companyName: 'Delta Ltd', delistedDate: '2020-05-01', ipoDate: '2010-01-04' },
  ]);
  await insert('eod_prices', [
    ...weekdays('2016-01-04', '2016-01-15').map((date) => ({ symbol: 'AAA', date, close: 10 })),
    ...weekdays('2020-03-02', '2020-03-06').map((date) => ({ symbol: 'CCC', date, close: 20 })),
    ...weekdays('2018-01-02', '2018-01-05').map((date) => ({ symbol: 'DDD', date, close: 5 })),
  ]);
});

test('the repo YAML imports into an empty workspace and exports back identically', async () => {
  const r = await ok('/objects/import', { yaml: repoYaml, mode: 'merge', dryRun: false });
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(await ok('/objects/export?kinds=Transform'), repoYaml, 'round trip is identical');
  assert.ok(!/apikey|password|secret_value|token:/i.test(repoYaml), 'no secrets in the YAML');
});

test('trading_calendar (M2): NYSE sessions from 1990 through the end of next year', async () => {
  const run = await runAndWait('trading_calendar');
  assert.equal(run.status, 'succeeded', run.stderr);
  const year = new Date().getUTCFullYear();
  const last = (await docs('trading_calendar', `&sort=${encodeURIComponent('{"date":-1}')}`)).documents[0];
  assert.equal(day(last.date), `${year + 1}-12-31`);
  const first = (await docs('trading_calendar', `&sort=${encodeURIComponent('{"date":1}')}`)).documents[0];
  assert.equal(day(first.date), '1990-01-02');
  assert.ok((await docs('trading_calendar')).total > 9000);
});

test('securities (H4, H5, H6): ISO interval bounds, backfilled sector flag, ticker valid from first observation', async () => {
  const run = await runAndWait('securities');
  assert.equal(run.status, 'succeeded', run.stderr);
  const all = (await docs('securities')).documents;
  assert.deepEqual(
    all.map((d: any) => d.name).sort(),
    ['Alpha Inc', 'Delta Ltd', 'Gamma Corp'],
    'the ETF is excluded',
  );
  const aaa = all.find((d: any) => d.name === 'Alpha Inc');
  const ticker = aaa.identifiers.find((i: any) => i.type === 'ticker');
  assert.deepEqual(
    [ticker.value, ticker.valid_from, ticker.valid_to],
    ['AAA', '2016-01-04', null],
    'H6: first observed, not the 1999 IPO',
  );
  assert.equal(aaa.sector_history[0].valid_from, '2016-01-04');
  assert.equal(aaa.sector_is_backfilled, true, 'H5');
  for (const d of all)
    for (const f of ['identifiers', 'sector_history', 'industry_history', 'exchange_history'])
      for (const iv of d[f] ?? [])
        assert.match(String(iv.valid_from), /^\d{4}-\d{2}-\d{2}$/, `H4: ${d.name} ${f}`);
  const ddd = all.find((d: any) => d.name === 'Delta Ltd');
  assert.deepEqual([ddd.is_active, ddd.delisted_date], [false, '2020-05-01']);
  // Idempotent: a re-run writes nothing and keeps the ids.
  const again = await runAndWait('securities');
  assert.deepEqual([again.outputs.securities.written, again.outputs.securities.unchanged], [0, 3]);
  assert.deepEqual(
    (await docs('securities')).documents.map((d: any) => d.security_id).sort(),
    all.map((d: any) => d.security_id).sort(),
  );
  const cat = await ok('/catalog/securities');
  assert.deepEqual(
    [cat.layer, cat.producedBy[0].type, cat.producedBy[0].name],
    [2, 'transform', 'securities'],
  );
});
