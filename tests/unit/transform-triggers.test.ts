// #92 trigger helpers: upstream keys, event windows, the triggered window, cycle detection.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { upstreamKey, eventWindow, triggeredWindow, triggerCycle } =
  await import('../../packages/core/src/transformTriggers.js');

test('upstream keys and windows from completion events', () => {
  assert.equal(
    upstreamKey({ type: 'dataset.sync.completed', data: { collection: 'eod_prices' } }),
    'dataset:eod_prices',
  );
  assert.equal(
    upstreamKey({ type: 'dataset.backfill.completed', data: { collection: 'eod_prices' } }),
    'dataset:eod_prices',
  );
  assert.equal(
    upstreamKey({ type: 'transform.completed', data: { transform: 'prices_daily' } }),
    'transform:prices_daily',
  );
  assert.equal(upstreamKey({ type: 'dataset.sync.failed', data: { collection: 'x' } }), undefined);
  assert.deepEqual(eventWindow({ data: { date_from: '2026-01-01', date_to: '2026-01-05' } }), {
    date_from: '2026-01-01',
    date_to: '2026-01-05',
  });
  assert.deepEqual(eventWindow({ data: { window: { start: '2026-02-01', end: '2026-02-03' } } }), {
    date_from: '2026-02-01',
    date_to: '2026-02-03',
  });
  assert.deepEqual(eventWindow({ data: {} }), {});
});

test('the triggered window is the union of the upstream ranges; the last day when none say', () => {
  const at = new Date();
  assert.deepEqual(
    triggeredWindow([
      { at, eventId: 'a', date_from: '2026-01-03', date_to: '2026-01-09' },
      { at, eventId: 'b', date_from: '2026-01-01', date_to: '2026-01-05' },
    ]),
    { start: '2026-01-01', end: '2026-01-09' },
  );
  assert.deepEqual(triggeredWindow([{ at, eventId: 'a' }], '2026-11-04'), {
    start: '2026-11-04',
    end: '2026-11-04',
  });
  assert.deepEqual(
    triggeredWindow(
      [
        { at, eventId: 'a', date_to: '2026-03-01' },
        { at, eventId: 'b' },
      ],
      '2026-11-04',
    ),
    {
      start: '2026-03-01',
      end: '2026-03-01',
    },
  );
});

test('trigger cycles are found, including through other transforms', () => {
  const others = [
    { name: 'b', trigger: { after: ['transform:a'] } },
    { name: 'c', trigger: { after: ['transform:b', 'dataset:eod_prices'] } },
  ];
  assert.deepEqual(triggerCycle({ name: 'a', trigger: { after: ['transform:c'] } }, others), [
    'a',
    'c',
    'b',
    'a',
  ]);
  assert.equal(triggerCycle({ name: 'a', trigger: { after: ['dataset:eod_prices'] } }, others), undefined);
  assert.equal(triggerCycle({ name: 'd', trigger: { after: ['transform:c'] } }, others), undefined);
});
