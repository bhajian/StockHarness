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
  // A short holdout for the 160-day synthetic history: locked from 2024-07-09 (last day 2024-08-09).
  const settings = await ok('/evaluator/settings', { holdoutMonths: 1 }, 'PUT');
  assert.equal(settings.holdoutStart, '2024-07-09');
  assert.equal(settings.readableEnd, '2024-07-08');
  await ok('/strategy-plugins', { name: 'momentum_40d', code: MOMENTUM, description: '40-day momentum' });
});

test('an evaluation runs in the executor and is reproducible', async () => {
  const body = {
    plugin: 'momentum_40d',
    params: {
      start: DAYS[45],
      end: DAYS[130],
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
  assert.ok(r.summary.rebalances >= 15, String(r.summary.rebalances));
  assert.ok(Number.isFinite(r.summary.sharpe));
  assert.ok(Object.keys(r.holdings.weights).length === 3);
  assert.ok(!('SEC_000000' in r.holdings.weights), 'scope applied');
  assert.equal(r.series.dates.length, r.series.series.equity.length);
  assert.ok(r.reader.reads > 0 && r.reader.lookahead_attempts === 0);
  // #324: how each name held did, only names in scope, with their tickers.
  assert.ok(
    r.by_name.names >= 3 && r.by_name.rows.length === r.by_name.names,
    JSON.stringify(r.by_name).slice(0, 300),
  );
  assert.ok(r.by_name.rows.every((x: any) => x.security_id !== 'SEC_000000' && x.ticker && x.by_year));
  assert.equal(
    r.by_name.rows.reduce((n: number, x: any) => n + x.trades, 0),
    r.trade_stats.count,
    'every trade belongs to a name',
  );
  const b = await evaluate(body);
  assert.equal(b.record.record_hash, r.record_hash, 'same inputs, identical record');
  assert.ok(b.trial > a.trial, 'every evaluation is a trial');
  assert.equal(b.record.trial_context.trials, b.trial, 'the deflated Sharpe uses the global trial count');
  assert.ok(b.record.trial_context.sr_variance > 0 || a.trial === 1);
  assert.ok(b.record.excess.spx && b.record.factors.betas.market !== undefined);
  const list = await ok('/evaluations');
  assert.ok(list.trials >= 2 && list.items.length >= 2 && !list.items[0].record?.series);
});

test('name subsets: picked on the first part, checked on the rest against random sets (#325)', async () => {
  const parent = await evaluate({ plugin: 'momentum_40d', params: { start: DAYS[0], end: DAYS[134] } });
  assert.equal(parent.status, 'succeeded', JSON.stringify(parent.error));
  const bad = await request(`/evaluations/${parent.id}/subset`, { top_k: 4, n_random: 5 });
  assert.equal(bad.status, 400, 'fewer than 19 random sets can never pass at 5%');
  const started = await ok(`/evaluations/${parent.id}/subset`, { top_k: 4, n_random: 19, min_days: 5 });
  assert.equal(started.subsetOf, parent.id);
  assert.ok(started.trial > parent.trial, 'a subset search is a trial');
  let e = started;
  for (let i = 0; i < 300 && e.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    e = await ok(`/evaluations/${started.id}`);
  }
  assert.equal(e.status, 'succeeded', JSON.stringify(e.error));
  const s = e.record.subset;
  assert.equal(s.chosen.length, 4);
  assert.equal(e.record.period.start, s.check_period.start, 'the record is the check run');
  assert.ok(s.check_period.start > s.pick_period.end);
  assert.deepEqual([...e.record.params.symbols].sort(), s.chosen.map((c: any) => c.security_id).sort());
  assert.equal(s.random.n, 19);
  assert.equal(typeof s.passed, 'boolean');
  assert.ok(Object.keys(e.record.holdings.weights).every((id) => e.record.params.symbols.includes(id)));
  const listed = await ok(`/evaluations?subsetOf=${parent.id}`);
  assert.deepEqual(
    listed.items.map((x: any) => x.id),
    [started.id],
  );
  assert.equal(
    (await request(`/evaluations/${started.id}/subset`, {})).status,
    409,
    'not a subset of a subset',
  );
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

test('exploration stops before the holdout; the holdout is one shot', async () => {
  const inside = await request('/evaluations', {
    plugin: 'momentum_40d',
    params: { start: DAYS[45], end: DAYS[150] },
  });
  assert.equal(inside.status, 400);
  assert.match(inside.data.error, /inside the locked holdout \(from 2024-07-09\)/);
  const h = await ok('/evaluations/holdout', { plugin: 'momentum_40d', theoryId: 'T-1' });
  assert.equal(h.mode, 'holdout');
  assert.deepEqual([h.params.start, h.params.end], ['2024-07-09', DAYS[159]]);
  let done = h;
  for (let i = 0; i < 240 && done.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    done = await ok(`/evaluations/${h.id}`);
  }
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  assert.equal(done.record.period.readable_end, DAYS[159]);
  const again = await request('/evaluations/holdout', { plugin: 'momentum_40d', theoryId: 'T-1' });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /already used .* one shot/);
  // A new code version is a new shot; the boundary can no longer move.
  const plugin = (await ok('/strategy-plugins')).find((p: any) => p.name === 'momentum_40d');
  await ok(`/strategy-plugins/${plugin.id}`, { code: MOMENTUM.replace('"top_n": 3', '"top_n": 4') }, 'PUT');
  assert.equal(
    (await request('/evaluations/holdout', { plugin: 'momentum_40d', theoryId: 'T-1' })).status,
    202,
  );
  assert.equal((await request('/evaluator/settings', { holdoutMonths: 3 }, 'PUT')).status, 409);
  const folds = done.record.folds;
  assert.deepEqual(
    folds.map((f: any) => f.fold),
    ['2024'],
  );
});

test('research data tools over MCP: discovered by the platform, capped at the holdout', async () => {
  const conn = await ok('/connections', { name: 'Research data', kind: 'research', url: '' });
  assert.equal(conn.builtIn, true);
  const discovered = await ok(`/connections/${conn.id}/discover`, {});
  const names = (discovered.tools ?? discovered).map((t: any) => t.name).sort();
  for (const n of ['describe_collection', 'list_collections', 'query_collection', 'sample_collection'])
    assert.ok(names.includes(n), `${n} in ${names}`);
  // Call it like any MCP client: the token names the connection and is signed for its workspace.
  const env = await readFile('.env', 'utf8');
  process.env.ENCRYPTION_KEY = env
    .split('\n')
    .find((l) => l.startsWith('ENCRYPTION_KEY='))!
    .slice(15);
  process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
  const { researchToken } = await import('../../packages/core/src/dataTools.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const me = await ok('/auth/me');
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp/research`), {
      requestInit: { headers: { Authorization: `Bearer ${researchToken(me.tenantId, conn.id)}` } },
    }),
  );
  const r: any = await client.callTool({
    name: 'query_collection',
    arguments: { collection: 'prices_daily', sort: { date: -1 }, limit: 3, as_of: '2030-01-01' },
  });
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.as_of, '2024-07-08', 'the holdout caps the session; as_of cannot move later');
  assert.ok(body.rows.every((row: any) => row.as_of_date <= '2024-07-08'));
  await client.close();
  const denied = await fetch(`${base}/mcp/research`, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401);
});

test('the run-test-fix loop: a scripted Coder fixes three seeded bugs with test_strategy', async () => {
  const conn = (await ok('/connections')).find((c: any) => c.kind === 'research');
  await ok(`/connections/${conn.id}/discover`, {});
  const provider = await ok('/providers', {
    name: 'Coder fixture',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-coder',
    contextWindow: 200000,
    maxOutputTokens: 1024,
  });
  const agent = await ok('/agents', {
    name: 'Coder',
    providerId: provider.id,
    systemPrompt: 'Write strategy plugins, test them with test_strategy and fix them until they pass.',
    connections: [{ connectionId: conn.id, tools: ['test_strategy'] }],
    maxTurns: 10,
  });
  let run = await ok('/runs', { agentId: agent.id, input: 'strategy fix loop' });
  for (let i = 0; i < 180 && ['queued', 'running'].includes(run.status); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    run = await ok(`/runs/${run.id}`);
  }
  assert.equal(run.status, 'succeeded', run.error);
  assert.match(run.output, /LOOP-DONE after 4 attempts/);
  const plugin = (await ok('/strategy-plugins')).find((p: any) => p.name === 'coder_fixed');
  const versions = await ok(`/strategy-plugins/${plugin.id}/versions`);
  assert.deepEqual(
    versions.map((v: any) => [v.version, (v.error ?? 'passed').split(':')[0]]),
    [
      [4, 'passed'],
      [3, 'PluginError'],
      [2, 'warnings'],
      [1, 'KeyError'],
    ],
    'every attempt is a version with its outcome',
  );
  assert.equal(versions[0].tested, 'passed');
  const list = await ok('/evaluations');
  assert.ok(!list.items.some((e: any) => e.pluginName === 'coder_fixed'), 'testing is never a trial');
});
