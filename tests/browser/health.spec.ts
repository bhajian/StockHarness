// #86 Datasets → Health: a source that stopped updating is stale in the table and the top bar; a missing session
// is a hollow gap cell.
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
  const credentials = { email: `health-browser-${Date.now()}@openharness.test`, password };
  await api('/users', { ...credentials, name: 'Browser Health', workspace: 'new' });
  await api('/auth/login', credentials);
  return api;
}
const weekdaysBack = (from: number, to: number) => {
  // Weekdays between `from` and `to` days ago (UTC), oldest first.
  const out: string[] = [];
  for (let k = from; k >= to; k--) {
    const d = new Date(Date.now() - k * 86400000);
    if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

test('a stale source and a missing session show in Health and the top bar', async ({ page }) => {
  test.setTimeout(180000);
  const api = await workspace(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const mongo = await api('/connections', { name: 'MongoDB', kind: 'mongodb', builtIn: true, url: '' });
  // Weekdays from 40 to 15 days ago, with one session in the middle missing; nothing in the last two weeks.
  const days = weekdaysBack(40, 15);
  const missing = days[8];
  await api(`/mongodb/${mongo.id}/collections`, { name: 'hl_raw' });
  await api(`/mongodb/${mongo.id}/collections/hl_raw/documents`, {
    documents: days.filter((d) => d !== missing).map((date) => ({ symbol: 'AAA', date, close: 1 })),
  });
  const t = await api('/transforms', {
    name: 'hl_daily',
    code: 'import oh\nrows = oh.read("hl_raw")\noh.output("hl_daily").upsert([{**r, "known_at": r["date"] + "T21:00:00Z"} for r in rows])\n',
    inputs: ['hl_raw'],
    outputs: [
      { collection: 'hl_daily', key: ['symbol', 'date'], known_at_field: 'known_at', as_of_field: 'date' },
    ],
    // A daily cadence (never due during the test): freshness then expects a row every session.
    trigger: {
      schedule: { enabled: true, everyMinutes: 1440, at: '23:59', timezone: 'UTC', input: 'x' },
      after: [],
    },
  });
  await api(`/transforms/${t.id}/run`, {});
  await expect
    .poll(async () => (await api(`/transforms/${t.id}/runs`))[0]?.status, { timeout: 120000 })
    .toBe('succeeded');

  await page.goto('/datasets/health');
  const row = page.locator('.health-table tr', { hasText: 'hl_daily' });
  await expect(row.locator('.pill')).toContainText('stale');
  await expect(row).toContainText('sessions behind');
  await row.getByRole('button', { name: 'Compute gaps' }).click();
  await expect(row.locator('.gap-strip')).toBeVisible({ timeout: 60000 });
  await expect(row.locator(`.gap-strip i.gap[title="${missing}: no rows"]`)).toHaveCount(1);
  await expect(row.locator(`.gap-strip i.has[title^="${days[9]}: "]`)).toHaveCount(1);
  // The top bar: amber, and it opens Health.
  const indicator = page.locator('.data-freshness');
  await expect(indicator).toHaveClass(/level-amber/);
  await expect(indicator).toContainText('stale');
  await page.goto('/datasets/syncs');
  await page.locator('.data-freshness').click();
  await expect(page).toHaveURL(/\/datasets\/health$/);
  await expect(page.getByRole('tab', { name: 'Health' })).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});
