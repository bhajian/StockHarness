// #90 transform runner end to end: API -> Python executor (real SDK) -> MongoDB -> catalog. Real stack.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
let cookie = '';
let connectionId = '';
async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: response.status === 204 ? undefined : await response.json() };
}
async function ok(path: string, body?: unknown, method?: string) {
  const r = await request(path, body, method);
  assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function runsDone(transformId: string, n: number, timeoutMs = 300000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const runs = await ok(`/transforms/${transformId}/runs`);
    if (runs.length >= n && runs.slice(0, n).every((r: any) => !['queued', 'running'].includes(r.status)))
      return runs;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('transform runs did not finish');
}
const docs = (name: string, filter?: object) =>
  ok(
    `/mongodb/${connectionId}/collections/${name}/documents?limit=200${filter ? `&filter=${encodeURIComponent(JSON.stringify(filter))}` : ''}`,
  );

// Weekday bars for two symbols, 2025-12-15 .. 2026-01-20; AAA has one zero close.
const bars: any[] = [];
for (let t = Date.parse('2025-12-15'); t <= Date.parse('2026-01-20'); t += 86400000) {
  const d = new Date(t);
  if ([0, 6].includes(d.getUTCDay())) continue;
  const date = d.toISOString().slice(0, 10);
  const i = bars.length / 2;
  bars.push({ symbol: 'AAA', date, close: date === '2026-01-08' ? 0 : 100 + i });
  bars.push({ symbol: 'BBB', date, close: 50 + i / 2 });
}
const inWindow = (a: string, b: string) => bars.filter((r) => r.date >= a && r.date <= b).length;

const CODE = `
import oh, pandas as pd
w = oh.window
raw = oh.read_df("tr_raw", {"date": {"$gte": w.lookback_start, "$lte": w.end}}, columns=["symbol", "date", "close"])
raw = raw.sort_values(["symbol", "date"])
raw["ret_1d"] = raw.groupby("symbol")["close"].pct_change()
raw["known_at"] = raw["date"] + "T21:00:00Z"
raw["as_of_date"] = raw["date"]
for r in raw[raw.close == 0].itertuples():
    oh.dq("zero_close", "warn", security_id=r.symbol, date=r.date)
out = raw[raw.date >= w.start]
oh.output("tr_returns").upsert_df(out[["symbol", "date", "close", "ret_1d", "known_at", "as_of_date"]])
oh.output("tr_summary").upsert([{"k": "rows", "value": int(len(out)), "window": w.start + ".." + w.end}])
try:
    oh.write("tr_raw", [{"x": 1}])
    print("GUARD BROKEN")
except PermissionError:
    print("undeclared write refused")
oh.describe("tr_returns", description="Daily returns from tr_raw", fields={"ret_1d": {"description": "1-day return", "unit": "ratio"}})
`;
let transformId = '';

before(async () => {
  const credentials = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  if ((await ok('/auth/status')).needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((l) => l.startsWith('SETUP_TOKEN='))!
      .slice(12);
    await ok('/auth/setup', { ...credentials, name: 'Test administrator', setupToken });
  }
  const login = async (c: { email: string; password: string }) => {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    });
    assert.equal(r.status, 200);
    cookie = r.headers.get('set-cookie')!.split(';')[0];
  };
  await login(credentials);
  const isolated = { email: `transforms-${randomUUID()}@openharness.test`, password: credentials.password };
  await ok('/users', { ...isolated, name: 'Transforms', workspace: 'new' });
  await login(isolated);
  connectionId = (await ok('/connections', { name: 'MongoDB', kind: 'mongodb', builtIn: true, url: '' })).id;
  await ok(`/mongodb/${connectionId}/collections`, { name: 'tr_raw' });
  await ok(`/mongodb/${connectionId}/collections/tr_raw/documents`, { documents: bars });
});

test('a two-output transform runs in the executor: lookback, window, guard, dq, describe, catalog', async () => {
  const t = await ok('/transforms', {
    name: 'tr_returns',
    code: CODE,
    inputs: ['tr_raw'],
    outputs: [
      {
        collection: 'tr_returns',
        key: ['symbol', 'date'],
        known_at_field: 'known_at',
        as_of_field: 'as_of_date',
      },
      { collection: 'tr_summary', key: ['k'], static: true },
    ],
    incremental: { mode: 'date_range', lookback_days: 3 },
  });
  transformId = t.id;
  const [queued] = await ok(`/transforms/${t.id}/run`, {
    range: 'custom',
    start: '2026-01-05',
    end: '2026-01-16',
  });
  assert.equal(queued.window.lookback_start < '2026-01-05', true);
  const [run] = await runsDone(t.id, 1);
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  const n = inWindow('2026-01-05', '2026-01-16');
  assert.equal(run.outputs.tr_returns.written, n, 'only rows in [start, end] are written');
  assert.ok(run.reads.tr_raw > n, 'the lookback was loaded');
  const detail = await ok(`/transform-runs/${run.id}`);
  assert.match(detail.stdout, /undeclared write refused/);
  const out = await docs('tr_returns', { date: '2026-01-05' });
  assert.equal(out.total, 2);
  assert.ok(
    out.documents.every((d: any) => typeof d.ret_1d === 'number'),
    'the first window day has a return thanks to the lookback',
  );
  assert.equal((await docs('dq_issues', { issue_type: 'zero_close' })).total, 1);
  // The run drawer's DQ list (#96): issues on the transform's outputs seen during the run.
  const runDq = await ok(`/transform-runs/${run.id}/dq`);
  assert.deepEqual(
    runDq.map((d: any) => [d.collection, d.issue_type, d.security_id]),
    [['tr_returns', 'zero_close', 'AAA']],
  );
  const cat = await ok('/catalog/tr_returns');
  assert.equal(cat.layer, 2);
  assert.equal(cat.producedBy[0].type, 'transform');
  assert.equal(cat.description, 'Daily returns from tr_raw');
  assert.equal(cat.timeSemantics.status, 'pit');
  assert.equal(cat.fields.find((f: any) => f.name === 'ret_1d').unit, 'ratio');
  // The list shows each transform's latest run; the recent-runs feed backs the KPIs (#94).
  const listed = (await ok('/transforms')).find((x: any) => x.id === t.id);
  assert.equal(listed.lastRun.id, run.id);
  assert.equal(listed.lastRun.stdout, undefined, 'the list omits logs');
  const recent = await ok(
    `/transform-runs?since=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`,
  );
  assert.ok(recent.some((r: any) => r.id === run.id));
  assert.equal((await request('/transform-runs?since=nope')).status, 400);
});

test('re-running the same window is idempotent; a full backfill runs yearly chunks in order', async () => {
  await ok(`/transforms/${transformId}/run`, { range: 'custom', start: '2026-01-05', end: '2026-01-16' });
  const [again] = await runsDone(transformId, 1);
  assert.equal(again.status, 'succeeded');
  assert.equal(again.outputs.tr_returns.written, 0);
  assert.equal(again.outputs.tr_returns.unchanged, inWindow('2026-01-05', '2026-01-16'));
  const chunks = await ok(`/transforms/${transformId}/run`, {
    range: 'full',
    start: '2025-12-15',
    end: '2026-01-20',
  });
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].batchId && chunks[0].batchId === chunks[1].batchId);
  const done = await runsDone(transformId, 2);
  assert.deepEqual(
    done.slice(0, 2).map((r: any) => r.status),
    ['succeeded', 'succeeded'],
  );
  assert.equal(
    (await docs('tr_returns')).total,
    bars.length,
    'every bar in the full range (first days per symbol have a null return)',
  );
});

async function previewDone(id: string, timeoutMs = 300000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const p = await ok(`/transform-previews/${id}`);
    if (p.status !== 'running') return p;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('preview did not finish');
}

test('a preview runs a draft on a sample without writing and checks every output (#95)', async () => {
  const saved = await ok(`/transforms/${transformId}`);
  // A draft (unsaved edits): a renamed output and a summary keyed only by k (not unique per row).
  const draft = {
    ...saved,
    outputs: [{ ...saved.outputs[0], collection: 'tr_preview_out' }, saved.outputs[1]],
    code: CODE.replaceAll('"tr_returns"', '"tr_preview_out"').replace(
      'oh.output("tr_summary").upsert([',
      'oh.output("tr_summary").upsert([{"k": "rows", "value": 0}, ',
    ),
  };
  for (const k of [
    'id',
    'version',
    'createdAt',
    'updatedAt',
    'createdBy',
    'updatedBy',
    'lastRun',
    'nextRunAt',
  ])
    delete draft[k];
  const started = await ok('/transforms/preview', {
    transform: draft,
    start: '2026-01-05',
    end: '2026-01-16',
  });
  assert.equal(started.status, 'running');
  assert.deepEqual(
    started.symbols,
    ['AAA', 'BBB'],
    'the sample comes from the input when there is no universe',
  );
  const p = await previewDone(started.id);
  assert.equal(p.status, 'succeeded', JSON.stringify(p));
  const out = p.outputs.tr_preview_out;
  assert.equal(out.count, inWindow('2026-01-05', '2026-01-16'));
  assert.ok(out.rows.length > 0 && out.rows.length <= 100);
  const check = (o: any, id: string) => o.checks.find((c: any) => c.id === id)?.status;
  assert.equal(check(out, 'key_unique'), 'pass');
  assert.equal(check(out, 'known_at'), 'pass');
  assert.equal(check(p.outputs.tr_summary, 'key_unique'), 'fail');
  assert.equal(out.dq.length, 1, 'the zero close is reported, not stored');
  assert.equal((await docs('tr_preview_out')).total, 0, 'nothing was written');
  assert.equal((await docs('dq_issues', { collection: 'tr_preview_out' })).total, 0);
  // The saved version: its output exists in the catalog, so the schema is compared with the last run.
  const savedPreview = await previewDone((await ok(`/transforms/${transformId}/preview`, {})).id);
  assert.equal(
    check(savedPreview.outputs.tr_returns, 'schema'),
    'pass',
    JSON.stringify(savedPreview.outputs.tr_returns.checks),
  );
  // An invalid draft is refused before anything runs.
  const bad = await request('/transforms/preview', {
    transform: { ...draft, outputs: [{ collection: 'x', key: ['k'] }] },
  });
  assert.equal(bad.status, 400);
});

test('a transform that runs after another is triggered by its completion (#92)', async () => {
  const follower = await ok('/transforms', {
    name: 'tr_follow',
    code: 'import oh\noh.output("tr_follow_out").upsert([{"k": "w", "start": oh.window.start, "end": oh.window.end}])\n',
    inputs: ['tr_returns'],
    outputs: [{ collection: 'tr_follow_out', key: ['k'], static: true }],
    incremental: { mode: 'date_range', lookback_days: 0 },
    trigger: { after: ['transform:tr_returns'] },
  });
  assert.match(
    (
      await request(
        `/transforms/${transformId}`,
        { ...(await ok(`/transforms/${transformId}`)), trigger: { after: ['transform:tr_follow'] } },
        'PUT',
      )
    ).data.error,
    /Trigger cycle/,
  );
  await ok(`/transforms/${transformId}/run`, { range: 'custom', start: '2026-01-12', end: '2026-01-16' });
  const [run] = await runsDone(follower.id, 1);
  assert.equal(run.trigger, 'event');
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  assert.deepEqual(
    [run.window.start, run.window.end],
    ['2026-01-12', '2026-01-16'],
    "the upstream run's window",
  );
  const [doc] = (await docs('tr_follow_out')).documents;
  assert.deepEqual([doc.start, doc.end], ['2026-01-12', '2026-01-16']);
  await new Promise((r) => setTimeout(r, 8000));
  assert.equal((await ok(`/transforms/${follower.id}/runs`)).length, 1, 'triggered exactly once');
});

test('a failing transform records the error and traceback', async () => {
  const bad = await ok('/transforms', {
    name: 'tr_broken',
    code: 'import oh\nraise ValueError("deliberate failure")\n',
    inputs: ['tr_raw'],
    outputs: [{ collection: 'tr_broken_out', key: ['k'], known_at_field: 'known_at' }],
  });
  await ok(`/transforms/${bad.id}/run`, {});
  const [run] = await runsDone(bad.id, 1);
  assert.equal(run.status, 'failed');
  const detail = await ok(`/transform-runs/${run.id}`);
  assert.match(detail.stderr, /ValueError: deliberate failure/);
});
