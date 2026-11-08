// #109 dev evaluation page: a real evaluation (run in the Python executor) renders its KPIs, charts, folds,
// factor exposures and provenance; the list links to it.
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
  const credentials = { email: `eval-browser-${Date.now()}@openharness.test`, password };
  await api('/users', { ...credentials, name: 'Browser Evaluations', workspace: 'new' });
  await api('/auth/login', credentials);
  return api;
}
const weekdays = (from: string, n: number) => {
  const out: string[] = [];
  for (let t = Date.parse(from); out.length < n; t += 86400000)
    if (![0, 6].includes(new Date(t).getUTCDay())) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

test('an evaluation record renders on the dev evaluation page', async ({ page }) => {
  test.setTimeout(240000);
  const api = await workspace(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const mongo = await api('/connections', { name: 'MongoDB', kind: 'mongodb', builtIn: true, url: '' });
  const days = weekdays('2023-01-02', 340);
  const ids = Array.from({ length: 8 }, (_, k) => `SEC_${String(k).padStart(6, '0')}`);
  let x = 11;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647 - 0.5) * 0.03;
  const prices: object[] = [];
  const uni: object[] = [];
  const macro: object[] = [];
  let spx = 4000;
  for (const d of days) {
    let sum = 0;
    ids.forEach((s, k) => {
      const r = Math.round((rnd() + (k - 4) * 0.0003) * 1e8) / 1e8;
      sum += r;
      prices.push({ security_id: s, date: d, as_of_date: d, tr_1d: r });
      uni.push({ security_id: s, date: d, as_of_date: d, in_universe: true });
    });
    spx *= 1 + sum / ids.length;
    macro.push({
      date: d,
      as_of_date: d,
      spx_ret_1d: sum / ids.length,
      spx_close: spx,
      vix: d < '2023-07-01' ? 28 : 16,
    });
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
      sector_history: [{ value: k % 2 ? 'Technology' : 'Energy', valid_from: '2016-01-04', valid_to: null }],
    })),
  );
  await api('/catalog/refresh', {});
  await api('/evaluator/settings', { holdoutMonths: 2 }, 'PUT');
  await api('/strategy-plugins', {
    name: 'trend_60d',
    code:
      'import numpy as np\nMETA = {"side": "long", "horizon_days": 20, "rebalance": "weekly", "top_n": 3}\n\n' +
      'def signal(ctx):\n    f = ctx.read_df("prices_daily", columns=["security_id", "tr_1d"], lookback_days=60)\n' +
      '    return {s: float(np.prod(1 + g.tr_1d) - 1) for s, g in f.groupby("security_id")}\n',
  });
  const started = await api('/evaluations', {
    plugin: 'trend_60d',
    params: { start: days[70], end: days[260] },
  });
  let e = started;
  for (let i = 0; i < 120 && e.status === 'running'; i++) {
    await page.waitForTimeout(1000);
    e = await api(`/evaluations/${started.id}`);
  }
  expect(e.status, JSON.stringify(e.error)).toBe('succeeded');

  await page.goto('/evaluations');
  await expect(page.getByRole('heading', { name: 'Evaluations' })).toBeVisible();
  await page.getByRole('table', { name: 'Evaluations' }).getByText('trend_60d v1').click();
  await expect(page).toHaveURL(new RegExp(`/evaluations/${started.id}$`));
  const kpis = page.getByLabel('Key metrics');
  for (const label of ['CAGR', 'Sharpe', 'Max drawdown', 'Hit rate', 'Excess vs S&P 500', 'Deflated Sharpe'])
    await expect(kpis.getByText(label, { exact: true })).toBeVisible();
  await expect(
    kpis.getByText(`${(e.record.summary.sharpe as number).toFixed(2)}`, { exact: true }),
  ).toBeVisible();
  const folds = page.getByRole('table', { name: 'Walk-forward folds' });
  await expect(folds.getByRole('row')).toHaveCount(1 + e.record.folds.length);
  await expect(folds.getByText('2023', { exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Factor exposures' }).getByText('market')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Regimes' }).getByText('VIX high')).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
  // #324: results by name, best first; sortable; searchable.
  const byName = page.getByRole('table', { name: 'Results by name' });
  const best = e.record.by_name.rows[0];
  await expect(byName.getByRole('row')).toHaveCount(1 + e.record.by_name.rows.length);
  await expect(byName.getByRole('row').nth(1).getByText(best.ticker, { exact: true })).toBeVisible();
  await byName.getByRole('button', { name: 'Trades' }).click();
  await expect(byName.getByRole('columnheader', { name: /Trades/ })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
  await page.getByLabel('Find a ticker or sector').fill(best.ticker);
  await expect(byName.getByRole('row')).toHaveCount(2);
  await page.getByLabel('Find a ticker or sector').fill('');
  // #325: find the names it works for. This strategy loses on every name, so the search says why it cannot.
  const subset = page.getByRole('region', { name: 'Names it works for' });
  await subset.getByLabel('Names').fill('3');
  await subset.getByRole('button', { name: 'Find the names' }).click();
  await expect(subset.getByText(/a subset needs at least 3/)).toBeVisible({ timeout: 180000 });
  await page.getByText('Provenance').click();
  await expect(page.getByText(e.record.record_hash)).toBeVisible();
  if (process.env.SCREENSHOT)
    await page.screenshot({ path: 'test-results/evaluation-page.png', fullPage: true });

  // A book of the six highest-numbered names: two of them add to the return, so a subset of 2 is picked.
  await api('/strategy-plugins', {
    name: 'by_number',
    code:
      'META = {"side": "long", "horizon_days": 5, "rebalance": "weekly", "top_n": 6}\n\n' +
      'def signal(ctx):\n    f = ctx.read_df("prices_daily", columns=["security_id"], lookback_days=5)\n' +
      '    return {s: float(s[-1]) for s in set(f.security_id)}\n',
  });
  const second = await api('/evaluations', {
    plugin: 'by_number',
    params: { start: days[70], end: days[260] },
  });
  for (let i = 0; i < 120 && (await api(`/evaluations/${second.id}`)).status === 'running'; i++)
    await page.waitForTimeout(1000);
  await page.goto(`/evaluations/${second.id}`);
  const found = page.getByRole('region', { name: 'Names it works for' });
  await found.getByLabel('Names').fill('2');
  await found.getByRole('button', { name: 'Find the names' }).click();
  await expect(found.getByRole('table', { name: 'Subset comparison' })).toBeVisible({ timeout: 180000 });
  await expect(found.getByText(/shown out of sample|not shown/).first()).toBeVisible();
  await expect(found.getByRole('img', { name: /chosen names against random sets/ })).toBeVisible();
  await expect(found.getByLabel('Chosen names').locator('.chip')).toHaveCount(2);
  if (process.env.SCREENSHOT) await found.screenshot({ path: 'test-results/subset-panel.png' });
  expect(errors).toEqual([]);
});
