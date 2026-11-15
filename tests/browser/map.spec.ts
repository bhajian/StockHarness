// #412: the Map keeps every card's text inside its box: long sync names, long collection names and long errors
// are cut with an ellipsis or wrapped and clamped, with the full text as the tooltip.
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
  const credentials = { email: `map-browser-${Date.now()}@openharness.test`, password };
  await api('/users', { ...credentials, name: 'Browser Map', workspace: 'new' });
  await api('/auth/login', credentials);
  return api;
}

for (const width of [1600, 1280]) {
  test(`map cards keep their text inside at ${width}px`, async ({ page }) => {
    test.setTimeout(120000);
    const api = await workspace(page);
    const fmp = await api('/connections', { name: 'FMP', url: 'http://fixtures:9090/mcp?apikey=test-key' });
    const names = [
      'L1 — Analyst estimates (quarterly) with a very long descriptive name that never ends',
      'L1 — Revenue by product segmentation for every company in the universe',
      'Short',
    ];
    for (const [i, name] of names.entries())
      await api('/dataset-syncs', {
        name,
        connectionId: fmp.id,
        dataset: 'eod_prices',
        targetCollection: i === 1 ? 'revenue_product_segmentation_quarterly_history_backfill' : undefined,
        symbolsMode: 'list',
        symbols: ['GOOD'],
        enabled: true,
        schedule: { enabled: false, everyMinutes: 1440, input: 'x' },
      });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/map');
    const cards = page.locator('.map-card');
    await expect(cards.first()).toBeVisible();
    await expect(page.getByLabel('Data sources').locator('.map-card')).toHaveCount(3);
    // No descendant of a card reaches past the card's padding box, and no card scrolls sideways.
    const overflow = await cards.evaluateAll((els) =>
      els.flatMap((card) => {
        const box = card.getBoundingClientRect();
        const out: string[] = [];
        if (card.scrollWidth > card.clientWidth + 1)
          out.push(`card scrolls: ${card.textContent?.slice(0, 40)}`);
        for (const el of card.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width && (r.right > box.right + 1 || r.left < box.left - 1))
            out.push(
              `${el.tagName} "${el.textContent?.slice(0, 40)}" ${Math.round(r.right - box.right)}px over`,
            );
        }
        return out;
      }),
    );
    expect(overflow).toEqual([]);
    // The full name is the tooltip of a cut-off title.
    await expect(
      page.locator('.map-card-head strong', { hasText: 'Analyst estimates (quarterly)' }),
    ).toHaveAttribute('title', names[0]);
    if (process.env.SCREENSHOT)
      await page.screenshot({ path: `test-results/map-${width}.png`, fullPage: true });
  });
}
