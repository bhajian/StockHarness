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
  // #280: the brief tells the Coder the next step for each theory.
  const coderBrief = async () => (await coder.call('get_research_brief', {})).queue;
  const afterError = (await coderBrief()).find((q: any) => q.theory_id === 'T-1');
  assert.equal(afterError.next_step, 'fix');
  assert.match(afterError.last_error, /tr_1dd/);
  const fixed = await coder.call('submit_code', { theory_id: 'T-1', code: GOOD, note: 'Fixed the column' });
  assert.equal(fixed.passed, true, JSON.stringify(fixed));
  assert.equal(fixed.status, 'coding');
  assert.deepEqual(fixed.plugin, { name: 't1_forty_day_trend_followers', versions: [1, 2] });
  // Left in coding with passing code (a cycle that ran out of turns): the next cycle evaluates, not rewrites.
  const ready = (await coderBrief()).find((q: any) => q.theory_id === 'T-1');
  assert.deepEqual([ready.status, ready.next_step, ready.plugin_version], ['coding', 'evaluate', 2]);
  assert.match(ready.instruction, /do not rewrite the code or re-read the data/);
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
  // The synthetic market is too small for the default gates; a lenient version makes the verdict mechanical-pass.
  const lenient = await ok('/research/gates', {
    minSharpe: -10,
    minDeflatedSharpe: 0,
    minPositiveExcessYears: 0,
    minTrades: 1,
    minHoldings: 1,
    minAlphaT: -100,
    minHoldoutExcess: -10,
    minHoldoutSharpe: -100,
    note: 'test: lenient',
  });
  assert.equal(lenient.version, 2);
  const verdict = await judge.call('set_verdict', {
    theory_id: 'T-1',
    verdict: 'successful',
    reasoning: 'Sharpe and excess hold on both runs.',
  });
  assert.equal(verdict.status, 'successful', JSON.stringify(verdict));
  assert.equal(verdict.mechanical, 'successful');
  assert.equal(verdict.gates_version, 2);
  assert.ok(
    verdict.gates.some((g: any) => g.gate === 'holdout_sharpe'),
    'the one-shot holdout ran',
  );
  const gatesNow = await ok('/research/gates');
  assert.ok(
    gatesNow.versions.find((v: any) => v.version === 2).lockedAt,
    'a verdict locks its gates version',
  );

  const view = await coder.call('get_theory', { theory_id: 'T-1' });
  assert.equal(view.revisions, 2);
  assert.equal(view.trials, 3, 'two explorations and the holdout');
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

test('strict gates: the Judge cannot upgrade a failing theory; forward_only theories are not backtested', async () => {
  const { theorist, judge, coder } = clients;
  const strict = await ok('/research/gates', { minSharpe: 50, note: 'test: unreachable Sharpe' });
  assert.equal(strict.version, 3);
  const t = await theorist.call('submit_theory', {
    title: 'Twenty-day losers bounce back',
    hypothesis: 'The worst 20-day performers mean-revert over the following two weeks in liquid names.',
    signal_logic: 'Rank by 20-day compounded tr_1d ascending; long the bottom 3, rebalanced weekly.',
    falsification: 'No excess over the S&P 500.',
    reasoning: 'Short-term reversal',
  });
  await judge.call('review_theory', { theory_id: t.theory_id, decision: 'approve', reasoning: 'Testable' });
  const reversal = GOOD.replace(
    'float(np.prod(1 + g.tr_1d) - 1)',
    '-float(np.prod(1 + g.tr_1d) - 1)',
  ).replace('lookback_days=40', 'lookback_days=20');
  assert.equal((await coder.call('submit_code', { theory_id: t.theory_id, code: reversal })).passed, true);
  assert.equal(
    (await coder.call('evaluate_strategy', { theory_id: t.theory_id, params })).theory.status,
    'post_review',
  );
  const upgrade = await judge.call('set_verdict', {
    theory_id: t.theory_id,
    verdict: 'successful',
    reasoning: 'I like it',
  });
  assert.match(upgrade.error, /never upgrade a failing one\. Gates v3: sharpe .* \(needs 50\)/);
  const failed = await judge.call('set_verdict', {
    theory_id: t.theory_id,
    verdict: 'failed',
    reasoning: 'Below the Sharpe gate',
  });
  assert.deepEqual([failed.status, failed.mechanical], ['failed', 'failed']);

  // #354: an idea that beat the S&P 500 and failed only the proof gates is promising, whatever the Judge asks.
  const proofOnly = await ok('/research/gates', {
    minSharpe: -100,
    minDeflatedSharpe: 1,
    minPositiveExcessYears: 0,
    minTrades: 1,
    minHoldings: 1,
    minAlphaT: 100,
    note: 'test: only the proof gates can fail',
  });
  const p = await theorist.call('submit_theory', {
    title: 'Forty-day leaders keep leading',
    hypothesis: 'The best 40-day performers keep outperforming over the next month in liquid names.',
    signal_logic: 'Rank by 40-day compounded tr_1d; long the top 3, rebalanced weekly.',
    falsification: 'No excess over the S&P 500.',
    reasoning: 'Momentum, for the promising label',
  });
  await judge.call('review_theory', { theory_id: p.theory_id, decision: 'approve', reasoning: 'Testable' });
  assert.equal((await coder.call('submit_code', { theory_id: p.theory_id, code: GOOD })).passed, true);
  const pe = await coder.call('evaluate_strategy', { theory_id: p.theory_id, params });
  assert.ok(
    pe.excess_vs_spx.excess_cagr > 0,
    `the synthetic momentum beats the index: ${JSON.stringify(pe.excess_vs_spx)}`,
  );
  const promising = await judge.call('set_verdict', {
    theory_id: p.theory_id,
    verdict: 'failed',
    reasoning: 'Not proven over the trials run.',
  });
  assert.deepEqual(
    [promising.status, promising.mechanical, promising.gates_version],
    ['promising', 'promising', proofOnly.version],
  );
  const pIdea = await ok(`/ideas?status=promising&limit=1000`);
  assert.ok(pIdea.items.some((i: any) => i.ref === p.theory_id));
  assert.ok(pIdea.kpis.promising >= 1);

  const fwd = await theorist.call('submit_theory', {
    title: 'Estimate revisions lead returns',
    hypothesis:
      'Names whose consensus EPS estimate rose most over four weeks outperform over the next quarter.',
    signal_logic: 'Rank by the 4-week change in analyst_estimates.epsAvg; long the top 10 monthly.',
    data_needed: ['analyst_estimates.epsAvg'],
    falsification: 'No excess over the sector benchmark.',
    reasoning: 'Classic revisions signal',
  });
  assert.equal((await ok(`/theories/${fwd.theory_id}`)).forwardOnly, true);
  await judge.call('review_theory', {
    theory_id: fwd.theory_id,
    decision: 'approve',
    reasoning: 'For paper tracking',
  });
  await coder.call('submit_code', { theory_id: fwd.theory_id, code: GOOD });
  assert.match(
    (await coder.call('evaluate_strategy', { theory_id: fwd.theory_id, params })).error,
    /forward_only/,
  );
  // #280: with passing code a forward-only theory leaves the Coder's queue (it is never backtested).
  const fwdQueue = (await coder.call('get_research_brief', {})).queue;
  assert.ok(!fwdQueue.some((q: any) => q.theory_id === fwd.theory_id), JSON.stringify(fwdQueue));
});

test('the Coder works ready-to-evaluate theories first (#280)', async () => {
  const { theorist, judge, coder } = clients;
  const submit = async (title: string, hypothesis: string, signal_logic: string) => {
    const t = await theorist.call('submit_theory', {
      title,
      hypothesis,
      signal_logic,
      falsification: 'No excess over the S&P 500.',
      data_needed: ['prices_daily.tr_1d'],
      reasoning: 'Queue order test',
    });
    await judge.call('review_theory', { theory_id: t.theory_id, decision: 'approve', reasoning: 'Testable' });
    return t.theory_id as string;
  };
  const older = await submit(
    'Quiet names drift upward',
    'Securities with the smallest absolute daily moves over sixty sessions earn more than the index afterwards.',
    'Rank by the mean of |tr_1d| over 60 days ascending; hold the five calmest, rebalanced every 21 days.',
  );
  const newer = await submit(
    'Ten-day breakout continuation',
    'A security closing a ten-session run with the largest cumulative gain continues to outperform next fortnight.',
    'Rank by compounded tr_1d over 10 days; long the top 2, rebalanced on Fridays.',
  );
  assert.equal(
    (
      await coder.call('submit_code', {
        theory_id: newer,
        code: GOOD.replace('lookback_days=40', 'lookback_days=10'),
      })
    ).passed,
    true,
  );
  const queue = (await coder.call('get_research_brief', {})).queue;
  const order = queue.map((q: any) => `${q.theory_id}:${q.next_step}`);
  assert.equal(order[0], `${newer}:evaluate`, order.join(' '));
  assert.ok(order.includes(`${older}:write`), order.join(' '));
  assert.ok(order.indexOf(`${older}:write`) > 0);
});

test('a full Coder backlog stops new theories, not revisions (#336)', async () => {
  const { theorist } = clients;
  const waiting = (await theorist.call('get_research_brief', {})).coder_queue as number;
  assert.ok(waiting >= 1, 'the earlier tests left ideas waiting for code');
  await ok('/research/settings', { maxCoderBacklog: waiting }, 'PUT');
  const brief = await theorist.call('get_research_brief', {});
  assert.equal(brief.backlog_full, true);
  assert.equal(brief.coder_backlog_limit, waiting);
  assert.match(brief.instruction, /do not propose a new theory/);
  const refused = await theorist.call('submit_theory', {
    title: 'One more idea while the Coder is busy',
    hypothesis: 'Securities with the longest losing streak bounce back over the following week.',
    signal_logic: 'Rank by the count of consecutive negative tr_1d days; long the top 3, weekly.',
    falsification: 'No excess over the S&P 500.',
    data_needed: ['prices_daily.tr_1d'],
    reasoning: 'Backlog test',
  });
  assert.match(refused.error, /waiting for code \(the limit is \d+/);
  await ok('/research/settings', { maxCoderBacklog: waiting + 1 }, 'PUT');
  assert.equal((await theorist.call('get_research_brief', {})).backlog_full, undefined);
  await ok('/research/settings', { maxCoderBacklog: 8 }, 'PUT');
});

test('idea profiles: equity long / short / long-short now, options once they can be tested (#323)', async () => {
  const { theorist } = clients;
  await ok('/research/settings', { maxCoderBacklog: 200 }, 'PUT');
  const brief = await theorist.call('get_research_brief', {});
  assert.deepEqual(
    brief.profiles.map((p: any) => p.id),
    ['equity_long', 'equity_short', 'equity_long_short'],
  );
  await ok('/research/settings', { profiles: ['equity_short', 'options_covered_call'] }, 'PUT');
  const chosen = (await theorist.call('get_research_brief', {})).profiles;
  assert.deepEqual(
    chosen.map((p: any) => [p.id, p.available ?? true]),
    [
      ['equity_short', true],
      ['options_covered_call', false],
    ],
  );
  const idea = {
    hypothesis: 'Names with the weakest twenty-day returns keep falling over the next month.',
    signal_logic: 'Rank by compounded tr_1d over 20 days; short the bottom 3, weekly.',
    falsification: 'The short book earns more than the S&P 500.',
    data_needed: ['prices_daily.tr_1d'],
    reasoning: 'Profile test',
  };
  const short = await theorist.call('submit_theory', {
    ...idea,
    title: 'Twenty-day losers keep losing',
    direction: 'short',
    instrument: 'equity',
  });
  assert.ok(short.theory_id, JSON.stringify(short));
  const covered = await theorist.call('submit_theory', {
    ...idea,
    title: 'Covered calls on calm names',
    instrument: 'options',
    structure: 'covered_call',
  });
  assert.match(covered.error, /options evaluator is coming \(#329\)/);
  const neutral = await theorist.call('submit_theory', {
    ...idea,
    title: 'A neutral stock idea',
    direction: 'neutral',
  });
  assert.match(neutral.error, /neutral is for options ideas/);
  const listed = await ok('/ideas?profile=equity_short&limit=1000');
  const row = listed.items.find((i: any) => i.ref === short.theory_id);
  assert.equal(row?.profile, 'equity_short');
  assert.equal(row?.profileLabel, 'Equity · short');
  assert.ok(listed.items.every((i: any) => i.profile === 'equity_short'));
  const exported = await ok(`/objects/export?kinds=ResearchSettings`);
  assert.match(exported, /profiles:\n\s+- equity_short\n\s+- options_covered_call/);
  await ok('/research/settings', { profiles: [], maxCoderBacklog: 8 }, 'PUT');
});

test('a second evaluate_strategy while the first is still running returns it, not a new trial (#373)', async () => {
  const { theorist, judge, coder } = clients;
  await ok('/research/settings', { maxCoderBacklog: 200 }, 'PUT');
  const t = await theorist.call('submit_theory', {
    title: 'Thirty-day leaders, evaluated once',
    hypothesis: 'The best 30-day performers keep outperforming over the next month in liquid names.',
    signal_logic: 'Rank by 30-day compounded tr_1d; long the top 3, rebalanced weekly.',
    falsification: 'No excess over the S&P 500.',
    data_needed: ['prices_daily.tr_1d'],
    reasoning: 'Duplicate evaluation test',
  });
  await judge.call('review_theory', { theory_id: t.theory_id, decision: 'approve', reasoning: 'Testable' });
  const code = GOOD.replace('lookback_days=40', 'lookback_days=30');
  assert.equal((await coder.call('submit_code', { theory_id: t.theory_id, code })).passed, true);
  const before = (await ok('/evaluations')).trials;
  const first = coder.call('evaluate_strategy', { theory_id: t.theory_id, params });
  let again: any;
  for (let i = 0; i < 40 && !again?.next; i++) {
    await new Promise((r) => setTimeout(r, 250));
    again = await coder.call('evaluate_strategy', { theory_id: t.theory_id, params });
    if (again?.theory?.status && again.theory.status !== 'coding') break;
  }
  assert.match(again.next ?? '', /already being evaluated/, JSON.stringify(again).slice(0, 300));
  const done = await first;
  assert.equal(done.status, 'succeeded', JSON.stringify(done).slice(0, 300));
  assert.equal(again.evaluation_id, done.evaluation_id, 'the same evaluation');
  assert.equal((await ok('/evaluations')).trials, before + 1, 'one trial, not two');
  await ok('/research/settings', { maxCoderBacklog: 8 }, 'PUT');
});

test('a person parks an idea in progress and resumes it (#379)', async () => {
  const { theorist, judge } = clients;
  await ok('/research/settings', { maxCoderBacklog: 200 }, 'PUT');
  const t = await theorist.call('submit_theory', {
    title: 'Fifteen-day leaders, set aside',
    hypothesis: 'The best 15-day performers keep outperforming over the next two weeks in liquid names.',
    signal_logic: 'Rank by 15-day compounded tr_1d; long the top 3, rebalanced weekly.',
    falsification: 'No excess over the S&P 500.',
    data_needed: ['prices_daily.tr_1d'],
    reasoning: 'Park test',
  });
  await judge.call('review_theory', { theory_id: t.theory_id, decision: 'approve', reasoning: 'Testable' });
  const parked = await ok(`/ideas/${t.theory_id}/actions`, {
    action: 'park',
    comment: 'Set aside for a model comparison',
  });
  assert.equal(parked.status, 'parked');
  assert.equal(parked.actions.resume, true);
  const queue = (await clients.coder.call('get_research_brief', {})).queue.map((q: any) => q.theory_id);
  assert.ok(!queue.includes(t.theory_id), 'a parked idea leaves the Coder queue');
  const back = await ok(`/ideas/${t.theory_id}/actions`, { action: 'resume' });
  assert.equal(back.status, 'approved_for_code');
  await ok('/research/settings', { maxCoderBacklog: 8 }, 'PUT');
});
