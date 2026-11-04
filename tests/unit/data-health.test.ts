// #86 lag in expected sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { lagSessions } = await import('../../packages/core/src/dataHealth.js');

test('sessions after the latest date, ignoring today', () => {
  const expected = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04'];
  assert.equal(lagSessions(expected, '2026-11-03', '2026-11-04'), 0);
  assert.equal(lagSessions(expected, '2026-10-29', '2026-11-04'), 3);
  assert.equal(lagSessions(expected, undefined, '2026-11-04'), undefined);
});
