// #118 on the real stack: the Ideas API over theories produced through the lifecycle tools: filters, detail,
// debate chips, code versions, human actions (send back reaches the Theorist), reproduce, compare, export.
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
  const isolated = { email: `ideas-${randomUUID()}@openharness.test`, password: credentials.password };
  await ok('/users', { ...isolated, name: 'Ideas', workspace: 'new' });
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
const theory = (title: string, family: string) => ({
  title,
  hypothesis: `${title}: the ranking predicts the next month of returns in liquid names.`,
  signal_logic: `Rank by the signal described in the title; long the top 3, weekly (${family}).`,
  falsification: 'No excess over the S&P 500.',
  data_needed: ['prices_daily.tr_1d'],
  family,
  reasoning: 'Test idea',
});
async function toPostReview(id: string, code: string, brokenFirst = false) {
  await clients.judge.call('review_theory', { theory_id: id, decision: 'approve', reasoning: 'Testable' });
  if (brokenFirst)
    assert.equal(
      (
        await clients.coder.call('submit_code', {
          theory_id: id,
          code: code.replace('g.tr_1d', 'g["tr_1dd"]'),
        })
      ).passed,
      false,
    );
  assert.equal((await clients.coder.call('submit_code', { theory_id: id, code })).passed, true);
  await clients.coder.call('evaluate_strategy', { theory_id: id, params });
}

test('ideas: list, detail, debate, code, actions, reproduce, compare, export', async () => {
  const { theorist, judge } = clients;
  await theorist.call('submit_theory', theory('Forty-day trend followers', 'momentum'));
  await theorist.call('submit_theory', theory('Twenty-day losers bounce back', 'reversal'));
  await toPostReview('T-1', GOOD, true);
  const reversal = GOOD.replace('float(np.prod(1 + g.tr_1d) - 1)', '-float(np.prod(1 + g.tr_1d) - 1)');
  await toPostReview('T-2', reversal);
  const lenient = await ok('/research/gates', {
    minSharpe: -10,
    minDeflatedSharpe: 0,
    minPositiveExcessYears: 0,
    minTrades: 1,
    minHoldings: 1,
    minAlphaT: -100,
    minHoldoutExcess: -10,
    minHoldoutSharpe: -100,
  });
  const evalOf = async (id: string) =>
    (await ok(`/ideas/${id}/evaluations`)).find((e: any) => e.mode === 'explore');
  const sharpe = (await evalOf('T-1')).summary.sharpe as number;
  const v1 = await judge.call('set_verdict', {
    theory_id: 'T-1',
    verdict: 'successful',
    reasoning: `Sharpe ${sharpe.toFixed(3)} holds; I also saw Sharpe 9.99 somewhere.`,
  });
  assert.equal(v1.status, 'successful', JSON.stringify(v1));
  await ok('/research/gates', { ...lenient, minSharpe: 50 });
  assert.equal(
    (
      await judge.call('set_verdict', {
        theory_id: 'T-2',
        verdict: 'failed',
        reasoning: 'Below the Sharpe gate.',
      })
    ).status,
    'failed',
  );

  const all = await ok('/ideas');
  assert.deepEqual([all.kpis.successful, all.kpis.failed, all.kpis.total], [1, 1, 2]);
  assert.equal(all.items[0].ref, 'T-1', 'sorted by deflated Sharpe');
  assert.ok(all.items[0].spark.length > 5 && all.items[0].holdout?.status === 'succeeded');
  assert.deepEqual(
    (await ok('/ideas?status=successful,approved')).items.map((i: any) => i.ref),
    ['T-1'],
  );
  assert.deepEqual(
    (await ok('/ideas?status=failed')).items.map((i: any) => i.ref),
    ['T-2'],
    'failed ideas are one filter away',
  );
  assert.deepEqual(
    (await ok('/ideas?q=losers')).items.map((i: any) => i.ref),
    ['T-2'],
  );
  assert.deepEqual(
    (await ok('/ideas?family=momentum&data=prices_daily')).items.map((i: any) => i.ref),
    ['T-1'],
  );
  assert.equal((await ok('/ideas?sort=recent')).items[0].ref, 'T-2');

  const idea = await ok('/ideas/T-1');
  assert.equal(idea.gates.final, true);
  assert.ok(idea.gates.results.some((g: any) => g.gate === 'holdout_sharpe'));
  assert.match(idea.judgeSummary.reasoning, /Sharpe/);
  assert.equal(idea.explore.recordHash.startsWith('sha256:'), true);
  assert.equal(idea.holdoutEvaluation.mode, 'holdout');
  assert.ok(idea.models.judge?.includes('fixture:judge'));
  assert.deepEqual(idea.actions, { approve: true, park: true, reject: true, sendBack: true });

  const debate = await ok('/ideas/T-1/debate');
  const verdict = debate.find((d: any) => d.to === 'successful');
  const chips = Object.fromEntries(verdict.numbers.map((c: any) => [c.text, c.evaluationId]));
  assert.equal(chips[sharpe.toFixed(3)], idea.explore.id, 'a cited number links to its evaluation');
  assert.equal(chips['9.99'], null, 'an unsourced number is flagged');

  const code = await ok('/ideas/T-1/code');
  assert.deepEqual(
    code.versions.map((v: any) => v.version),
    [2, 1],
  );
  assert.equal(code.selected.version, 2);
  assert.equal(code.previous.version, 1, 'the previous version, for the diff');
  assert.equal(code.selected.code, GOOD);
  assert.match(
    code.versions.find((v: any) => v.version === 1).error,
    /KeyError/,
    'the failed attempt and its error',
  );
  assert.match((await ok('/ideas/T-1/code?version=1')).selected.code, /tr_1dd/);

  const trialsBefore = (await ok('/evaluations')).trials;
  const rep = await ok('/ideas/T-1/reproduce', {});
  assert.equal(rep.reproduction.status, 'succeeded');
  assert.equal(rep.reproduction.reproduces.match, true, 're-running gives the identical record');
  assert.equal((await ok('/evaluations')).trials, trialsBefore, 'reproducing is not a new trial');

  assert.equal((await ok('/ideas/T-1/actions', { action: 'approve' })).status, 'approved');
  await ok('/ideas/T-1/comments', { text: 'Worth a paper run once M6 lands.' });
  const rejected = await request('/ideas/T-1/actions', { action: 'reject' });
  assert.equal(rejected.status, 400, 'a rejection needs a reason');
  assert.equal(
    (await ok('/ideas/T-1/actions', { action: 'reject', comment: 'Concentrated in two names.' })).status,
    'failed',
  );
  const sent = await ok('/ideas/T-2/actions', {
    action: 'send_back',
    comment: 'Use a 10-day window and skip the last day.',
  });
  assert.equal(sent.status, 'revise');
  const brief = await theorist.call('get_research_brief', {});
  const item = brief.queue.find((q: any) => q.theory_id === 'T-2');
  assert.deepEqual(
    item.feedback,
    { by: 'human', reasoning: 'Use a 10-day window and skip the last day.' },
    'send back reaches the Theorist',
  );
  const d1 = await ok('/ideas/T-1/debate');
  assert.ok(d1.some((d: any) => d.type === 'comment' && d.reasoning.includes('paper run')));
  assert.ok(d1.some((d: any) => d.role === 'human' && d.to === 'failed'));

  const cmp = await ok('/ideas/compare?ids=T-1,T-2');
  assert.deepEqual(
    cmp.metrics.map((m: any) => m.ref),
    ['T-1', 'T-2'],
  );
  assert.equal(cmp.correlation[0][0], 1);
  assert.equal(cmp.holdingsOverlap.length, 2);
  assert.deepEqual(Object.keys(cmp.equity.series).sort(), ['T-1', 'T-2']);

  const yaml = await ok('/ideas/T-1/export');
  assert.match(yaml, /kind: StrategyPlugin[\s\S]*kind: Evaluation[\s\S]*kind: Theory/);
  assert.match(yaml, /history:\n\s+- version: 1/, 'every code version');
  const owner = cookie;
  const fresh = {
    email: `ideas-copy-${randomUUID()}@openharness.test`,
    password: 'Integration-test-password-42',
  };
  const loginAs = async (c: { email: string; password: string }) => {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    });
    cookie = res.headers.get('set-cookie')!.split(';')[0];
  };
  await loginAs({ email: 'admin@openharness.test', password: 'Integration-test-password-42' });
  await ok('/users', { ...fresh, name: 'Ideas copy', workspace: 'new' });
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(fresh),
  });
  cookie = r.headers.get('set-cookie')!.split(';')[0];
  const imported = await ok('/objects/import', { yaml, dryRun: false });
  assert.equal(imported.applied, true, JSON.stringify(imported));
  assert.equal(
    await ok('/ideas/T-1/export'),
    yaml,
    'export -> import into an empty workspace -> export is identical',
  );
  cookie = owner;
});
