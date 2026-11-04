// #87 Datasets → Catalog: browse a collection, document fields inline (persists via PATCH), coverage charts
// over 10 years of daily data (#74), caveats, sample rows, agent view, export for agents.
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
  const credentials = { email: `catalog-browser-${Date.now()}@openharness.test`, password };
  await api('/users', { ...credentials, name: 'Browser Catalog', workspace: 'new' });
  await api('/auth/login', credentials);
  return api;
}

test('catalog: fields, coverage charts, caveats, sample, agent view, export', async ({ page }) => {
  test.setTimeout(180000);
  const api = await workspace(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const mongo = await api('/connections', { name: 'MongoDB', kind: 'mongodb', builtIn: true, url: '' });
  await api(`/mongodb/${mongo.id}/collections`, { name: 'cat_prices' });
  // About 10 years of weekdays for two symbols (one missing in 2019).
  const docs: Record<string, unknown>[] = [];
  for (let t = Date.UTC(2016, 0, 4); t <= Date.UTC(2026, 0, 2); t += 86400000) {
    const d = new Date(t);
    if ([0, 6].includes(d.getUTCDay())) continue;
    const date = d.toISOString().slice(0, 10);
    docs.push({ symbol: 'AAA', date, close: 100 });
    if (!date.startsWith('2019')) docs.push({ symbol: 'BBB', date, close: 50 });
  }
  for (let i = 0; i < docs.length; i += 2000)
    await api(`/mongodb/${mongo.id}/collections/cat_prices/documents`, {
      documents: docs.slice(i, i + 2000),
    });
  await api('/catalog/refresh', { collection: 'cat_prices' });

  await page.goto('/datasets/catalog/cat_prices');
  await expect(page.locator('.catalog-list li.active')).toContainText('cat_prices');
  await expect(page.locator('.collection-head')).toContainText('cat_prices');

  // Fields: document one inline; it persists.
  const close = page.getByLabel('Description of close');
  await close.fill('Closing price');
  await page.getByLabel('Unit of close').fill('USD');
  await page.getByLabel('Unit of close').blur();
  await expect
    .poll(
      async () => (await api('/catalog/cat_prices')).fields.find((f: any) => f.name === 'close').description,
    )
    .toBe('Closing price');
  await page.reload();
  await expect(page.getByLabel('Description of close')).toHaveValue('Closing price');

  // Coverage: computed in the background, then charts.
  await page.getByRole('tab', { name: 'Coverage' }).click();
  await expect(page.locator('.chart-card', { hasText: 'Rows per day' }).locator('canvas')).toBeVisible({
    timeout: 60000,
  });
  await expect(page.getByRole('figure', { name: /^Symbols per day/ })).toBeVisible();
  await expect(page.locator('.chart-card', { hasText: 'Gaps' }).locator('canvas')).toBeVisible();
  await page
    .getByRole('figure', { name: /^Symbols per day/ })
    .getByRole('button', { name: 'Table' })
    .click();
  await expect(
    page.getByRole('figure', { name: /^Symbols per day/ }).locator('.chart-table tr').nth(1),
  ).toContainText('2016-01-04');

  // Caveats: add one.
  await page.getByRole('tab', { name: /Caveats/ }).click();
  await page.getByLabel('New caveat').fill('BBB has no 2019 data');
  await page.getByRole('button', { name: 'Add caveat' }).click();
  await expect(page.locator('.caveat-list')).toContainText('BBB has no 2019 data');

  // Sample rows, agent view, export.
  await page.getByRole('tab', { name: 'Sample' }).click();
  await expect(page.locator('.data-grid-table tbody tr').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Agent view' }).click();
  await expect(page.locator('.agent-view pre')).toContainText('- close (integer, USD): Closing price');
  await expect(page.locator('.agent-view pre')).toContainText('BBB has no 2019 data');
  await page.getByLabel('Select cat_prices for export').check();
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export for agents/ }).click();
  expect((await dl).suggestedFilename()).toBe('catalog-for-agents.md');
  expect(errors).toEqual([]);
});
