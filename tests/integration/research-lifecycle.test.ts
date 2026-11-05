// #112 on the real stack: the lifecycle MCP tools on research connections with roles. The full happy path and
// both revision paths run through the tools; roles are enforced by the connection, never the prompt.
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
  const isolated = { email: `lifecycle-${randomUUID()}@openharness.test`, password: credentials.password };
  await ok('/users', { ...isolated, name: 'Lifecycle', workspace: 'new' });
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

test('each role is offered only its tools', async () => {
  const has = async (role: keyof typeof clients) =>
    (await clients[role].tools()).filter((n) => /theor|code|verdict/.test(n)).sort();
  assert.deepEqual(await has('theorist'), ['get_theory', 'search_theories', 'submit_theory']);
  assert.deepEqual(await has('judge'), ['get_theory', 'review_theory', 'search_theories', 'set_verdict']);
  assert.deepEqual(await has('coder'), ['get_theory', 'search_theories', 'submit_code']);
});

test('the full lifecycle through the tools, with both revision paths', async () => {
  const { theorist, judge, coder } = clients;
  const t = await theorist.call('submit_theory', {
    title: 'Forty-day trend followers',
    hypothesis: 'Names with the strongest 40-day total return keep outperforming over the next month.',
    signal_logic: 'Rank by the product of (1 + tr_1d) over the last 40 days; long the top 3, weekly.',
    falsification: 'Out-of-sample Sharpe below 0.3.',
    data_needed: ['prices_daily.tr_1d'],
    family: 'momentum',
    reasoning: 'Short-horizon momentum on liquid names',
  });
  assert.deepEqual([t.theory_id, t.status], ['T-1', 'pre_review']);
  assert.match(
    (await coder.call('review_theory', { theory_id: 'T-1', decision: 'approve', reasoning: 'x' })).error,
    /Unknown tool|for the judge/,
  );
  assert.match(
    (await theorist.call('set_verdict', { theory_id: 'T-1', verdict: 'successful', reasoning: 'x' })).error,
    /for the judge|Unknown tool/,
  );
  assert.equal(
    (
      await judge.call('review_theory', {
        theory_id: 'T-1',
        decision: 'revise',
        reasoning: 'Name the rebalance day and the universe.',
      })
    ).status,
    'revise',
  );
  const resubmitted = await theorist.call('submit_theory', {
    theory_id: 'T-1',
    signal_logic:
      'Among universe_daily members, rank by 40-day compounded tr_1d; long the top 3, rebalanced each Monday.',
    reasoning: 'Specified the universe and rebalance day',
  });
  assert.equal(resubmitted.status, 'pre_review');
  assert.equal(
    (
      await judge.call('review_theory', {
        theory_id: 'T-1',
        decision: 'approve',
        reasoning: 'Testable and clear',
      })
    ).status,
    'approved_for_code',
  );
  assert.match(
    (await coder.call('evaluate_strategy', { theory_id: 'T-1', params })).error,
    /approved_for_code; it is evaluated once per coding round/,
  );

  const broken = await coder.call('submit_code', {
    theory_id: 'T-1',
    code: GOOD.replace('g.tr_1d', 'g["tr_1dd"]'),
  });
  assert.equal(broken.status, 'code_error');
  assert.equal(broken.passed, false);
  assert.equal(broken.attempts_left, 5);
  const fixed = await coder.call('submit_code', { theory_id: 'T-1', code: GOOD, note: 'Fixed the column' });
  assert.equal(fixed.passed, true, JSON.stringify(fixed));
  assert.equal(fixed.status, 'coding');
  assert.deepEqual(fixed.plugin, { name: 't1_forty_day_trend_followers', versions: [1, 2] });
  const ev = await coder.call('evaluate_strategy', { theory_id: 'T-1', params });
  assert.equal(ev.status, 'succeeded', JSON.stringify(ev));
  assert.equal(ev.theory.status, 'post_review');
  assert.match(
    (await coder.call('evaluate_strategy', { theory_id: 'T-1', params })).error,
    /post_review/,
    'once per round',
  );

  assert.equal(
    (
      await judge.call('set_verdict', {
        theory_id: 'T-1',
        verdict: 'revise',
        reasoning: 'Try top 4 to cut concentration.',
      })
    ).status,
    'revise_code',
  );
  const v3 = await coder.call('submit_code', {
    theory_id: 'T-1',
    code: GOOD.replace('"top_n": 3', '"top_n": 4'),
  });
  assert.equal(v3.passed, true);
  assert.equal(
    (await coder.call('evaluate_strategy', { theory_id: 'T-1', params })).theory.status,
    'post_review',
  );
  const verdict = await judge.call('set_verdict', {
    theory_id: 'T-1',
    verdict: 'successful',
    reasoning: 'Sharpe and excess hold on both runs.',
  });
  assert.equal(verdict.status, 'successful');

  const view = await coder.call('get_theory', { theory_id: 'T-1' });
  assert.equal(view.revisions, 2);
  assert.equal(view.trials, 2);
  assert.equal(view.evaluations.length, 2);
  const path = view.debate.filter((d: any) => d.type === 'transition').map((d: any) => `${d.to}:${d.by}`);
  assert.deepEqual(
    path.slice(-4),
    ['coding:coder', 'evaluated:evaluator', 'post_review:evaluator', 'successful:judge'],
    'debate recorded',
  );
  assert.ok(
    path.includes('revise:judge') && path.includes('revise_code:judge') && path.includes('code_error:coder'),
  );
  const full = await ok('/theories/T-1');
  const judgeMove = full.history.find((h: any) => h.to === 'successful');
  assert.deepEqual(judgeMove.actor, { role: 'judge', agentId: 'judge-agent', model: 'fixture:judge' });
});

test('the revision cap closes the way back; the Judge must decide', async () => {
  const { theorist, judge } = clients;
  const t = await theorist.call('submit_theory', {
    title: 'Monday reversal in small caps',
    hypothesis: 'Small caps that fell most on Friday rebound on Monday as weekend selling pressure fades.',
    signal_logic: 'Every Friday close rank by the day return; long the 3 worst for one day.',
    falsification: 'No positive mean Monday return.',
    reasoning: 'Weekend effect',
  });
  for (let i = 0; i < 3; i++) {
    assert.equal(
      (
        await judge.call('review_theory', {
          theory_id: t.theory_id,
          decision: 'revise',
          reasoning: `Round ${i + 1}`,
        })
      ).status,
      'revise',
    );
    await theorist.call('submit_theory', {
      theory_id: t.theory_id,
      rationale: `Clarified ${i + 1}`,
      reasoning: 'Revised',
    });
  }
  assert.match(
    (await judge.call('review_theory', { theory_id: t.theory_id, decision: 'revise', reasoning: 'Again' }))
      .error,
    /used all 3 revisions/,
  );
  assert.equal(
    (
      await judge.call('review_theory', {
        theory_id: t.theory_id,
        decision: 'reject',
        reasoning: 'Still untestable',
      })
    ).status,
    'rejected_untestable',
  );
});
