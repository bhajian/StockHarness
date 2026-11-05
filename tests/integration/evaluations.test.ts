// M3 trusted evaluator on the real stack (#104–#109): a StrategyPlugin evaluated in the real Python executor
// against synthetic Layer 2 data in an isolated workspace. Same inputs -> identical record.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
let cookie = '';
let mongoId = '';
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
const insert = (c: string, documents: object[]) =>
  ok(`/mongodb/${mongoId}/collections`, { name: c })
    .catch(() => undefined)
    .then(async () => {
      for (let i = 0; i < documents.length; i += 500)
        await ok(`/mongodb/${mongoId}/collections/${c}/documents`, {
          documents: documents.slice(i, i + 500),
        });
    });
const weekdays = (from: string, n: number) => {
  const out: string[] = [];
  for (let t = Date.parse(from); out.length < n; t += 86400000)
    if (![0, 6].includes(new Date(t).getUTCDay())) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
/** Deterministic pseudo-random returns (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DAYS = weekdays('2024-01-01', 160);
const IDS = Array.from({ length: 12 }, (_, k) => `SEC_${String(k).padStart(6, '0')}`);
export const MOMENTUM = [
  'import numpy as np',
  '',
  'META = {"side": "long", "horizon_days": 20, "rebalance": "weekly", "top_n": 3}',
  '',
  'def signal(ctx):',
  '    f = ctx.read_df("prices_daily", columns=["security_id", "tr_1d"], lookback_days=40)',
  '    return {s: float(np.prod(1 + g.tr_1d) - 1) for s, g in f.groupby("security_id")}',
  '',
].join('\n');

async function evaluate(body: object) {
  const e = await ok('/evaluations', body);
  for (let i = 0; i < 240; i++) {
    const cur = await ok(`/evaluations/${e.id}`);
    if (cur.status !== 'running') return cur;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('evaluation did not finish');
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
  const isolated = { email: `evaluator-${randomUUID()}@openharness.test`, password: credentials.password };
  await ok('/users', { ...isolated, name: 'Evaluator', workspace: 'new' });
  await login(isolated);
  mongoId = (await ok('/connections', { name: 'MongoDB', kind: 'mongodb', builtIn: true, url: '' })).id;
  const rand = rng(7);
  const drift = IDS.map((_, k) => (k - 6) * 0.0004);
  const prices: object[] = [];
  const universe: object[] = [];
  const macro: object[] = [];
  for (const d of DAYS) {
    let sum = 0;
    IDS.forEach((s, k) => {
      const r = Math.round((drift[k] + (rand() - 0.5) * 0.03) * 1e8) / 1e8;
      sum += r;
      prices.push({ security_id: s, date: d, as_of_date: d, tr_1d: r, ret_1d: r, ticker: `T${k}` });
      universe.push({ security_id: s, date: d, as_of_date: d, in_universe: true });
    });
    macro.push({ date: d, as_of_date: d, spx_ret_1d: sum / IDS.length });
  }
  await insert('prices_daily', prices);
  await insert('universe_daily', universe);
  await insert('macro_daily', macro);
  await insert(
    'securities',
    IDS.map((s, k) => ({
      security_id: s,
      is_active: true,
      identifiers: [{ type: 'ticker', value: `T${k}` }],
    })),
  );
  await insert(
    'trading_calendar',
    DAYS.map((d) => ({ date: d, is_trading_day: true })),
  );
  await ok('/catalog/refresh', {});
  await ok('/strategy-plugins', { name: 'momentum_40d', code: MOMENTUM, description: '40-day momentum' });
});

test('an evaluation runs in the executor and is reproducible', async () => {
  const body = {
    plugin: 'momentum_40d',
    params: {
      start: DAYS[45],
      end: DAYS[159],
      symbols: ['T1', 'T2', 'SEC_000003', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11'],
    },
  };
  const a = await evaluate(body);
  assert.equal(a.status, 'succeeded', JSON.stringify(a.error));
  const r = a.record;
  assert.equal(r.evaluator_version, '1.0.0');
  assert.equal(r.plugin.name, 'momentum_40d');
  assert.match(r.plugin.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.period.first_trade, DAYS[46], 'executed at the next close');
  assert.ok(r.summary.rebalances >= 20);
  assert.ok(Number.isFinite(r.summary.sharpe));
  assert.ok(Object.keys(r.holdings.weights).length === 3);
  assert.ok(!('SEC_000000' in r.holdings.weights), 'scope applied');
  assert.equal(r.series.dates.length, r.series.series.equity.length);
  assert.ok(r.reader.reads > 0 && r.reader.lookahead_attempts === 0);
  const b = await evaluate(body);
  assert.equal(b.record.record_hash, r.record_hash, 'same inputs, identical record');
  assert.ok(b.trial > a.trial, 'every evaluation is a trial');
  const list = await ok('/evaluations');
  assert.ok(list.trials >= 2 && list.items.length >= 2 && !list.items[0].record?.series);
});

test('a contract violation fails with its line', async () => {
  await ok('/strategy-plugins', {
    name: 'broken',
    code: MOMENTUM.replace('import numpy as np', 'import numpy as np\nx = ctx_eval = eval("1")'),
  });
  const e = await evaluate({ plugin: 'broken', params: { start: DAYS[45], end: DAYS[80] } });
  assert.equal(e.status, 'failed');
  assert.equal(e.error.type, 'PluginError');
  assert.ok(
    e.error.problems.some((p: string) => p.startsWith('line 2: eval')),
    JSON.stringify(e.error),
  );
});
