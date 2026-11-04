// #156 pipelines: periods, DAG helpers, gates and the definition schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const P = await import('../../packages/core/src/pipelines.js');
const { evaluateGate } = await import('../../packages/core/src/pipelineEngine.js');

test('periods: day, ISO week, month; a run covers the period of the day before it', () => {
  assert.deepEqual(P.periodOf('week', '2026-11-07'), {
    kind: 'week',
    id: '2026-W45',
    start: '2026-11-02',
    end: '2026-11-08',
  });
  assert.deepEqual(P.periodOf('month', '2026-02-10'), {
    kind: 'month',
    id: '2026-02',
    start: '2026-02-01',
    end: '2026-02-28',
  });
  assert.equal(P.periodOf('week', '2027-01-01').id, '2026-W53', 'ISO weeks can belong to the previous year');
  // Saturday 06:00 -> that week; daily -> yesterday; the 1st of the month -> last month.
  assert.equal(P.periodForRun('week', new Date('2026-11-07T11:00:00Z')).id, '2026-W45');
  assert.equal(P.periodForRun('day', new Date('2026-11-04T10:00:00Z')).id, '2026-11-03');
  assert.equal(P.periodForRun('month', new Date('2026-12-01T10:00:00Z')).id, '2026-11');
  assert.deepEqual(P.parsePeriod('week', '2026-W45'), P.periodOf('week', '2026-11-04'));
  assert.deepEqual(P.parsePeriod('week', '2026-W01').start, '2025-12-29');
  assert.deepEqual(
    P.periodRange('week', '2026-W43', '2026-W46').map((p) => p.id),
    ['2026-W43', '2026-W44', '2026-W45', '2026-W46'],
  );
  assert.deepEqual(
    P.periodRange('month', '2026-11', '2027-01').map((p) => p.id),
    ['2026-11', '2026-12', '2027-01'],
  );
  assert.throws(() => P.parsePeriod('week', '2026-11-03'), /Not a week period/);
});

test('DAG helpers: cycles, upstream and downstream', () => {
  const nodes = [
    { id: 'a', after: [] },
    { id: 'b', after: ['a'] },
    { id: 'c', after: ['a'] },
    { id: 'd', after: ['b', 'c'] },
  ];
  assert.equal(P.pipelineCycle(nodes), undefined);
  assert.deepEqual(P.pipelineCycle([...nodes.slice(1), { id: 'a', after: ['d'] }]), ['b', 'a', 'd', 'b']);
  assert.deepEqual([...P.upstreamOf(nodes, 'd')].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...P.downstreamOf(nodes, 'b')], ['d']);
  assert.deepEqual([...P.downstreamOf(nodes, 'a')].sort(), ['b', 'c', 'd']);
});

test('gates: coverage, rows, row drop and DQ rate', () => {
  const g = evaluateGate(
    { min_symbol_coverage: 0.95, min_rows: 10, max_row_drop_pct: 20, max_dq_error_rate: 0.01 },
    { rows: 70, symbols_attempted: 100, symbols_covered: 60, dq: 2, written: 70 },
    { rows: 100 },
  );
  assert.deepEqual(
    g.map((x) => [x.name, x.value, x.pass]),
    [
      ['symbol coverage', 60, false],
      ['rows', 70, true],
      ['row drop vs previous period', 30, false],
      ['DQ issues per row', 0.0286, false],
    ],
  );
  assert.deepEqual(evaluateGate({}, {}), [], 'no gate, no checks');
  assert.equal(evaluateGate({ max_row_drop_pct: 5 }, { rows: 1 })[0].pass, true, 'no previous period passes');
  assert.equal(
    evaluateGate({ min_symbol_coverage: 0.5 }, { rows: 1 })[0].pass,
    false,
    'unknown coverage fails',
  );
});

test('the definition schema: refs, defaults, unknown fields refused', () => {
  const p = P.pipelineInputSchema.parse({
    name: 'weekly-research',
    period: 'week',
    nodes: [{ id: 'eod', ref: 'sync:L1 — EOD prices', gate: { min_symbol_coverage: 0.95 } }],
  });
  assert.equal(p.nodes[0].on_upstream_failure, 'block');
  assert.equal(p.nodes[0].retries, 1);
  assert.equal(P.refType(p.nodes[0].ref), 'sync');
  assert.equal(P.refName(p.nodes[0].ref), 'L1 — EOD prices');
  assert.equal(
    P.pipelineInputSchema.safeParse({ ...p, nodes: [{ id: 'x', ref: 'bogus:x' }] }).success,
    false,
  );
  assert.equal(P.pipelineInputSchema.safeParse({ ...p, extra: 1 }).success, false);
  assert.equal(
    P.pipelineNodeSchema.safeParse({ id: 'x', ref: 'transform:t', gate: { nope: 1 } }).success,
    false,
  );
});
