// #116 Research Lab: after a real (fixture-model) research cycle, the page shows the KPIs, the board with today's
// verdicts, the live activity feed, steering, pause / resume and the settings drawer. Then (#119–#123) a board card
// opens the idea page and its tabs, the Ideas table and cards, compare, and a person's send-back.
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
  const credentials = { email: `research-browser-${Date.now()}@openharness.test`, password };
  await api('/users', { ...credentials, name: 'Browser Research', workspace: 'new' });
  await api('/auth/login', credentials);
  return api;
}
const weekdays = (from: string, n: number) => {
  const out: string[] = [];
  for (let t = Date.parse(from); out.length < n; t += 86400000)
    if (![0, 6].includes(new Date(t).getUTCDay())) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

test('the Research Lab shows a cycle: KPIs, board, activity, debate, steering, pause, settings', async ({
  page,
}) => {
  test.setTimeout(420000);
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

  await page.goto('/research');
  await expect(page.getByRole('heading', { name: 'Research', exact: true })).toBeVisible();
  const kpis = page.getByLabel('Research KPIs');
  await expect(kpis.getByText('Theories today')).toBeVisible();
  await expect(kpis.getByText('Total trials')).toBeVisible();
  const board = page.getByLabel('Pipeline board');
  for (const col of ['Draft', 'Pre-review', 'Coding', 'Evaluating', 'Post-review', "Today's verdicts"])
    await expect(board.getByRole('heading', { name: new RegExp(`^${col}`) })).toBeVisible();
  const verdicts = board.getByLabel("Today's verdicts").getByRole('button');
  await expect(verdicts).toHaveCount(2);
  await expect(
    page
      .getByLabel('Live activity')
      .getByText(/pre_review → approved_for_code/)
      .first(),
  ).toBeVisible();
  await page.getByLabel('Steering note').fill('Look at low-volatility names next.');
  await page.getByRole('button', { name: 'Send to the Theorists' }).click();
  await expect
    .poll(async () => (await api('/research/settings')).steering?.at(-1)?.note)
    .toBe('Look at low-volatility names next.');
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  if (process.env.SCREENSHOT)
    await page.screenshot({ path: 'test-results/research-page.png', fullPage: true });
  // #301: Settings opens Research → Setup: scope, agents, budget per model, schedule, gates.
  await page.locator('.research-lab').getByRole('button', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/research\/setup$/);
  await expect(page.getByRole('radio', { name: 'S&P 500 proxy (top 500)' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Spend by model' }).getByText('test-research')).toBeVisible();
  await expect(page.getByText(/changing a threshold creates gates v2/i)).toBeVisible();
  await expect(page.getByLabel('Gate minSharpe')).toHaveValue('0.5');
  await page.getByRole('radio', { name: 'S&P 500 proxy (top 500)' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText(/Saved/);
  await expect
    .poll(async () => (await api('/research/settings')).scope)
    .toEqual({ kind: 'top_market_cap', top: 500 });
  await api('/research/settings', { scope: { kind: 'symbols', top: 500 } }, 'PUT');
  if (process.env.SCREENSHOT)
    await page.screenshot({ path: 'test-results/research-setup.png', fullPage: true });
  // #302: How it works — the pipeline, and each agent's model, skills and tools.
  await page.getByRole('tab', { name: 'How it works' }).click();
  await expect(page).toHaveURL(/\/research\/how$/);
  const pipeline = page.getByLabel('The research loop');
  await expect(pipeline.getByRole('button', { name: /Theorist 1/ })).toBeVisible();
  await pipeline.getByRole('button', { name: /^Coder/ }).click();
  const coder = page.getByLabel('Coder details');
  await expect(coder.getByRole('button', { name: 'write-a-strategy-plugin' })).toBeVisible();
  await expect(coder.locator('code', { hasText: 'submit_code' })).toBeVisible();
  if (process.env.SCREENSHOT)
    await page.screenshot({ path: 'test-results/research-how.png', fullPage: true });
  // Cycles: the list, then one cycle's trace per agent.
  await page.getByRole('tab', { name: 'Cycles' }).click();
  const cycles = page.getByRole('table', { name: 'Cycles' });
  await cycles.locator('tbody tr').first().click();
  await expect(page).toHaveURL(/\/research\/cycles\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'What each agent did' })).toBeVisible();
  const agentRows = page.locator('details.cycle-agent');
  await expect(agentRows.first()).toBeVisible();
  const coderRow = agentRows.filter({ has: page.locator('summary strong', { hasText: /^Coder$/ }) });
  await coderRow.locator('summary').first().click();
  await expect(coderRow.locator('code', { hasText: 'submit_code' }).first()).toBeVisible();
  const theoristRow = agentRows.filter({ has: page.locator('summary strong', { hasText: /^Theorists/ }) });
  await expect(theoristRow.locator('summary').first()).not.toContainText('not run');
  await expect(theoristRow.locator('summary').first()).not.toContainText(' 0 tool calls');
  if (process.env.SCREENSHOT)
    await page.screenshot({ path: 'test-results/research-cycle.png', fullPage: true });
  // #312: the Map connects data, prep, research setup, ideas and simulations, with a start-here checklist.
  await page.goto('/map');
  const flow = page.getByLabel('The workspace');
  for (const col of ['Data sources', 'Data prep', 'Research setup', 'Ideas', 'Simulations'])
    await expect(flow.getByLabel(col, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Start here').getByText(/Research is set up/)).toBeVisible();
  await expect(flow.getByLabel('Research setup').getByText(/model/).first()).toBeVisible();
  if (process.env.SCREENSHOT) await page.screenshot({ path: 'test-results/map.png', fullPage: true });
  await page.goto('/research');

  // #119–#123, #269: a board card opens the idea's own page; its tabs are URLs; back to the master table.
  await verdicts.first().click();
  await expect(page).toHaveURL(/\/ideas\/T-\d+$/);
  const ref = new URL(page.url()).pathname.split('/')[2]!;
  const idea = page.locator('.idea-page');
  await expect(idea.getByRole('heading', { name: 'Gates' })).toBeVisible();
  await expect(idea.locator('.gate-checklist tbody tr').first()).toBeVisible();
  await expect(idea.getByRole('heading', { name: 'Judge' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  await expect(idea.getByText('Hypothesis', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Review' }).click();
  await expect(page).toHaveURL(new RegExp(`/ideas/${ref}/review$`));
  await expect(
    idea.locator('.debate-turn.role-judge').filter({ hasText: 'Post-review → Failed' }),
  ).toBeVisible();
  await expect(idea.locator('.debate-turn.role-theorist').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Code' }).click();
  await expect(page).toHaveURL(new RegExp(`/ideas/${ref}/code$`));
  await expect(page.getByLabel('Versions').getByRole('button', { name: /^v1/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Runs' }).click();
  const runs = page.getByRole('table', { name: 'Evaluations' }).locator('tbody tr');
  await expect(runs.first()).toBeVisible();
  await page.getByRole('tab', { name: 'Results' }).click();
  await expect(idea.locator('.evaluation-report')).toBeVisible();
  if (process.env.SCREENSHOT)
    await page.screenshot({ path: 'test-results/idea-results.png', fullPage: true });
  // A reload keeps the tab (the URL is the state).
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true');

  await page.getByLabel('Breadcrumbs').getByRole('button', { name: 'Ideas' }).click();
  await expect(page).toHaveURL(/\/ideas$/);
  // Both verdicts failed, so the default view (successful and approved) is empty and says so.
  await expect(page.getByText('No ideas match.')).toBeVisible();
  await expect(page.getByLabel('Idea KPIs').getByText('Failed')).toBeVisible();
  await page.getByRole('button', { name: 'Show every idea' }).click();
  await expect(page).toHaveURL(/show=all/);
  const table = page.getByRole('table', { name: 'Ideas' });
  await expect(table.getByRole('row', { name: new RegExp(ref) })).toBeVisible();
  const failedRows = table.locator('tbody tr').filter({ hasText: 'Failed' });
  await expect(failedRows).toHaveCount(2);
  await page.getByRole('radio', { name: 'Card view' }).click();
  await expect(page).toHaveURL(/view=cards/);
  await expect(page.locator('.idea-card').filter({ hasText: 'Failed' })).toHaveCount(2);
  for (const box of await page
    .locator('.idea-card')
    .filter({ hasText: 'Failed' })
    .getByRole('checkbox')
    .all())
    await box.check();
  await page.getByRole('button', { name: 'Compare (2)' }).click();
  await expect(page).toHaveURL(/\/ideas\/compare\?ids=T-\d+,T-\d+/);
  await expect(page.getByRole('heading', { name: 'Compare 2 ideas' })).toBeVisible();
  await expect(
    page
      .getByRole('table', { name: 'Metrics' })
      .getByRole('row', { name: /Sharpe/ })
      .first(),
  ).toBeVisible();
  await expect(page.getByRole('table', { name: 'Return correlation' })).toBeVisible();
  if (process.env.SCREENSHOT)
    await page.screenshot({ path: 'test-results/idea-compare.png', fullPage: true });

  // A person sends a failed idea back to the Theorist with a comment (#122).
  await page.goto(`/ideas/${ref}`);
  await page.getByRole('button', { name: 'Send back…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Send back' })).toBeDisabled();
  await dialog.getByRole('textbox').fill('Try a longer lookback and fewer names.');
  await dialog.getByRole('button', { name: 'Send back' }).click();
  await expect(idea.locator('.idea-meta').getByText('Revising')).toBeVisible();
  await page.getByRole('tab', { name: 'Review' }).click();
  await expect(
    idea.locator('.debate-turn.role-human').filter({ hasText: 'Try a longer lookback' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
