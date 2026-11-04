// #97 lineage freshness rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { freshnessOf, staleAfterDays } = await import('../../packages/core/src/lineage.js');

test('stale thresholds follow the cadence', () => {
  assert.equal(staleAfterDays(1440), 3);
  assert.equal(staleAfterDays(10080), 18);
  assert.equal(staleAfterDays('Every Saturday at 06:00'), 10);
  assert.equal(staleAfterDays('Every day at 18:00'), 3);
  assert.equal(staleAfterDays('Every 2 days'), 5);
  assert.equal(staleAfterDays('Every 15 minutes'), 1);
  assert.equal(staleAfterDays(undefined), 8);
});

test('failed beats age; never-updated is unknown', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  assert.equal(freshnessOf('2026-11-03T12:00:00Z', 'ok', 1440, now), 'fresh');
  assert.equal(freshnessOf('2026-10-28T12:00:00Z', 'ok', 1440, now), 'stale');
  assert.equal(freshnessOf('2026-10-28T12:00:00Z', 'ok', 'Every Saturday at 06:00', now), 'fresh');
  assert.equal(freshnessOf('2026-11-04T11:00:00Z', 'failed', 1440, now), 'failed');
  assert.equal(freshnessOf(undefined, undefined, 1440, now), 'unknown');
});
