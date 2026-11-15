// #384 / #385: the Datasets syncs table is ten rows tall, loads 20 rows at a time as it scrolls, starts again at
// the top when the search or sort changes, and sorts the whole list by a column's value from its header.
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
  const api = async (path: string, data?: unknown) => {
    const r = await page.request.fetch('/api' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: base },
      data,
    });
    expect(r.ok(), `${path}: ${await r.text()}`).toBeTruthy();
    const text = await r.text();
    return text ? JSON.parse(text) : undefined;
  };
  const admin = { email: 'admin@openharness.test', password };
  if ((await api('/auth/status')).needsSetup)
    await api('/auth/setup', { ...admin, name: 'Test administrator', setupToken: setupToken() });
  else await api('/auth/login', admin);
  const credentials = { email: `tables-browser-${Date.now()}@openharness.test`, password };
  await api('/users', { ...credentials, name: 'Browser Tables', workspace: 'new' });
  await api('/auth/login', credentials);
  return api;
}

test('the syncs table: ten rows tall, 20 at a time as it scrolls, sortable headers', async ({ page }) => {
  test.setTimeout(180000);
  const api = await workspace(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fmp = await api('/connections', { name: 'FMP', url: 'http://fixtures:9090/mcp?apikey=test-key' });
  for (let i = 1; i <= 45; i++)
    await api('/dataset-syncs', {
      name: `Sync ${String(i).padStart(2, '0')}`,
      connectionId: fmp.id,
      dataset: i % 3 ? 'eod_prices' : 'treasury_rates',
      symbolsMode: 'list',
      symbols: ['GOOD'],
      enabled: true,
      schedule: { enabled: false, everyMinutes: 1440, input: 'x' },
    });

  await page.goto('/datasets/syncs');
  const box = page.locator('.dataset-table');
  const rows = box.locator('tbody tr:not(.table-more)');
  await expect(rows).toHaveCount(20);
  await expect(box.locator('tr.table-more')).toContainText('Showing 20 of 45');
  // Ten rows tall: the header, ten rows and a sliver of the eleventh.
  const height = (await box.boundingBox())!.height;
  const rowHeight = (await rows.first().boundingBox())!.height;
  expect(height / rowHeight).toBeGreaterThan(11);
  expect(height / rowHeight).toBeLessThan(12.5);
  if (process.env.SCREENSHOT)
    await page.screenshot({ path: 'test-results/datasets-table.png', fullPage: true });

  // Infinite scroll: reaching the bottom loads the next 20, then the last 5.
  await box.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(rows).toHaveCount(40);
  await box.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(rows).toHaveCount(45);
  await expect(box.locator('tr.table-more')).toHaveCount(0);

  // Sort by name: ascending, then descending; a new sort starts again at the first page.
  await page.getByRole('button', { name: 'Name', exact: true }).click();
  const nameHeader = page.getByRole('columnheader', { name: /^Name/ });
  await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toContainText('Sync 01');
  await page.getByRole('button', { name: 'Name', exact: true }).click();
  await expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(rows.first()).toContainText('Sync 45');
  // The whole list is sorted, not just the loaded page: row 20 of the descending list is Sync 26.
  await expect(rows.nth(19)).toContainText('Sync 26');
  await page.getByRole('button', { name: 'Dataset', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: /^Dataset/ })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await expect(nameHeader).toHaveAttribute('aria-sort', 'none');
  await expect(rows.first()).toContainText('EOD prices');
  if (process.env.SCREENSHOT) await page.screenshot({ path: 'test-results/datasets-table-sorted.png' });

  // A search shows only its matches and starts again at the top.
  await page.getByPlaceholder('Search syncs').fill('Sync 1');
  await expect(rows).toHaveCount(10);
  await expect(box.locator('tr.table-more')).toHaveCount(0);
  await page.getByPlaceholder('Search syncs').fill('');
  await expect(rows).toHaveCount(20);
  expect(errors).toEqual([]);
});
