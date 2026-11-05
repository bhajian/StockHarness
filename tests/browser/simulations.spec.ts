// #126 (the M6 exit check): after a research cycle, a person opens an idea, launches a simulation from it, waits for
// it, and reviews it: performance, the trade blotter and a trade's drawer, positions as of a date, attribution, the
// frozen config, the list, and clone-and-edit.
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
  const credentials = { email: `sims-browser-${Date.now()}@openharness.test`, password };
  await api('/users', { ...credentials, name: 'Browser Simulations', workspace: 'new' });
  await api('/auth/login', credentials);
  return api;
}
const weekdays = (from: string, n: number) => {
  const out: string[] = [];
  for (let t = Date.parse(from); out.length < n; t += 86400000)
    if (![0, 6].includes(new Date(t).getUTCDay())) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

test('an idea is simulated from the UI and the run is reviewed tab by tab', async ({ page }) => {
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

  await page.goto('/ideas?show=all');
  const row = page.getByRole('table', { name: 'Ideas' }).locator('tbody tr').first();
  await row.click();
  await expect(page).toHaveURL(/\/ideas\/T-\d+$/);
  const ref = new URL(page.url()).pathname.split('/')[2]!;
  await page.getByRole('button', { name: 'Simulate' }).click();
  await expect(page).toHaveURL(new RegExp(`/simulations\\?new=${ref}`));
  const modal = page.getByRole('dialog', { name: 'New simulation' });
  await expect(modal.getByRole('checkbox', { name: new RegExp(ref) })).toBeChecked();
  await modal.getByRole('button', { name: '1y' }).click();
  await expect(modal.getByText(/About .* sessions · code T-\d+ v\d/)).toBeVisible({ timeout: 15000 });
  if (process.env.SCREENSHOT) await page.screenshot({ path: 'test-results/sim-modal.png', fullPage: true });
  await modal.getByRole('button', { name: 'Launch' }).click();
  await expect(page).toHaveURL(/\/simulations\/[0-9a-f-]{36}$/);
  const sim = page.locator('.sim-page');
  await expect(sim.locator('.idea-meta').getByText('succeeded')).toBeVisible({ timeout: 120000 });
  for (const k of ['CAGR', 'Sharpe', 'Max drawdown', 'Final NAV', 'Trades'])
    await expect(sim.locator('.kpi-row').getByText(k, { exact: true })).toBeVisible();
  await expect(sim.getByText('Equity', { exact: true })).toBeVisible();
  await expect(sim.getByText('Monthly returns')).toBeVisible();
  await expect(sim.getByText(/Ledger checks: NAV = cash \+ positions/)).toBeVisible();
  if (process.env.SCREENSHOT)
    await page.screenshot({ path: 'test-results/sim-performance.png', fullPage: true });

  await page.getByRole('tab', { name: /Trades/ }).click();
  await expect(page).toHaveURL(/\/trades$/);
  const trades = page.getByRole('table', { name: 'Trades' }).locator('tbody tr:not([aria-hidden])');
  await expect(trades.first()).toBeVisible();
  await trades.first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { name: /Trade \d+/ })).toBeVisible();
  await expect(drawer.getByText('Why it was bought')).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Fills' })).toBeVisible();
  await expect(drawer.locator('canvas, svg').first()).toBeVisible();
  if (process.env.SCREENSHOT) await page.screenshot({ path: 'test-results/sim-trade.png', fullPage: true });
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: 'Positions' }).click();
  const positions = page.getByRole('table', { name: 'Positions' });
  await expect(positions.locator('tbody tr').first()).toBeVisible();
  const scrub = page.getByRole('slider');
  await scrub.focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowLeft');
  await expect(page.getByText(/NAV \$/)).toBeVisible();

  await page.getByRole('tab', { name: 'Attribution' }).click();
  await expect(page.getByText('P&L by idea')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Calibration' })).toBeVisible();
  await page.getByRole('tab', { name: 'Config' }).click();
  await expect(page.getByText(/sha256:[0-9a-f]{64}/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Config' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Clone and edit' }).first().click();
  const clone = page.getByRole('dialog', { name: 'Clone and edit a simulation' });
  await expect(clone.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(/\(copy\)$/);
  await clone.getByRole('button', { name: 'Cancel' }).click();

  await page.getByLabel('Breadcrumbs').getByRole('button', { name: 'Simulations' }).click();
  const list = page.getByRole('table', { name: 'Simulations' });
  await expect(list.getByRole('row', { name: new RegExp(ref) })).toBeVisible();
  if (process.env.SCREENSHOT) await page.screenshot({ path: 'test-results/sim-list.png', fullPage: true });
  expect(errors).toEqual([]);
});
