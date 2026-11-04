// #76 Syncs list KPIs/filters/columns and the sync detail page (Source, Symbols, Runs with FMP calls and
// per-symbol errors, Schedule, Data); editing still works. Syncs pull from the fixture FMP (test stack).
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
  const credentials = { email: `syncs-browser-${Date.now()}@openharness.test`, password };
  await api('/users', { ...credentials, name: 'Browser Syncs', workspace: 'new' });
  await api('/auth/login', credentials);
  return api;
}

test('syncs list and the sync detail page', async ({ page }) => {
  test.setTimeout(120000);
  const api = await workspace(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await api('/connections', { name: 'MongoDB', kind: 'mongodb', builtIn: true, url: '' });
  const fmp = await api('/connections', { name: 'FMP', url: 'http://fixtures:9090/mcp?apikey=test-key' });
  const sync = await api('/dataset-syncs', {
    name: 'EOD fixture',
    connectionId: fmp.id,
    dataset: 'eod_prices',
    symbolsMode: 'list',
    symbols: ['GOOD', 'ERR'],
    from: '2026-10-26',
    enabled: true,
    schedule: { enabled: true, everyMinutes: 1440, at: '18:30', timezone: 'America/New_York', input: 'x' },
  });
  await api(`/dataset-syncs/${sync.id}/run`, {});
  await expect
    .poll(async () => (await api(`/dataset-syncs/${sync.id}/runs`))[0]?.status, { timeout: 60000 })
    .toBe('succeeded');

  await page.goto('/datasets/syncs');
  await expect(page.locator('.kpi-card', { hasText: 'FMP calls today' })).toContainText('2');
  await page.getByLabel('Cadence').selectOption('weekly');
  await expect(page.locator('.dataset-table tbody tr')).toHaveCount(0);
  await page.getByLabel('Cadence').selectOption('daily');
  const row = page.locator('.dataset-table tbody tr', { hasText: 'EOD fixture' });
  await expect(row).toContainText('from 2026-10-26');
  await row.locator('td', { hasText: 'EOD fixture' }).click();
  await expect(page).toHaveURL(new RegExp(`/datasets/syncs/${sync.id}$`));

  await expect(page.locator('.sync-facts')).toContainText('historical-price-eod/full');
  await expect(page.locator('.sync-facts')).toContainText('symbol');
  await page.getByRole('tab', { name: 'Symbols' }).click();
  await expect(page.locator('.sync-symbols')).toContainText('2 symbols');
  await expect(page.locator('.sync-symbols')).toContainText('Last run covered 1 of 2');
  await page.getByRole('tab', { name: /Runs/ }).click();
  const run = page.locator('.run-history tbody tr').first();
  await expect(run).toContainText('succeeded');
  await expect(run).toContainText('1 / 2');
  await run.click();
  await expect(page.locator('.drawer')).toContainText('ERR');
  await expect(page.locator('.drawer')).toContainText('error instead of data');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Schedule' }).click();
  await expect(page.locator('.next-runs li')).toHaveCount(5);
  await page.getByRole('tab', { name: 'Data' }).click();
  await expect(page.locator('.data-grid-table tbody tr').first()).toBeVisible();
  // Editing still works from the detail page.
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Name').fill('EOD fixture (renamed)');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.sync-detail h2')).toHaveText('EOD fixture (renamed)');
  // Schedule modes (#79): weekly preview, an intraday warning for an EOD dataset, Event validation (#82).
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('radio', { name: 'Weekly' }).click();
  await expect(page.getByLabel('Next runs').locator('li')).toHaveCount(5);
  await page.getByRole('radio', { name: 'Interval' }).click();
  await expect(page.locator('.schedule-warning')).toContainText('updates once a day');
  await page.getByRole('radio', { name: 'Event' }).click();
  await expect(page.getByLabel('Days after earnings')).toHaveValue('2');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.modal')).toContainText('After earnings needs an earnings calendar sync');
  await page.getByRole('radio', { name: 'Daily' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  const saved = await api(`/dataset-syncs/${sync.id}`);
  expect([saved.schedule.enabled, saved.schedule.everyMinutes, saved.trigger]).toEqual([
    true,
    1440,
    undefined,
  ]);
  expect(errors).toEqual([]);
});
