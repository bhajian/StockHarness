// #76 next run times shown in the UI are the dispatcher's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRunTimes, nextScheduledAt } from '../../packages/core/src/schedule.js';

test('the next five daily runs, in the schedule timezone', () => {
  const s = { enabled: true, everyMinutes: 1440, at: '18:30', timezone: 'America/New_York', input: 'x' };
  const from = new Date('2026-11-04T12:00:00Z');
  const runs = nextRunTimes(s, 5, from);
  assert.equal(runs.length, 5);
  assert.equal(runs[0].toISOString(), nextScheduledAt(s, from).toISOString(), 'same as the dispatcher');
  assert.deepEqual(
    runs.map((d) => d.toISOString()),
    [
      '2026-11-04T23:30:00.000Z',
      '2026-11-05T23:30:00.000Z',
      '2026-11-06T23:30:00.000Z',
      '2026-11-07T23:30:00.000Z',
      '2026-11-08T23:30:00.000Z',
    ],
  );
  assert.deepEqual(nextRunTimes({ ...s, enabled: false }), []);
});
