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
  // Disabled syncs, so the transforms' dataset triggers validate (each names the collection a sync writes).
  for (const dataset of [
    'company_profiles',
    'income_statement',
    'balance_sheet',
    'cash_flow',
    'dividends_calendar',
    'splits_calendar',
    'eod_prices',
    'treasury_rates',
    'eod_index',
  ])
    await ok('/dataset-syncs', {
      name: `L1 — ${dataset}`,
      connectionId: fmp.id,
      dataset,
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
  await insert('dividends_calendar', [
    { symbol: 'AAA', date: '2016-01-11', dividend: 0.1, declarationDate: '2016-01-04' },
  ]);
  await insert('dividends_history', [{ symbol: 'AAA', date: '2016-01-11', dividend: 0.1 }]);
  await insert('splits_calendar', []).catch(() => undefined);
  await insert('splits_history', [{ symbol: 'CCC', date: '2020-03-04', numerator: 2, denominator: 1 }]);
  await insert('treasury_rates', [{ date: '2016-01-04', year10: 2.2, year2: 1.0, month3: 0.2, year30: 3.0 }]);
  await insert('eod_index', [
    { symbol: '^GSPC', date: '2016-01-04', close: 2000 },
    { symbol: '^GSPC', date: '2016-01-05', close: 2020 },
    { symbol: '^VIX', date: '2016-01-04', close: 20 },
  ]);
  // AAA quarterly statements 2015-Q1..Q4 (filed after each quarter); Q4 restated later; one unbalanced balance sheet.
  const q = [
    ['2015-03-31', 'Q1', '2015-04-28 16:30:00'],
    ['2015-06-30', 'Q2', '2015-07-28 16:30:00'],
    ['2015-09-30', 'Q3', '2015-10-27 16:30:00'],
    ['2015-12-31', 'Q4', '2016-01-26 16:30:00'],
  ];
  await insert('income_statement', [
    ...q.map(([date, period, acceptedDate], i) => ({
      symbol: 'AAA',
      date,
      period,
      acceptedDate,
      fiscalYear: '2015',
      reportedCurrency: 'USD',
      revenue: 100 + i,
      netIncome: 10,
    })),
    {
      symbol: 'AAA',
      date: '2015-12-31',
      period: 'Q4',
      acceptedDate: '2016-03-01 08:00:00',
      fiscalYear: '2015',
      reportedCurrency: 'USD',
      revenue: 90,
      netIncome: 9,
    },
  ]);
  await insert(
    'balance_sheet',
    q.map(([date, period, acceptedDate], i) => ({
      symbol: 'AAA',
      date,
      period,
      acceptedDate,
      totalAssets: 1000,
      totalLiabilities: 600,
      totalEquity: i === 2 ? 100 : 400,
    })),
  );
  await insert(
    'cash_flow',
    q.map(([date, period, acceptedDate]) => ({
      symbol: 'AAA',
      date,
      period,
      acceptedDate,
      operatingCashFlow: 20,
      capitalExpenditure: -5,
      freeCashFlow: 15,
    })),
  );
  await insert('sector_performance', [{ date: '2016-01-04', sector: 'Technology', averageChange: 0.5 }]);
  await insert('eod_prices', [
    // AAA has one zero close (a DQ error) on 2016-01-07.
    ...weekdays('2016-01-04', '2016-01-15').map((date, i) => ({
      symbol: 'AAA',
      date,
      open: 10,
      high: 11 + i,
      low: 9,
      close: date === '2016-01-07' ? 0 : 10 + i,
      volume: 100,
    })),
    ...weekdays('2020-03-02', '2020-03-06').map((date, i) => ({
      symbol: 'CCC',
      date,
      open: 20,
      high: 50,
      low: 5,
      close: i < 2 ? 40 : 20,
      volume: 50,
    })),
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

test('corporate_actions, prices_daily (H1, H2, H3) and macro_daily', async () => {
  const ca = await runAndWait('corporate_actions');
  assert.equal(ca.status, 'succeeded', ca.stderr);
  const actions = (await docs('corporate_actions')).documents;
  assert.deepEqual(actions.map((a: any) => `${a.action_type}:${a.ex_date}`).sort(), [
    'cash_dividend:2016-01-11',
    'split:2020-03-04',
  ]);

  // A full build over the seeded range, then a daily incremental run of a day already built.
  const full = await runAndWait('prices_daily', { range: 'custom', start: '2016-01-04', end: '2020-03-06' });
  assert.equal(full.status, 'succeeded', full.stderr);
  const n = (await docs('prices_daily')).total;
  assert.equal(n, 19, 'every seeded bar: 10 AAA + 5 CCC + 4 for the delisted DDD');
  const dqAfterFull = (
    await docs('dq_issues', `&filter=${encodeURIComponent('{"collection":"prices_daily"}')}`)
  ).total;
  assert.ok(dqAfterFull >= 1, 'the zero close is a DQ issue (H3: the run still succeeded)');
  const daily = await runAndWait('prices_daily', { range: 'custom', start: '2016-01-12', end: '2016-01-12' });
  assert.equal(daily.status, 'succeeded', daily.stderr);
  assert.deepEqual(
    [daily.outputs.prices_daily.written, daily.outputs.prices_daily.unchanged],
    [0, 1],
    'H1: the daily run (with its lookback) computes exactly what the full build wrote',
  );
  assert.ok(daily.reads.eod_prices > 1, 'the lookback was loaded');
  const row = (await docs('prices_daily', `&filter=${encodeURIComponent('{"date":"2016-01-12"}')}`))
    .documents[0];
  assert.equal(typeof row.ret_1d, 'number');
  // H2: re-running does not add DQ issues.
  await runAndWait('prices_daily', { range: 'custom', start: '2016-01-04', end: '2020-03-06' });
  assert.equal(
    (await docs('dq_issues', `&filter=${encodeURIComponent('{"collection":"prices_daily"}')}`)).total,
    dqAfterFull,
  );
  // The CCC split (2-for-1 on 2020-03-04) adjusts the earlier bars.
  const ccc = (await docs('prices_daily', `&filter=${encodeURIComponent('{"date":"2020-03-02"}')}`))
    .documents[0];
  assert.equal(ccc.adj_factor, 0.5);

  const macro = await runAndWait('macro_daily');
  assert.equal(macro.status, 'succeeded', macro.stderr);
  const m = (await docs('macro_daily', `&sort=${encodeURIComponent('{"date":1}')}`)).documents;
  assert.deepEqual(
    m.map((r: any) => r.date),
    ['2016-01-04', '2016-01-05'],
  );
  assert.ok(Math.abs(m[1].spx_ret_1d - 0.01) < 1e-9);
  for (const c of ['corporate_actions', 'prices_daily', 'macro_daily'])
    assert.equal((await ok(`/catalog/${c}`)).producedBy[0].name, c);
});

test('fundamentals_pit (#100): restatement versions, known_at / as_of, TTM as known, balance check', async () => {
  const run = await runAndWait('fundamentals_pit');
  assert.equal(run.status, 'succeeded', run.stderr);
  const rows = (await docs('fundamentals_pit', `&sort=${encodeURIComponent('{"period_end":1,"version":1}')}`))
    .documents;
  assert.deepEqual(
    rows.map((r: any) => `${r.period_end}#${r.version}${r.is_latest ? '*' : ''}`),
    ['2015-03-31#1*', '2015-06-30#1*', '2015-09-30#1*', '2015-12-31#1', '2015-12-31#2*'],
  );
  const [q4v1, q4v2] = rows.slice(3);
  assert.equal(q4v1.known_at, '2016-01-26T21:30:00+00:00', 'Eastern acceptance -> UTC');
  assert.equal(q4v1.as_of_date, '2016-01-27', 'usable from the next session (the calendar)');
  assert.deepEqual(
    [q4v1.ttm_revenue, q4v2.ttm_revenue],
    [406, 393],
    'TTM with Q4 as originally filed, then restated',
  );
  assert.equal(q4v2.as_of_date, '2016-03-01', 'accepted before the open: usable that day');
  assert.equal(q4v1.free_cash_flow, 15);
  const dq = await docs(
    'dq_issues',
    `&filter=${encodeURIComponent('{"collection":"fundamentals_pit","issue_type":"balance_sheet_identity"}')}`,
  );
  assert.equal(dq.total, 1, 'the unbalanced Q3 balance sheet');
  const again = await runAndWait('fundamentals_pit');
  assert.equal(again.outputs.fundamentals_pit.written, 0, 'idempotent');
  const cat = await ok('/catalog/fundamentals_pit');
  assert.deepEqual([cat.layer, cat.timeSemantics.status], [2, 'pit']);
});
