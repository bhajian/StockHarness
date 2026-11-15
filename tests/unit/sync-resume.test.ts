// #416: what happens to a dataset sync run a restart interrupted, and which collections the duplicate audit reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { planResume } = await import('../../packages/core/src/datasetSync.js');
const { auditTargets } = await import('../../scripts/duplicate-audit.js');
const { DATASET_CATALOG } = await import('../../packages/core/src/datasetCatalog.js');

const progress = (next: number, symbols?: string[], extra: Record<string, unknown> = {}) => ({
  progress: { next, symbols, runDate: '2026-11-14', rows: 0, covered: 0, errors: 0, calls: 0, ...extra },
});

test('a per-symbol run with a saved symbol list resumes at its saved index', () => {
  const sync = { enabled: true, dataset: 'grades_consensus' };
  assert.deepEqual(planResume(progress(5, ['A', 'B', 'C', 'D', 'E', 'F']), sync), {
    action: 'resume',
    next: 5,
  });
  assert.deepEqual(
    planResume(progress(9, ['A', 'B']), sync),
    { action: 'resume', next: 2 },
    'never past the end',
  );
});

test('feeds, windows, market snapshots and runs that died before their first save start again', () => {
  assert.deepEqual(planResume(progress(0), { enabled: true, dataset: 'grades_consensus' }), {
    action: 'restart',
  });
  assert.deepEqual(
    planResume({}, { enabled: true, dataset: 'treasury_rates' }),
    { action: 'restart' },
    'legacy run',
  );
  assert.deepEqual(planResume(progress(0), { enabled: true, dataset: 'news_stocks' }), { action: 'restart' });
});

test('runs whose sync is gone, disabled or a partial run without its symbols are closed', () => {
  assert.equal(planResume(progress(3, ['A']), null).action, 'fail');
  assert.equal(planResume(progress(3, ['A']), { enabled: false, dataset: 'eod_prices' }).action, 'fail');
  assert.equal(
    planResume(progress(0, undefined, { partial: true }), { enabled: true, dataset: 'income_statement' })
      .action,
    'fail',
  );
  assert.equal(
    planResume(progress(1, ['AAPL', 'MSFT'], { partial: true }), {
      enabled: true,
      dataset: 'income_statement',
    }).action,
    'resume',
    'a partial run that saved its symbols resumes',
  );
});

test('the duplicate audit reads every collection a dataset writes, once, with its key', () => {
  const t = auditTargets();
  const names = t.map((x) => x.collection);
  assert.equal(new Set(names).size, names.length);
  for (const d of DATASET_CATALOG) {
    const row = t.find((x) => x.collection === d.defaultCollection)!;
    assert.ok(row, d.id);
    assert.deepEqual(row.key, d.keyFields, `${d.id}: datasets sharing a collection share its key`);
  }
  assert.deepEqual(t.find((x) => x.collection === 'delisted_companies')!.key, ['symbol', 'delistedDate']);
});
