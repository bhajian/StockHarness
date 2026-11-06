// #125 on the real stack: simulations of ideas produced through the lifecycle tools. A one-idea simulation with the
// defaults reproduces its evaluation; the ledger endpoints; the holdout guard; determinism; two ideas as one book;
// the SimulationConfig / SimulationRun YAML round trip into an empty workspace; delete.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
let cookie = '';
let login: (c: { email: string; password: string }) => Promise<void>;
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
const weekdays = (from: string, n: number) => {
  const out: string[] = [];
  for (let t = Date.parse(from); out.length < n; t += 86400000)
    if (![0, 6].includes(new Date(t).getUTCDay())) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const DAYS = weekdays('2024-01-01', 160);
const GOOD = [
  'import numpy as np',
  'META = {"side": "long", "horizon_days": 20, "rebalance": "weekly", "top_n": 3}',
  '',
  'def signal(ctx):',
  '    f = ctx.read_df("prices_daily", columns=["security_id", "tr_1d"], lookback_days=40)',
  '    return {s: float(np.prod(1 + g.tr_1d) - 1) for s, g in f.groupby("security_id")}',
  '',
].join('\n');
type Client = {
  call: (name: string, args: object, agent?: object) => Promise<any>;
  tools: () => Promise<string[]>;
};
const clients: Record<'theorist' | 'judge' | 'coder', Client> = {} as any;

before(async () => {
  const credentials = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  const env = await readFile('.env', 'utf8');
  if ((await ok('/auth/status')).needsSetup) {
    const setupToken = env
      .split('\n')
      .find((l) => l.startsWith('SETUP_TOKEN='))!
      .slice(12);
    await ok('/auth/setup', { ...credentials, name: 'Test administrator', setupToken });
  }
  login = async (c: { email: string; password: string }) => {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    });
    assert.equal(r.status, 200);
    cookie = r.headers.get('set-cookie')!.split(';')[0];
  };
  await login(credentials);
  const isolated = { email: `sims-${randomUUID()}@openharness.test`, password: credentials.password };
  await ok('/users', { ...isolated, name: 'Simulations', workspace: 'new' });
  await login(isolated);
  const mongo = await ok('/connections', { name: 'MongoDB', kind: 'mongodb', builtIn: true, url: '' });
  const insert = async (c: string, docs: object[]) => {
    await ok(`/mongodb/${mongo.id}/collections`, { name: c });
    for (let i = 0; i < docs.length; i += 500)
      await ok(`/mongodb/${mongo.id}/collections/${c}/documents`, { documents: docs.slice(i, i + 500) });
  };
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.03;
  const ids = Array.from({ length: 8 }, (_, k) => `SEC_${String(k).padStart(6, '0')}`);
  const prices: object[] = [];
  const uni: object[] = [];
  const macro: object[] = [];
  for (const d of DAYS) {
    let sum = 0;
    ids.forEach((s, k) => {
      const r = Math.round((rnd() + (k - 4) * 0.0004) * 1e8) / 1e8;
      sum += r;
      prices.push({ security_id: s, date: d, as_of_date: d, tr_1d: r });
      uni.push({ security_id: s, date: d, as_of_date: d, in_universe: true });
    });
    macro.push({ date: d, as_of_date: d, spx_ret_1d: sum / ids.length });
  }
  await insert('prices_daily', prices);
  await insert('universe_daily', uni);
  await insert('macro_daily', macro);
  await insert(
    'securities',
    ids.map((s, k) => ({
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
  await ok('/evaluator/settings', { holdoutMonths: 1 }, 'PUT');
  // A theory's evaluation runs on the research scope (#319): the synthetic names.
  await ok('/research/settings', { evaluationSymbols: ids }, 'PUT');

  process.env.ENCRYPTION_KEY = env
    .split('\n')
    .find((l) => l.startsWith('ENCRYPTION_KEY='))!
    .slice(15);
  process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
  const { researchToken } = await import('../../packages/core/src/dataTools.js');
  const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const me = await ok('/auth/me');
  for (const role of ['theorist', 'judge', 'coder'] as const) {
    const conn = await ok('/connections', { name: `Research ${role}`, kind: 'research', url: '', role });
    assert.equal(conn.role, role);
    const client = new McpClient({ name: role, version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp/research`), {
        requestInit: { headers: { Authorization: `Bearer ${researchToken(me.tenantId, conn.id)}` } },
      }),
    );
    clients[role] = {
      tools: async () => (await client.listTools()).tools.map((t) => t.name),
      call: async (name, args, agent = { agentId: `${role}-agent`, model: `fixture:${role}` }) => {
        const r: any = await client.callTool(
          { name, arguments: args as Record<string, unknown>, _meta: { 'openharness/agent': agent } },
          undefined,
          { timeout: 120000 },
        );
        const text = r.content?.[0]?.text ?? '';
        if (r.isError) return { error: text };
        return JSON.parse(text);
      },
    };
  }
});

const params = { start: DAYS[45], end: DAYS[120] };
const REVERSAL = GOOD.replace('float(np.prod(1 + g.tr_1d) - 1)', '-float(np.prod(1 + g.tr_1d) - 1)').replace(
  'lookback_days=40',
  'lookback_days=20',
);
async function idea(title: string, family: string, code: string) {
  const t = await clients.theorist.call('submit_theory', {
    title,
    hypothesis: `${title}: the ranking predicts the next month of returns in liquid names.`,
    signal_logic: `Rank by the signal described in the title; long the top 3, weekly (${family}).`,
    falsification: 'No excess over the S&P 500.',
    data_needed: ['prices_daily.tr_1d'],
    family,
    reasoning: 'Simulation test idea',
  });
  await clients.judge.call('review_theory', {
    theory_id: t.theory_id,
    decision: 'approve',
    reasoning: 'Testable',
  });
  assert.equal((await clients.coder.call('submit_code', { theory_id: t.theory_id, code })).passed, true);
  const ev = await clients.coder.call('evaluate_strategy', { theory_id: t.theory_id, params });
  assert.equal(ev.status, 'succeeded', JSON.stringify(ev));
  return { ref: t.theory_id as string, evaluationId: ev.evaluation_id ?? ev.id };
}
async function finished(id: string) {
  for (let i = 0; i < 120; i++) {
    const s = await ok(`/simulations/${id}`);
    if (s.status !== 'running') return s;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('the simulation did not finish');
}
let momentum: { ref: string };
let reversal: { ref: string };
let simId = '';

test('a one-idea simulation with the defaults reproduces its evaluation', async () => {
  momentum = await idea('Forty-day trend followers', 'momentum', GOOD);
  const config = {
    name: 'Momentum alone',
    ideas: [{ idea: momentum.ref }],
    period: { start: params.start, end: params.end },
    capital: 100000,
  };
  const est = await ok('/simulations/estimate', { config });
  assert.equal(est.config.ideas[0].plugin, 't1_forty_day_trend_followers');
  assert.equal(est.config.ideas[0].version, 1, 'the latest version that passed its test is pinned');
  assert.ok(est.estimate.seconds > 0 && est.estimate.days > 50);
  const started = await ok('/simulations', { config });
  assert.equal(started.status, 'running');
  const s = await finished(started.id);
  assert.equal(s.status, 'succeeded', JSON.stringify(s.error));
  simId = s.id;
  const r = s.result;
  assert.ok(r.reconciliation.max_nav_error < 1e-6 && r.reconciliation.max_pnl_error < 1e-6);
  // The evaluation of the same idea, period and scope.
  const evals = await ok(`/ideas/${momentum.ref}/evaluations`);
  const ev = await ok(`/evaluations/${evals.find((e: any) => e.mode === 'explore').id}`);
  assert.deepEqual(r.series.dates, ev.record.series.dates);
  const gap = Math.max(
    ...r.series.series.equity.map((x: number, i: number) => Math.abs(x - ev.record.series.series.equity[i])),
  );
  assert.ok(gap < 1e-8, `equity differs from the evaluation by ${gap}`);
  assert.equal(r.summary.final_nav, Math.round(100000 * r.series.series.equity.at(-1) * 100) / 100);

  const list = await ok('/simulations');
  const row = list.find((x: any) => x.id === simId);
  assert.deepEqual([row.name, row.status, row.ideas], ['Momentum alone', 'succeeded', [momentum.ref]]);
  assert.equal(typeof row.sharpe, 'number');
  const configs = await ok('/simulations/configs');
  assert.ok(configs.some((c: any) => c.name === 'Momentum alone' && c.config.ideas[0].version === 1));
});

test('the ledger: trades, a trade with its fills and prices, orders with their signal, positions, series', async () => {
  const trades = await ok(`/simulations/${simId}/trades?sort=pnl&limit=5`);
  assert.ok(trades.total > 0);
  assert.ok(trades.items.length <= 5);
  assert.ok(trades.items[0].pnl >= trades.items.at(-1).pnl, 'sorted by P&L');
  const first = trades.items[0];
  assert.ok(['replaced', 'open'].includes(first.exit_reason));
  const detail = await ok(`/simulations/${simId}/trades/${first.n}`);
  assert.equal(detail.trade.security_id, first.security_id);
  assert.ok(detail.orders.length >= 1 && detail.orders[0].fill_date === first.entry_date);
  assert.ok(detail.prices.length > 10);
  const orders = await ok(`/simulations/${simId}/orders?limit=3`);
  assert.equal(orders.items[0].idea_id, momentum.ref);
  assert.deepEqual(Object.keys(orders.items[0].signal).sort(), ['date', 'of', 'rank', 'score']);
  const mid = DAYS[90];
  const pos = await ok(`/simulations/${simId}/positions?date=${mid}`);
  assert.ok(pos.date <= mid);
  assert.equal(pos.positions.length, 3, 'top 3');
  const weights = pos.positions.reduce((a: number, p: any) => a + p.weight, 0);
  assert.ok(Math.abs(weights + pos.portfolio.cash / pos.portfolio.nav - 1) < 1e-6);
  const eq = await ok(`/simulations/${simId}/series?metric=equity`);
  assert.equal(eq.values.length, eq.dates.length);
  assert.equal((await request(`/simulations/${simId}/series?metric=nope`)).status, 400);
});

test('the holdout guard, determinism and an idea without code', async () => {
  const { readableEnd } = await ok('/evaluator/settings');
  const late = {
    name: 'Into the holdout',
    ideas: [{ idea: momentum.ref }],
    period: { start: params.start, end: DAYS.at(-1) },
  };
  const refused = await request('/simulations', { config: late });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, new RegExp(`inside the locked holdout \\(after ${readableEnd}\\)`));
  const allowed = await ok('/simulations', {
    config: { ...late, period: { ...late.period, allowHoldout: true } },
  });
  const h = await finished(allowed.id);
  assert.equal(h.status, 'succeeded', JSON.stringify(h.error));
  assert.equal(h.usesHoldout, true);
  // Same config, same ledger.
  const again = await finished(
    (
      await ok('/simulations', {
        config: { name: 'Momentum alone', ideas: [{ idea: momentum.ref }], period: params, capital: 100000 },
      })
    ).id,
  );
  assert.equal(again.result.ledger_hash, (await ok(`/simulations/${simId}`)).result.ledger_hash);
  const bare = await clients.theorist.call('submit_theory', {
    title: 'Quiet names drift upward',
    hypothesis:
      'Securities with the smallest absolute daily moves over sixty sessions earn more than the index.',
    signal_logic: 'Rank by the mean of |tr_1d| over 60 days ascending; hold the five calmest, monthly.',
    falsification: 'No excess over the S&P 500.',
    data_needed: ['prices_daily.tr_1d'],
    reasoning: 'No code yet',
  });
  const noCode = await request('/simulations/estimate', {
    config: { name: 'x', ideas: [{ idea: bare.theory_id }], period: params },
  });
  assert.equal(noCode.status, 400);
  assert.match(noCode.data.error, /has no code yet/);
});

test('two ideas as one book, with risk parity and quarter-Kelly; attribution adds up', async () => {
  reversal = await idea('Twenty-day losers bounce back', 'reversal', REVERSAL);
  const s = await finished(
    (
      await ok('/simulations', {
        config: {
          name: 'Momentum + reversal',
          ideas: [{ idea: momentum.ref }, { idea: reversal.ref }],
          period: params,
          allocation: 'risk_parity',
          sizing: { mode: 'quarter_kelly' },
          constraints: { positionCap: 0.2 },
          exits: { stop: 0.1, takeProfit: 'p90' },
        },
      })
    ).id,
  );
  assert.equal(s.status, 'succeeded', JSON.stringify(s.error));
  const r = s.result;
  assert.deepEqual(r.ideas.map((i: any) => i.id).sort(), [momentum.ref, reversal.ref].sort());
  const byIdea = r.attribution.by_idea.reduce((a: number, g: any) => a + g.pnl, 0);
  assert.ok(
    Math.abs(byIdea - (r.summary.final_nav - r.summary.capital)) < 1,
    'P&L by idea adds up to the NAV change',
  );
  assert.ok(r.series.series.gross.every((g: number) => g <= 1 + 1e-6));
  const pos = await ok(`/simulations/${s.id}/positions`);
  assert.ok(
    pos.positions.every((p: any) => Math.abs(p.weight) <= 0.2 + 0.05),
    'capped (plus drift)',
  );
});

test('the S&P 500 proxy scope: the N largest by market cap, for evaluations and simulations (#300)', async () => {
  const ev = await ok('/evaluations', {
    plugin: 't1_forty_day_trend_followers',
    params: { ...params, universe: { top_by_market_cap: 5 } },
  });
  let e = ev;
  for (let i = 0; i < 60 && e.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    e = await ok(`/evaluations/${ev.id}`);
  }
  assert.equal(e.status, 'succeeded', JSON.stringify(e.error));
  assert.deepEqual(e.record.params.universe, { top_by_market_cap: 5 });
  assert.ok(e.record.rebalances.every((r: any) => r.eligible <= 5));
  await ok('/research/settings', { scope: { kind: 'top_market_cap', top: 5 } }, 'PUT');
  const est = await ok('/simulations/estimate', {
    config: { name: 'Scoped', ideas: [{ idea: momentum.ref }], period: params },
  });
  assert.equal(est.config.universeTop, 5, 'a config without a scope takes the research scope');
  assert.equal(est.config.symbols, undefined);
  // A theory is evaluated on the research scope whatever names the Coder passes, or none (#319).
  const scoped = await idea('Scoped trend followers', 'momentum', GOOD);
  const se = await ok(`/evaluations/${scoped.evaluationId}`);
  assert.deepEqual(se.record.params.universe, { top_by_market_cap: 5 }, 'the research scope, not the whole universe');
  assert.equal(se.record.params.symbols, undefined);
  assert.equal(se.record.params.start, params.start, "the Coder's window is kept");
  await ok('/research/settings', { scope: { kind: 'symbols', top: 500 } }, 'PUT');
});

test('SimulationConfig and SimulationRun round trip into an empty workspace; delete', async () => {
  const mine = cookie;
  const exported = await ok('/objects/export?kinds=SimulationConfig,SimulationRun');
  assert.match(exported, /kind: SimulationConfig/);
  assert.match(exported, /kind: SimulationRun/);
  assert.match(exported, /idea: T-1/);
  assert.doesNotMatch(exported, /password|apiKey|secret:/i);
  const single = await ok(`/simulations/${simId}/export`);
  assert.match(single, /name: Momentum alone/);
  const other = {
    email: `sims-empty-${randomUUID()}@openharness.test`,
    password: 'Integration-test-password-42',
  };
  await login({ email: 'admin@openharness.test', password: 'Integration-test-password-42' });
  await ok('/users', { ...other, name: 'Empty', workspace: 'new' });
  await login(other);
  const plan = await ok('/objects/import', { yaml: exported, dryRun: true });
  assert.deepEqual(plan.plan.errors, []);
  const applied = await ok('/objects/import', { yaml: exported, dryRun: false });
  assert.equal(applied.applied, true, JSON.stringify(applied));
  const back = await ok('/objects/export?kinds=SimulationConfig,SimulationRun');
  assert.equal(back, exported, 'export → import → export gives identical YAML');
  const again = await ok('/objects/import', { yaml: exported, dryRun: true });
  assert.ok(again.plan.items.every((i: any) => i.action === 'unchanged'));
  const imported = await ok('/simulations');
  assert.ok(imported.some((x: any) => x.name === 'Momentum alone' && x.status === 'succeeded'));
  cookie = mine;
  const del = await request(`/simulations/${simId}`, undefined, 'DELETE');
  assert.equal(del.status, 204);
  assert.equal((await request(`/simulations/${simId}`)).status, 404);
  assert.equal((await request(`/simulations/${simId}/trades`)).status, 404);
});
