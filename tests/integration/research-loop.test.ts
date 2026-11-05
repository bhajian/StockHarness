// #115 on the real stack: one full research-loop cycle (parallel Theorists, Judge, Coder, Judge) with scripted
// fixture models produces evaluated theories with verdicts and no manual steps.
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
let harnessId = '';
let theoristProvider = '';
let judgeProvider = '';

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

  theoristProvider = (
    await ok('/providers', {
      name: 'Theorist model',
      kind: 'openai-compatible',
      baseUrl: 'http://fixtures:9090/v1',
      model: 'test-research',
      contextWindow: 200000,
      maxOutputTokens: 1024,
    })
  ).id;
  judgeProvider = (
    await ok('/providers', {
      name: 'Judge model',
      kind: 'openai-compatible',
      baseUrl: 'http://fixtures:9090/v1',
      model: 'test-research-judge',
      contextWindow: 200000,
      maxOutputTokens: 1024,
    })
  ).id;
  const seedSkills = await readFile('deploy/config-io/seed/skills.yaml', 'utf8');
  assert.equal((await ok('/objects/import', { yaml: seedSkills, dryRun: false })).applied, true);
  await ok(
    '/research/settings',
    { evaluationSymbols: ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'], evaluationYears: 1 },
    'PUT',
  );
  await ok('/research/steering', { note: 'Prefer short-horizon price signals this week.' });
  const installed = await ok('/research/loop', {
    providers: { theorist: theoristProvider, judge: judgeProvider },
    theorists: 2,
  });
  assert.deepEqual(installed.missingSkills, []);
  harnessId = installed.harness.id;
});

test('one research cycle produces evaluated theories with verdicts, no manual steps', async () => {
  let run = await ok('/runs', { workflowId: harnessId, input: 'cycle 1' });
  for (let i = 0; i < 300 && ['queued', 'running'].includes(run.status); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    run = await ok(`/runs/${run.id}`);
  }
  assert.equal(run.status, 'succeeded', run.error ?? JSON.stringify(run.events?.slice(-5)));
  const list = await ok('/theories');
  assert.equal(list.items.length, 2, 'the two parallel Theorists each submitted one');
  for (const t of list.items) {
    assert.equal(t.status, 'failed', `${t.ref}: ${t.status}`);
    assert.equal(t.evaluationIds.length, 1, `${t.ref} was evaluated`);
    assert.ok(t.plugin?.versions.length >= 1);
  }
  const one = await ok(`/theories/${list.items[0].id}`);
  const models = new Set(
    one.history.filter((h: any) => h.actor.model).map((h: any) => `${h.actor.role}=${h.actor.model}`),
  );
  assert.ok(
    [...models].some((m) => m.startsWith('theorist=Theorist model')),
    [...models].join(' '),
  );
  assert.ok(
    [...models].some((m) => m.startsWith('judge=Judge model')),
    'different models per role',
  );
  const brief = run.events.find(
    (e: any) =>
      e.type === 'tool_completed' &&
      String(e.data?.result).includes('get_research_brief') === false &&
      String(e.data?.result).includes('Prefer short-horizon price signals'),
  );
  assert.ok(brief, 'the steering note reached the Theorists');
});

test('the research loop is a Harness object with its connections and skills by name', async () => {
  const yaml = await ok('/objects/export?kinds=Harness&names=Research%20loop');
  assert.match(yaml, /kind: Harness\nmetadata:\n  name: Research loop/);
  for (const n of ['Research — Theorist', 'Research — Judge', 'Research — Coder'])
    assert.ok(yaml.includes(`name: ${n}`), n);
  for (const n of ['strategy-library', 'write-a-strategy-plugin', 'judge-checklist'])
    assert.ok(yaml.includes(`name: ${n}`), n);
  assert.match(yaml, /type: parallel/);
});
