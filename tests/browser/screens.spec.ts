// #283: a screenshot sweep of every studio page at 1440 and 1024 px, with layout checks: clipped text, text
// boxes that overlap, panels with nothing in them, and a page wider than the window. Runs only with SCREENS=1
// (after suites that seed the admin workspace); it writes test-results/screens/*.png and report.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const out = 'test-results/screens';
test.skip(!process.env.SCREENS, 'set SCREENS=1 to run the screenshot sweep');
test.setTimeout(20 * 60_000);

function setupToken() {
  if (process.env.SETUP_TOKEN) return process.env.SETUP_TOKEN;
  const line = readFileSync('.env', 'utf8')
    .split('\n')
    .find((l) => l.startsWith('SETUP_TOKEN='));
  return line?.slice('SETUP_TOKEN='.length).trim() ?? '';
}
async function api(page: Page, path: string, data?: unknown) {
  const r = await page.request.fetch('/api' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Origin: base },
    data,
  });
  const text = await r.text();
  try {
    return { ok: r.ok(), body: text ? JSON.parse(text) : undefined };
  } catch {
    return { ok: r.ok(), body: text };
  }
}

/** The layout problems on the page now (run in the browser). */
function audit() {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0;
  };
  const name = (el: Element) => {
    const cls =
      typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
  };
  const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const issues: { kind: string; where: string; text: string; detail?: string }[] = [];
  const all = [...document.querySelectorAll('main *, .modal *, .topbar *')].filter(visible);
  // Clipped: content wider than its box in a box that hides overflow, without an ellipsis.
  for (const el of all) {
    const s = getComputedStyle(el);
    if (!['hidden', 'clip'].includes(s.overflowX)) continue;
    if (s.textOverflow === 'ellipsis') continue;
    if (el.scrollWidth > el.clientWidth + 2 && text(el))
      issues.push({
        kind: 'clipped',
        where: name(el),
        text: text(el),
        detail: `${el.scrollWidth}>${el.clientWidth}`,
      });
  }
  // Overlap: two leaf text boxes (neither inside the other) that intersect by more than a few pixels.
  const leaves = all.filter(
    (el) =>
      [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim()) &&
      !['OPTION', 'SCRIPT', 'STYLE'].includes(el.tagName) &&
      getComputedStyle(el).position !== 'fixed',
  );
  // Per line box (wrapped inline text has one rect per line, not one big rect).
  const boxes = leaves.map((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return { el, rs: [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0) };
  });
  const hit = (a: DOMRect, b: DOMRect) =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 4 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4;
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!,
        b = boxes[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (a.rs.some((x) => b.rs.some((y) => hit(x, y))))
        issues.push({
          kind: 'overlap',
          where: `${name(a.el)} × ${name(b.el)}`,
          text: `${text(a.el)} | ${text(b.el)}`,
        });
    }
  // Empty: a card or panel with no text, no chart and no control in it.
  for (const el of document.querySelectorAll(
    'main [class*="card"], main [class*="panel"], main section, main .chart, main [class*="kpi"]',
  )) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 40) continue;
    if (text(el)) continue;
    if (el.querySelector('svg, canvas, img, input, select, textarea, button, table')) continue;
    issues.push({
      kind: 'empty',
      where: name(el),
      text: '',
      detail: `${Math.round(r.width)}×${Math.round(r.height)}`,
    });
  }
  if (document.documentElement.scrollWidth > innerWidth + 2) {
    // The outermost elements that stick out past the window, so the cause is named, not just the symptom.
    const wide = all.filter((el) => {
      const r = el.getBoundingClientRect();
      const p = el.parentElement?.getBoundingClientRect();
      return r.right > innerWidth + 2 && (!p || p.right <= innerWidth + 2);
    });
    issues.push({
      kind: 'page-wider',
      where: wide.slice(0, 6).map(name).join(', ') || 'document',
      text: '',
      detail: `${document.documentElement.scrollWidth}>${innerWidth}`,
    });
  }
  return issues;
}

test('screenshot sweep of every studio page', async ({ page }) => {
  mkdirSync(out, { recursive: true });
  const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  if ((await api(page, '/auth/status')).body?.needsSetup)
    await api(page, '/auth/setup', { ...admin, name: 'Test administrator', setupToken: setupToken() });
  else expect((await api(page, '/auth/login', admin)).ok).toBeTruthy();
  const login = async (email: string) =>
    expect((await api(page, '/auth/login', { email, password: admin.password })).ok).toBeTruthy();
  const list = async (path: string) => {
    const r = await api(page, path);
    const items = r.ok ? (Array.isArray(r.body) ? r.body : (r.body?.items ?? [])) : [];
    return items as any[];
  };
  const platform: [string, string][] = [
    ['harnesses', '/harnesses'],
    ['playground', '/playground'],
    ['skills', '/skills'],
    ['connections', '/connections'],
    ['knowledge', '/knowledge'],
    ['collections', '/knowledge/collections'],
    ['inbox', '/inbox'],
    ['executions', '/executions'],
    ['integrations', '/integrations'],
    ['settings', '/settings'],
  ];
  const dataRoutes = async (): Promise<[string, string][]> => {
    const idea = (await list('/ideas'))[0]?.ref;
    const evaluation = (await list('/evaluations'))[0];
    const simulation = (await list('/simulations'))[0];
    const transform = (await list('/transforms'))[0]?.name;
    return [
      ['map', '/map'],
      ['datasets-syncs', '/datasets/syncs'],
      ['datasets-transforms', '/datasets/transforms'],
      ...(transform
        ? ([['datasets-transform', `/datasets/transforms/${transform}`]] as [string, string][])
        : []),
      ['datasets-pipelines', '/datasets/pipelines'],
      ['datasets-catalog', '/datasets/catalog'],
      ['datasets-health', '/datasets/health'],
      ['research-lab', '/research/lab'],
      ['research-setup', '/research/setup'],
      ['research-how', '/research/how'],
      ['research-cycles', '/research/cycles'],
      ['ideas', '/ideas'],
      ...(idea
        ? ([
            ['idea', `/ideas/${idea}`],
            ['idea-review', `/ideas/${idea}/review`],
            ['idea-code', `/ideas/${idea}/code`],
            ['idea-runs', `/ideas/${idea}/runs`],
          ] as [string, string][])
        : []),
      ['evaluations', '/evaluations'],
      ...(evaluation
        ? ([['evaluation', `/evaluations/${evaluation.id ?? evaluation._id}`]] as [string, string][])
        : []),
      ['simulations', '/simulations'],
      ...(simulation
        ? ([['simulation', `/simulations/${simulation.id ?? simulation._id}`]] as [string, string][])
        : []),
    ];
  };
  // One workspace per run: the script moves the admin into a seeded workspace (SCREENS_TAG=data…, data pages
  // only) or leaves it in its own empty one (SCREENS_TAG=empty, every page).
  const tag = process.env.SCREENS_TAG ?? 'empty';
  await login(admin.email);
  const routes = tag === 'empty' ? [...platform, ...(await dataRoutes())] : await dataRoutes();
  const report: Record<string, unknown> = {};
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [label, path] of routes) {
      await page.goto(path);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${out}/${tag}-${width}-${label}.png`, fullPage: true });
      report[`${tag} ${width} ${label}`] = await page.evaluate(audit);
    }
  }
  writeFileSync(`${out}/report-${tag}.json`, JSON.stringify({ errors, pages: report }, null, 2));
  expect(errors, errors.join('\n')).toEqual([]);
});
