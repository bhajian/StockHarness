import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { caveatsFor } = await import('../../packages/core/src/catalogCaveats.js');
const ids = (c: { id: string }[]) => c.map((x) => x.id).sort();

test('plan limits attach to the right collections', () => {
  assert.deepEqual(ids(caveatsFor({ collection: 'eod_prices' })), ['delisted-coverage']);
  assert.deepEqual(ids(caveatsFor({ collection: 'universe' })), [
    'current-sector',
    'delisted-coverage',
    'index-constituents',
  ]);
  assert.ok(ids(caveatsFor({ collection: 'analyst_estimates' })).includes('annual-only'));
  assert.ok(ids(caveatsFor({ collection: 'income_statement' })).includes('statement-depth'));
  assert.deepEqual(ids(caveatsFor({ collection: 'earnings_calendar' })), ['earnings-timing']);
  assert.deepEqual(ids(caveatsFor({ collection: 'treasury_rates' })), []);
});

test('history caveats are blocking and cite the live start date', () => {
  const est = caveatsFor({
    collection: 'analyst_estimates',
    dateField: 'snapshot_date',
    dateMin: '2026-10-23',
  });
  const snap = est.find((c) => c.id === 'snapshot-history')!;
  assert.equal(snap.severity, 'blocking');
  assert.match(snap.text, /2026-10-23/);
  assert.equal(est[0].severity, 'blocking', 'blocking caveats sort first');
  const feed = caveatsFor({ collection: 'insider_trades', dateMin: '2026-10-22' });
  assert.deepEqual([feed[0].id, feed[0].severity], ['feed-history', 'blocking']);
  assert.match(feed[0].text, /2026-10-22/);
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
