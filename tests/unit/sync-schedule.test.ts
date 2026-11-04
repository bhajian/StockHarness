// #79 schedule modes: next run times across DST (they are the dispatcher's), mode inference, cadence warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRunTimes, nextScheduledAt } from '../../packages/core/src/schedule.js';
import { cadenceWarning, modeOf } from '../../apps/studio/src/components/SyncScheduleFields.js';

const NY = 'America/New_York';
test('daily runs keep their wall-clock time across the end of DST', () => {
  const s = { enabled: true, everyMinutes: 1440, at: '18:30', timezone: NY, input: 'x' };
  const runs = nextRunTimes(s, 4, new Date('2026-10-30T12:00:00Z')).map((d) => d.toISOString());
  // EDT (UTC−4) until Sunday 1 Nov 2026, then EST (UTC−5).
  assert.deepEqual(runs, [
    '2026-10-30T22:30:00.000Z',
    '2026-10-31T22:30:00.000Z',
    '2026-11-01T23:30:00.000Z',
    '2026-11-02T23:30:00.000Z',
  ]);
});

test('weekly runs and the start of DST; the preview equals the dispatcher', () => {
  const w = { enabled: true, everyMinutes: 10080, weekday: 6, at: '06:00', timezone: NY, input: 'x' };
  const from = new Date('2027-03-01T00:00:00Z');
  const runs = nextRunTimes(w, 3, from);
  assert.deepEqual(
    runs.map((d) => d.toISOString()),
    ['2027-03-06T11:00:00.000Z', '2027-03-13T11:00:00.000Z', '2027-03-20T10:00:00.000Z'],
  );
  assert.equal(runs[0].getTime(), nextScheduledAt(w, from).getTime());
  // 02:30 does not exist on 14 Mar 2027 (clocks jump 02:00 -> 03:00): the run still happens that morning.
  const d = { enabled: true, everyMinutes: 1440, at: '02:30', timezone: NY, input: 'x' };
  const [spring, next] = nextRunTimes(d, 2, new Date('2027-03-14T05:00:00Z'));
  assert.equal(spring.toISOString().slice(0, 10), '2027-03-14');
  assert.equal(next.toISOString(), '2027-03-15T06:30:00.000Z');
});

test('modes and the cadence warning', () => {
  const daily = { enabled: true, everyMinutes: 1440, at: '18:30', input: 'x' };
  assert.equal(modeOf(daily, undefined), 'daily');
  assert.equal(modeOf({ ...daily, everyMinutes: 10080, weekday: 6 }, undefined), 'weekly');
  assert.equal(modeOf({ ...daily, everyMinutes: 60 }, undefined), 'interval');
  assert.equal(modeOf({ ...daily, enabled: false }, undefined), 'off');
  assert.equal(modeOf({ ...daily, enabled: false }, { after: ['dataset:eod_prices'] }), 'event');
  const eod = { id: 'eod_prices', label: 'EOD prices', category: 'Prices' };
  assert.match(
    cadenceWarning(eod, { ...daily, everyMinutes: 60 })!,
    /updates once a day; running it every 1 hours/,
  );
  assert.equal(cadenceWarning(eod, daily), undefined);
  assert.equal(
    cadenceWarning(
      { id: 'news_stocks', label: 'Stock news', category: 'News' },
      { ...daily, everyMinutes: 60 },
    ),
    undefined,
    'news may run hourly',
  );
});
