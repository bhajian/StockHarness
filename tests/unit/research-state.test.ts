// #458: one research status from the settings, the harness, the running cycle, the spend cap and the backlog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleOutcome, harnessScheduleOf, researchState } from '../../packages/core/src/researchState.js';

const now = new Date('2026-11-15T12:00:00Z');
const schedule = { enabled: true, everyMinutes: 60 };
const base = { installed: true, paused: false, schedule, now };
const run = { id: 'r1', status: 'running', startedAt: '2026-11-15T11:50:00Z' };

test('not installed → Start only', () => {
  const s = researchState({ ...base, installed: false });
  assert.equal(s.state, 'not_installed');
  assert.deepEqual(s.actions, ['start']);
});

test('idle on a schedule shows the next cycle', () => {
  const s = researchState({ ...base, nextRunAt: '2026-11-15T12:30:00Z' });
  assert.equal(s.state, 'idle');
  assert.equal(s.nextCycleAt, '2026-11-15T12:30:00.000Z');
  assert.match(s.detail, /12:30 UTC.*every 60 min/);
  assert.deepEqual(s.actions, ['pause', 'run_now']);
});

test('a running cycle wins over idle; Pause while running is "pausing", Stop while cancelling is "stopping"', () => {
  assert.equal(researchState({ ...base, activeRun: run }).state, 'running');
  assert.deepEqual(researchState({ ...base, activeRun: run }).actions, ['pause', 'stop']);
  const pausing = researchState({ ...base, paused: true, activeRun: run });
  assert.equal(pausing.state, 'pausing');
  assert.deepEqual(pausing.actions, ['resume', 'stop']);
  assert.equal(
    researchState({ ...base, paused: true, activeRun: { ...run, cancelRequested: true } }).state,
    'stopping',
  );
});

test('paused by you vs paused by the spend cap', () => {
  assert.equal(researchState({ ...base, paused: true }).state, 'paused');
  const cap = researchState({
    ...base,
    paused: true,
    stoppedAt: '2026-11-15T10:00:00Z',
    stopReason: 'today’s spend $5.01 reached the daily cap of $5.00',
  });
  assert.equal(cap.state, 'paused_spend_cap');
  assert.match(cap.detail, /daily cap of \$5\.00.*resumes by itself.*raise the cap/);
  assert.equal(cap.tone, 'blocked');
  // Over the cap but not yet paused: the next cycle stops at its first call.
  assert.equal(researchState({ ...base, capExceeded: 'over' }).state, 'paused_spend_cap');
});

test('an ended schedule and no schedule are told apart', () => {
  assert.equal(
    researchState({ ...base, schedule: { ...schedule, until: '2026-11-15T11:00:00Z' } }).state,
    'ended',
  );
  assert.equal(
    researchState({ ...base, schedule: { ...schedule, until: '2026-11-16T11:00:00Z' } }).state,
    'idle',
  );
  assert.equal(researchState({ ...base, schedule: { ...schedule, enabled: false } }).state, 'not_scheduled');
  assert.equal(researchState({ ...base, schedule: undefined }).state, 'not_scheduled');
});

test('a full Coder backlog is a hold, not a state', () => {
  const s = researchState({ ...base, backlog: { size: 12, limit: 10 } });
  assert.equal(s.state, 'idle');
  assert.equal(s.holds.length, 1);
  assert.match(s.holds[0], /12 ideas to code \(limit 10\)/);
  assert.equal(researchState({ ...base, backlog: { size: 3, limit: 10 } }).holds.length, 0);
});

test('the harness schedule is derived from the settings: off when paused, disabled or ended; none without one', () => {
  assert.equal(harnessScheduleOf({ schedule }, now)?.enabled, true);
  assert.equal(harnessScheduleOf({ schedule, paused: true }, now)?.enabled, false);
  assert.equal(harnessScheduleOf({ schedule: { ...schedule, enabled: false } }, now)?.enabled, false);
  assert.equal(
    harnessScheduleOf({ schedule: { ...schedule, until: '2026-11-15T11:00:00Z' } }, now)?.enabled,
    false,
  );
  assert.equal(harnessScheduleOf({}, now), undefined);
});

test('a cycle that ran while paused is labelled paused, not succeeded', () => {
  assert.equal(cycleOutcome('succeeded', ['paused']), 'paused');
  assert.equal(cycleOutcome('succeeded', ['backlog_full']), 'held: backlog');
  assert.equal(cycleOutcome('succeeded', []), 'succeeded');
  assert.equal(cycleOutcome('failed', ['paused']), 'failed');
});

test('#365: a daily-cap stop says it lifts by itself; an auto-resume leaves a note for a day', () => {
  const paused = researchState({
    ...base,
    paused: true,
    stoppedAt: '2026-11-15T21:00:00Z',
    stopReason: "today's spend $5.10 reached the daily cap of $5.00",
    stopKind: 'daily',
  });
  assert.equal(paused.state, 'paused_spend_cap');
  assert.match(paused.detail, /resumes by itself after 00:00 UTC/);
  const total = researchState({
    ...base,
    paused: true,
    stoppedAt: '2026-11-15T21:00:00Z',
    stopReason: 'x',
    stopKind: 'total',
  });
  assert.match(total.detail, /Raise the cap in Setup, then Resume/);
  const resumed = researchState({
    ...base,
    autoResumedAt: '2026-11-16T00:01:00Z',
    now: new Date('2026-11-16T08:00:00Z'),
  });
  assert.match(resumed.notes.join(' '), /Resumed by itself/);
  const old = researchState({
    ...base,
    autoResumedAt: '2026-11-14T00:01:00Z',
    now: new Date('2026-11-16T08:00:00Z'),
  });
  assert.deepEqual(old.notes, []);
});
