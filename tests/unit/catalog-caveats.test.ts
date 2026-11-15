import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { caveatsFor } = await import('../../packages/core/src/catalogCaveats.js');
const ids = (c: { id: string }[]) => c.map((x) => x.id).sort();

test('plan limits attach to the right collections', () => {
  assert.deepEqual(ids(caveatsFor({ collection: 'eod_prices' })), ['delisted-coverage']);
  assert.deepEqual(ids(caveatsFor({ collection: 'universe' })), ['current-sector', 'delisted-coverage']);
  const annual = caveatsFor({ collection: 'analyst_estimates' }).find((c) => c.id === 'annual-only')!;
  assert.match(annual.text, /analyst_estimates_quarterly/, 'points at the quarterly series (#387)');
  assert.ok(ids(caveatsFor({ collection: 'income_statement' })).includes('statement-depth'));
  assert.ok(ids(caveatsFor({ collection: 'key_metrics_quarterly' })).includes('statement-depth'));
  assert.deepEqual(ids(caveatsFor({ collection: 'earnings_calendar' })), ['earnings-timing']);
  assert.deepEqual(ids(caveatsFor({ collection: 'treasury_rates' })), []);
});

test('history caveats are blocking and cite the live start date', () => {
  const est = caveatsFor({
    collection: 'analyst_estimates',
    dateField: 'date',
    dateMin: '2019-12-31',
    firstSnapshot: '2026-10-23',
  });
  const snap = est.find((c) => c.id === 'snapshot-history')!;
  assert.equal(snap.severity, 'blocking');
  assert.match(snap.text, /2026-10-23/);
  assert.equal(est[0].severity, 'blocking', 'blocking caveats sort first');
  const feed = caveatsFor({ collection: 'news_stocks', dateMin: '2026-10-22' });
  assert.deepEqual([feed[0].id, feed[0].severity], ['feed-history', 'blocking']);
  assert.match(feed[0].text, /2026-10-22/);
});

test('feeds with a per-symbol history sync are not forward-only (#387)', () => {
  for (const collection of ['insider_trades', 'congress_senate', 'congress_house', 'price_target_changes']) {
    const c = caveatsFor({ collection, dateMin: '2011-10-15' });
    assert.deepEqual(
      c.map((x) => [x.id, x.severity]),
      [['per-symbol-history', 'warn']],
      collection,
    );
    assert.match(c[0].text, /2011-10-15/);
  }
  const grades = caveatsFor({ collection: 'analyst_grades' })[0];
  assert.equal(grades.id, 'feed-history');
  assert.match(grades.text, /analyst_grades_history/, 'names where the history is');
  const consensus = caveatsFor({ collection: 'grades_consensus' }).find((c) => c.id === 'snapshot-history')!;
  assert.match(consensus.text, /grades_consensus_history/);
});

test('built-ins can be dismissed and curated caveats added', () => {
  const c = caveatsFor(
    { collection: 'eod_prices' },
    {
      dismissedCaveats: ['delisted-coverage'],
      caveats: [{ id: 'gap-2024', severity: 'warn', text: 'Missing 2024-03-01 for 40 symbols.' }],
    },
  );
  assert.deepEqual(
    c.map((x) => `${x.id}:${x.source}`),
    ['gap-2024:curated'],
  );
});
