// #157: build a pipeline in the editor (generate from dependencies, add nodes, draw dependencies), run it,
// watch the graph and timeline, re-run from a node in the drawer, and round-trip it through YAML.
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
  const credentials = { email: `pipelines-browser-${Date.now()}@openharness.test`, password };
  await api('/users', { ...credentials, name: 'Browser Pipelines', workspace: 'new' });
  await api('/auth/login', credentials);
  return api;
}

test('build, run, inspect, re-run and round-trip a pipeline in the UI', async ({ page }) => {
  test.setTimeout(240000);
  const api = await workspace(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  const mongo = await api('/connections', { name: 'MongoDB', kind: 'mongodb', builtIn: true, url: '' });
  await api(`/mongodb/${mongo.id}/collections`, { name: 'pb_raw' });
  await api(`/mongodb/${mongo.id}/collections/pb_raw/documents`, {
    documents: [{ symbol: 'AAA', date: '2026-01-02', close: 1 }],
  });
  await api('/transforms', {
    name: 'pb_daily',
    code: 'import oh\nrows = oh.read("pb_raw")\noh.output("pb_daily_out").upsert([{**r, "known_at": "2026-01-02T21:00:00Z"} for r in rows])\n',
    inputs: ['pb_raw'],
    outputs: [{ collection: 'pb_daily_out', key: ['symbol', 'date'], known_at_field: 'known_at' }],
  });

  await page.goto('/datasets/pipelines');
  await expect(page.getByText('No pipelines yet')).toBeVisible();
  await page.getByRole('button', { name: 'New pipeline' }).first().click();
  await expect(page).toHaveURL(/\/datasets\/pipelines\/new$/);
  await page.getByLabel('Name').first().fill('ui-daily');
  await page.getByRole('button', { name: 'Generate from dependencies' }).click();
  await expect(page.locator('.pnode', { hasText: 'pb_daily' })).toBeVisible();

  // A check upstream of the transform, and a research node after it.
  await page.getByRole('button', { name: 'Add node' }).click();
  await page.getByLabel('Node id').fill('raw_ready');
  await page.getByLabel('Node type').selectOption('check');
  await page.getByLabel('Node object').selectOption('collection_rows');
  await page.locator('.transform-config').getByLabel('Collection').fill('pb_raw');
  await page.getByRole('button', { name: 'Add node' }).click();
  await page.getByLabel('Node id').fill('research');
  await page.getByLabel('Node type').selectOption('research');
  await page.getByLabel('Node object').fill('stub');
  await page.locator('.after-list').getByLabel('pb_daily').check();
  await page.locator('.pnode', { hasText: 'pb_daily' }).click();
  await page.locator('.after-list').getByLabel('raw_ready').check();
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/datasets\/pipelines\/ui-daily$/);
  await expect(page.locator('.plane', { hasText: 'L2 · Transforms & checks' })).toBeVisible();
  await expect(page.locator('.plane', { hasText: 'L3 · Research' })).toBeVisible();

  // Run it; the graph shows each node succeed, in order.
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.locator('.run-cell')).toHaveCount(1);
  for (const id of ['raw_ready', 'pb_daily', 'research'])
    await expect(page.locator('.pnode', { hasText: id }).locator('.pill')).toHaveText('succeeded', {
      timeout: 120000,
    });
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.locator('.gantt-row')).toHaveCount(3);
  await expect(page.locator('.gantt-run')).toHaveCount(3);
  const [run] = await api(`/pipelines/${(await api('/pipelines'))[0].id}/runs`);
  const n = run.nodes;
  expect(
    n.pb_daily.startedAt >= n.raw_ready.finishedAt && n.research.startedAt >= n.pb_daily.finishedAt,
  ).toBeTruthy();

  // The drawer: re-run from the transform.
  await page.getByRole('tab', { name: 'Graph' }).click();
  await page.locator('.pnode', { hasText: 'pb_daily' }).click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toContainText('attempts 1');
  await drawer.getByRole('button', { name: 'Re-run from here' }).click();
  await expect(page.getByText('Re-running from pb_daily')).toBeVisible();
  await expect(drawer).toContainText('re-run 1×', { timeout: 30000 });
  await expect(page.locator('.pnode', { hasText: 'research' }).locator('.pill')).toHaveText('succeeded', {
    timeout: 120000,
  });
  await page.keyboard.press('Escape');

  // YAML round trip: export, delete, import, and the same graph is back.
  const yaml = await api('/objects/export?kinds=Pipeline');
  const before = (await api('/pipelines'))[0];
  await api(`/pipelines/${before.id}`, undefined, 'DELETE');
  await api('/objects/import', { yaml, mode: 'merge', dryRun: false });
  const after = (await api('/pipelines'))[0];
  expect(after.nodes).toEqual(before.nodes);
  expect(await api('/objects/export?kinds=Pipeline')).toBe(yaml);
  await page.goto('/datasets/pipelines/ui-daily');
  await expect(page.locator('.pnode')).toHaveCount(3);

  // Lineage (#97): Catalog > Graph shows input -> transform -> output; open the output's catalog page.
  await page.goto('/datasets/catalog/_graph');
  // The lineage loads after navigation; allow for a busy stack (a transient 5 s timeout was seen once).
  await expect(page.locator('.lnode-transform', { hasText: 'pb_daily' })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.lnode-transform', { hasText: 'pb_daily' })).toHaveClass(/fresh-fresh/);
  await page.locator('.lnode-collection', { hasText: 'pb_daily_out' }).click();
  await page.getByRole('button', { name: 'Open collection' }).click();
  await expect(page).toHaveURL(/\/datasets\/catalog\/pb_daily_out$/);
  await page.getByRole('tab', { name: 'Lineage' }).click();
  await expect(page.locator('.lnode')).toHaveCount(3);
  expect(errors).toEqual([]);
});
