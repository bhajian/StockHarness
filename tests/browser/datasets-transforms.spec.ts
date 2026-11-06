// #73 / #94: Datasets tabs route by URL; a transform is created from the Flatten template, saved and listed,
// entirely in the UI; the editor shows Monaco, the inputs pane and the outputs panel.
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
  const credentials = { email: `transforms-browser-${Date.now()}@openharness.test`, password };
  await api('/users', { ...credentials, name: 'Browser Transforms', workspace: 'new' });
  await api('/auth/login', credentials);
  return api;
}

test('Datasets tabs and a Flatten transform created in the UI', async ({ page }) => {
  const api = await workspace(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (dialog) => void dialog.accept());
  // The Flatten template reads company_profiles; inputs must exist.
  const mongo = await api('/connections', { name: 'MongoDB', kind: 'mongodb', builtIn: true, url: '' });
  await api(`/mongodb/${mongo.id}/collections`, { name: 'company_profiles' });
  await api(`/mongodb/${mongo.id}/collections/company_profiles/documents`, {
    documents: [{ symbol: 'AAA', companyName: 'Triple A', sector: 'Tech', exchange: 'NASDAQ' }],
  });

  await page.goto('/datasets');
  await expect(page).toHaveURL(/\/datasets\/syncs$/);
  await expect(page.getByRole('tab', { name: 'Syncs' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Transforms' }).click();
  await expect(page).toHaveURL(/\/datasets\/transforms$/);
  await expect(page.getByText('No transforms yet')).toBeVisible();

  await page.getByRole('button', { name: 'New transform' }).first().click();
  await page.getByRole('button', { name: /Flatten/ }).click();
  await expect(page).toHaveURL(/\/datasets\/transforms\/new$/);
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 });
  await expect(page.getByLabel('Output collection')).toHaveCount(3);
  // A non-static output without known_at blocks saving.
  await page.getByLabel('known_at field').first().fill('');
  await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled();
  await page.getByLabel('known_at field').first().fill('known_at');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/datasets\/transforms\/profiles_flat$/);
  await expect(page.getByText('Created profiles_flat v1')).toBeVisible();

  const [saved] = await api('/transforms');
  expect(saved.outputs.map((o: any) => o.collection)).toEqual([
    'company_identity',
    'company_classification',
    'company_listing',
  ]);
  expect(saved.code).toContain('oh.output("company_listing")');

  // Preview (#95): runs in the executor on a sample, checks every output, writes nothing.
  await page.getByRole('button', { name: 'Preview' }).click();
  const bar = page.locator('.validation-bar');
  await expect(bar).toContainText('Key is unique', { timeout: 120000 });
  await expect(bar).toContainText('company_listing');
  const panel = page.locator('.preview-panel');
  await expect(panel).toContainText('nothing written');
  await expect(panel.locator('td', { hasText: 'Triple A' })).toBeVisible();
  await panel.getByLabel('Preview output').selectOption('company_classification');
  await expect(panel.locator('td', { hasText: 'Tech' })).toBeVisible();
  await panel.getByRole('tab', { name: 'Schema' }).click();
  await expect(panel).toContainText('sector');
  const collections = await api(`/mongodb/${mongo.id}/collections`);
  expect(JSON.stringify(collections)).toContain('company_profiles');
  expect(JSON.stringify(collections)).not.toContain('company_identity');

  // Versions (#96): save v2, diff v1 with v2, restore v1 as v3.
  await page.getByLabel('Description').first().fill('Second version');
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByText('Saved v2')).toBeVisible();
  await page.getByRole('tab', { name: /Versions/ }).click();
  await expect(page.locator('.versions-list')).toContainText('v2');
  await page.locator('.versions-diff').getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('.versions-diff .monaco-diff-editor')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.versions-diff')).toContainText('Second version');
  await page.locator('.versions-list tr', { hasText: 'v1' }).getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Restored v1 as v3')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Versions (3)' })).toBeVisible();
  const versions = await api(`/transforms/${saved.id}/versions`);
  expect(versions.map((v: any) => [v.version, v.note ?? ''])).toEqual([
    [3, 'Restored from v1'],
    [2, ''],
    [1, ''],
  ]);

  // Run history (#96): run the saved version, then open the run in the drawer.
  await page.getByRole('button', { name: 'Run now' }).click();
  await page.getByRole('button', { name: 'Queue run' }).click();
  await page.getByRole('tab', { name: /Run history/ }).click();
  const runRow = page.locator('.run-history tbody tr').first();
  await expect(runRow).toContainText('succeeded', { timeout: 120000 });
  await runRow.click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toContainText('company_identity');
  await expect(drawer).toContainText('stdout');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  // Back to the list: the transform, its inputs and outputs; browser back returns to the editor.
  await page.locator('.transform-editor-head').getByRole('button', { name: 'Transforms' }).click();
  const row = page.locator('.transforms-table tr', { hasText: 'profiles_flat' });
  await expect(row).toContainText('company_profiles');
  await expect(row).toContainText('company_listing');
  // #312: when it runs, in words; the explainer; an output links to its rows in the Catalog.
  await expect(page.getByLabel('How Layer 2 works')).toBeVisible();
  await expect(row.locator('.when-runs')).not.toBeEmpty();
  if (process.env.SCREENSHOT) await page.screenshot({ path: 'test-results/transforms-list.png', fullPage: true });
  await page.goBack();
  await expect(page).toHaveURL(/\/datasets\/transforms\/profiles_flat$/);
  await page.getByRole('tab', { name: 'Syncs' }).click();
  await expect(page).toHaveURL(/\/datasets\/syncs$/);
  expect(errors).toEqual([]);
});
