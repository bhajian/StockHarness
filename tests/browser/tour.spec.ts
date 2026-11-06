// A screenshot tour of the studio (#283): seed one workspace (data, a research cycle, a simulation), then save a
// screenshot of every page and tab at two widths into test-results/tour/. Off by default: TOUR=1 runs it.
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const password = 'Integration-test-password-42';
function setupToken() {
  if (process.env.SETUP_TOKEN) return process.env.SETUP_TOKEN;
  const line = readFileSync('.env', 'utf8')
    .split('\n')
    .find((l) => l.startsWith('SETUP_TOKEN='));
  return line?.slice('SETUP_TOKEN='.length).trim() ?? '';
}
async function workspace(page: Page) {
  const api = async (path: string, data?: unknown, method = data === undefined ? 'GET' : 'POST') => {
    const r = await page.request.fetch('/api' + path, { method, headers: { Origin: base }, data });
    expect(r.ok(), `${path}: ${await r.text()}`).toBeTruthy();
    const text = await r.text();
    try {
      return text ? JSON.parse(text) : undefined;
    } catch {
      return text;
    }
  };
  const admin = { email: 'admin@openharness.test', password };
  if ((await api('/auth/status')).needsSetup)
    await api('/auth/setup', { ...admin, name: 'Test administrator', setupToken: setupToken() });
  else await api('/auth/login', admin);
  const credentials = { email: `tour-browser-${Date.now()}@openharness.test`, password };
  await api('/users', { ...credentials, name: 'Tour', workspace: 'new' });
  await api('/auth/login', credentials);
  return api;
}
const weekdays = (from: string, n: number) => {
  const out: string[] = [];
  for (let t = Date.parse(from); out.length < n; t += 86400000)
    if (![0, 6].includes(new Date(t).getUTCDay())) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

test('screenshot tour', async ({ page }) => {
  test.skip(!process.env.TOUR, 'set TOUR=1 to take the screenshot tour');
  test.setTimeout(900000);
  const api = await workspace(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const mongo = await api('/connections', { name: 'MongoDB', kind: 'mongodb', builtIn: true, url: '' });
  const days = weekdays('2024-01-01', 160);
  const ids = Array.from({ length: 8 }, (_, k) => `SEC_${String(k).padStart(6, '0')}`);
  let x = 5;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647 - 0.5) * 0.03;
  const prices: object[] = [];
  const uni: object[] = [];
  const macro: object[] = [];
  for (const d of days) {
    let sum = 0;
    ids.forEach((s, k) => {
      const r = Math.round((rnd() + (k - 4) * 0.0004) * 1e8) / 1e8;
      sum += r;
      prices.push({ security_id: s, date: d, as_of_date: d, tr_1d: r });
      uni.push({ security_id: s, date: d, as_of_date: d, in_universe: true });
    });
    macro.push({ date: d, as_of_date: d, spx_ret_1d: sum / ids.length });
  }
  const insert = async (c: string, docs: object[]) => {
    await api(`/mongodb/${mongo.id}/collections`, { name: c });
    for (let i = 0; i < docs.length; i += 1000)
      await api(`/mongodb/${mongo.id}/collections/${c}/documents`, { documents: docs.slice(i, i + 1000) });
  };
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
    days.map((d) => ({ date: d, is_trading_day: true })),
  );
  await api('/catalog/refresh', {});
  await api('/evaluator/settings', { holdoutMonths: 1 }, 'PUT');
  const provider = await api('/providers', {
    name: 'Research model',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-research',
    contextWindow: 200000,
    maxOutputTokens: 1024,
  });
  await api('/objects/import', {
    yaml: readFileSync('deploy/config-io/seed/skills.yaml', 'utf8'),
    dryRun: false,
  });
  await api(
    '/research/settings',
    { evaluationSymbols: ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'], evaluationYears: 1 },
    'PUT',
  );
  const installed = await api('/research/loop', { providers: { theorist: provider.id, judge: provider.id } });
  let run = await api('/runs', { workflowId: installed.harness.id, input: 'browser cycle' });
  for (let i = 0; i < 150 && ['queued', 'running'].includes(run.status); i++) {
    await page.waitForTimeout(2000);
    run = await api(`/runs/${run.id}`);
  }
  expect(run.status).toBe('succeeded');

  // A simulation of the first idea, through the API.
  const ideas = await api('/ideas?limit=10&sort=recent');
  const ref = ideas.items.find((i: any) => i.sharpe !== null)?.ref ?? ideas.items[0].ref;
  const started = await api('/simulations', {
    config: { name: `${ref} tour`, ideas: [{ idea: ref }], period: { start: days[40], end: days[120] } },
  });
  for (let i = 0; i < 60; i++) {
    if ((await api(`/simulations/${started.id}`)).status !== 'running') break;
    await page.waitForTimeout(1500);
  }
  const cycles = await api('/research/cycles');
  const pages: [string, string][] = [
    ['map', '/map'],
    ['harnesses', '/harnesses'],
    ['playground', '/playground'],
    ['skills', '/skills'],
    ['connections', '/connections'],
    ['knowledge', '/knowledge'],
    ['datasets-syncs', '/datasets/syncs'],
    ['datasets-transforms', '/datasets/transforms'],
    ['datasets-pipelines', '/datasets/pipelines'],
    ['datasets-catalog', '/datasets/catalog'],
    ['datasets-health', '/datasets/health'],
    ['research-lab', '/research'],
    ['research-setup', '/research/setup'],
    ['research-how', '/research/how'],
    ['research-cycles', '/research/cycles'],
    ['research-cycle', `/research/cycles/${cycles[0]?.id}`],
    ['ideas', '/ideas?show=all'],
    ['idea-overview', `/ideas/${ref}`],
    ['idea-results', `/ideas/${ref}/results`],
    ['idea-review', `/ideas/${ref}/review`],
    ['idea-code', `/ideas/${ref}/code`],
    ['idea-runs', `/ideas/${ref}/runs`],
    ['simulations', '/simulations'],
    ['sim-performance', `/simulations/${started.id}`],
    ['sim-trades', `/simulations/${started.id}/trades`],
    ['sim-positions', `/simulations/${started.id}/positions`],
    ['sim-attribution', `/simulations/${started.id}/attribution`],
    ['sim-config', `/simulations/${started.id}/config`],
    ['evaluations', '/evaluations'],
    ['inbox', '/inbox'],
    ['executions', '/executions'],
    ['integrations', '/integrations'],
    ['settings', '/settings'],
  ];
  const widths = (process.env.TOUR_WIDTHS ?? '1440,1100').split(',').map(Number);
  const only = process.env.TOUR_ONLY?.split(',');
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [name, path] of pages) {
      if (only && !only.includes(name)) continue;
      await page.goto(path);
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `test-results/tour/${name}-${width}.png`, fullPage: true });
    }
  }
  expect(errors).toEqual([]);
});
