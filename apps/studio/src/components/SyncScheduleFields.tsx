// The sync Schedule section (#79): Off / Interval / Daily / Weekly / Event, the next 5 run times (computed like
// the dispatcher), and a warning when an end-of-day dataset is set to run intraday. Event mode sets the
// triggers (#82): after other syncs or transforms complete, and/or N days after each company's earnings.
import React, { useMemo } from 'react';
import { describeSchedule, nextRunTimes } from '../../../../packages/core/src/schedule.js';
import type { Schedule } from '../../../../packages/core/src/schema.js';
import { Field } from './ui';
import { StatusPill } from './kit';

export type SyncTrigger = { after: string[]; afterEarnings?: { days: number } };
export type ScheduleMode = 'off' | 'interval' | 'daily' | 'weekly' | 'event';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Feeds that may legitimately run more than once a day. */
const INTRADAY_OK = /news|quote|price.?target|grades|actives|gainers|insider|congress/i;

export function modeOf(schedule: Schedule | undefined, trigger: SyncTrigger | undefined): ScheduleMode {
  if (trigger && (trigger.after.length || trigger.afterEarnings)) return 'event';
  if (!schedule?.enabled) return 'off';
  if (schedule.everyMinutes < 1440) return 'interval';
  return schedule.everyMinutes >= 10080 && schedule.weekday !== undefined ? 'weekly' : 'daily';
}
/** A warning when an end-of-day dataset is scheduled intraday (it only changes once a day). */
export function cadenceWarning(
  dataset: { id: string; label: string; category: string } | undefined,
  schedule?: Schedule,
) {
  if (!dataset || !schedule?.enabled || schedule.everyMinutes >= 1440) return undefined;
  if (INTRADAY_OK.test(`${dataset.id} ${dataset.label} ${dataset.category}`)) return undefined;
  return `${dataset.label} updates once a day; running it every ${schedule.everyMinutes < 60 ? `${schedule.everyMinutes} minutes` : `${schedule.everyMinutes / 60} hours`} spends FMP calls for no new data.`;
}

export function SyncScheduleFields({
  schedule,
  trigger,
  onChange,
  dataset,
  upstreams,
}: {
  schedule: Schedule;
  trigger?: SyncTrigger;
  onChange: (schedule: Schedule, trigger?: SyncTrigger) => void;
  dataset?: { id: string; label: string; category: string };
  /** Choices for "after": dataset:<collection> of other syncs and transform:<name>. */
  upstreams: { value: string; label: string }[];
}) {
  const zone = schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const mode = modeOf(schedule, trigger);
  const set = (s: Partial<Schedule>, t: SyncTrigger | undefined = trigger) =>
    onChange({ ...schedule, ...s }, t);
  const choose = (m: ScheduleMode) => {
    if (m === 'off') return onChange({ ...schedule, enabled: false }, undefined);
    if (m === 'event')
      return onChange({ ...schedule, enabled: false }, trigger ?? { after: [], afterEarnings: { days: 2 } });
    if (m === 'interval')
      return onChange(
        {
          ...schedule,
          enabled: true,
          everyMinutes: schedule.everyMinutes < 1440 ? schedule.everyMinutes : 60,
          weekday: undefined,
        },
        undefined,
      );
    if (m === 'daily')
      return onChange(
        {
          ...schedule,
          enabled: true,
          everyMinutes: 1440,
          at: schedule.at ?? '18:30',
          timezone: zone,
          weekday: undefined,
        },
        undefined,
      );
    onChange(
      {
        ...schedule,
        enabled: true,
        everyMinutes: 10080,
        weekday: schedule.weekday ?? 6,
        at: schedule.at ?? '06:00',
        timezone: zone,
      },
      undefined,
    );
  };
  const upcoming = useMemo(
    () => (mode === 'event' || mode === 'off' ? [] : nextRunTimes(schedule)),
    [schedule, mode],
  );
  const warning = cadenceWarning(dataset, schedule);
  const hours = schedule.everyMinutes % 60 === 0 && schedule.everyMinutes >= 60;
  return (
    <div className="sync-schedule-fields">
      <div className="chart-presets" role="radiogroup" aria-label="Schedule mode">
        {(['off', 'interval', 'daily', 'weekly', 'event'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className={`chart-tool${mode === m ? ' active' : ''}`}
            onClick={() => choose(m)}
          >
            {m === 'off' ? 'Off' : m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>
      {mode === 'interval' && (
        <div className="two-columns">
          <Field label="Every">
            <input
              aria-label="Interval"
              type="number"
              min={1}
              value={hours ? schedule.everyMinutes / 60 : schedule.everyMinutes}
              onChange={(e) =>
                set({ everyMinutes: Math.max(1, Number(e.target.value) || 1) * (hours ? 60 : 1) })
              }
            />
          </Field>
          <Field label="Unit">
            <select
              aria-label="Interval unit"
              value={hours ? 'hours' : 'minutes'}
              onChange={(e) =>
                set({
                  everyMinutes:
                    e.target.value === 'hours'
                      ? Math.max(1, Math.round(schedule.everyMinutes / 60)) * 60
                      : Math.max(1, schedule.everyMinutes),
                })
              }
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
          </Field>
        </div>
      )}
      {(mode === 'daily' || mode === 'weekly') && (
        <div className="two-columns">
          {mode === 'weekly' && (
            <Field label="On">
              <select
                aria-label="Weekday"
                value={schedule.weekday ?? 6}
                onChange={(e) => set({ weekday: Number(e.target.value) })}
              >
                {DAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="At">
            <input
              aria-label="Time"
              type="time"
              value={schedule.at ?? '18:30'}
              onChange={(e) => set({ at: e.target.value || '18:30' })}
            />
          </Field>
          <Field label="Time zone">
            <select aria-label="Time zone" value={zone} onChange={(e) => set({ timezone: e.target.value })}>
              {[
                ...new Set([
                  zone,
                  'America/New_York',
                  'UTC',
                  Intl.DateTimeFormat().resolvedOptions().timeZone,
                ]),
              ]
                .filter(Boolean)
                .map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
            </select>
          </Field>
        </div>
      )}
      {mode === 'event' && (
        <div className="event-trigger">
          <Field
            label="After these complete"
            hint="The sync runs once all of them have completed since its last run"
          >
            <div className="after-list">
              {upstreams.length ? (
                upstreams.map((u) => (
                  <label key={u.value} className="check-row">
                    <input
                      type="checkbox"
                      checked={trigger?.after.includes(u.value) ?? false}
                      onChange={(e) => {
                        const after = new Set(trigger?.after ?? []);
                        if (e.target.checked) after.add(u.value);
                        else after.delete(u.value);
                        set({ enabled: false }, { ...(trigger ?? { after: [] }), after: [...after] });
                      }}
                    />
                    {u.label}
                  </label>
                ))
              ) : (
                <span className="muted-line">No other syncs or transforms yet.</span>
              )}
            </div>
          </Field>
          <label className="check-row">
            <input
              type="checkbox"
              checked={!!trigger?.afterEarnings}
              onChange={(e) =>
                set(
                  { enabled: false },
                  {
                    after: trigger?.after ?? [],
                    ...(e.target.checked
                      ? { afterEarnings: { days: trigger?.afterEarnings?.days ?? 2 } }
                      : {}),
                  },
                )
              }
            />
            After each company&apos;s earnings report
          </label>
          {trigger?.afterEarnings && (
            <Field
              label="Days after the report"
              hint="Pulls just the companies that reported that many days ago (earnings_calendar)"
            >
              <input
                aria-label="Days after earnings"
                type="number"
                min={0}
                max={60}
                value={trigger.afterEarnings.days}
                onChange={(e) =>
                  set(
                    { enabled: false },
                    {
                      ...trigger,
                      afterEarnings: { days: Math.max(0, Math.min(60, Number(e.target.value) || 0)) },
                    },
                  )
                }
              />
            </Field>
          )}
        </div>
      )}
      {warning && (
        <p className="schedule-warning">
          <StatusPill status="warn" label="cadence" /> {warning}
        </p>
      )}
      {mode !== 'off' && mode !== 'event' && (
        <div className="schedule-preview">
          <small>{describeSchedule(schedule)} · next runs</small>
          <ol className="next-runs" aria-label="Next runs">
            {upcoming.map((t) => (
              <li key={t.toISOString()}>{t.toLocaleString()}</li>
            ))}
          </ol>
        </div>
      )}
      {mode === 'off' && (
        <p className="muted-line">Runs only when started: Run now, a bulk run, a backfill or a pipeline.</p>
      )}
    </div>
  );
}
