// One research status (#458): whether the loop is running, idle, paused (by you or by the spend cap), stopped or
// not scheduled, with the reason, the next cycle and what holds new ideas back. Pure, so it is unit-tested; the
// Research Lab and Setup show the same value. Also the workflow schedule the settings imply: the settings are the one
// source of truth, the harness's schedule is derived from them.

export type ResearchStateKey =
  | 'not_installed'
  | 'running'
  | 'pausing'
  | 'stopping'
  | 'paused'
  | 'paused_spend_cap'
  | 'ended'
  | 'not_scheduled'
  | 'idle';

export type ResearchStateInput = {
  installed: boolean;
  paused: boolean;
  schedule?: { enabled: boolean; everyMinutes: number; until?: string };
  /** The harness's next scheduled cycle (workflow.nextRunAt). */
  nextRunAt?: Date | string | null;
  /** The research cycle queued or running now. */
  activeRun?: { id: string; status: string; startedAt: Date | string; cancelRequested?: boolean } | null;
  /** The spend cap stop the guard recorded. */
  stoppedAt?: Date | string;
  stopReason?: string;
  /** #365: a daily cap's stop lifts by itself at the next UTC day. */
  stopKind?: 'daily' | 'total';
  /** #365: when a daily-cap pause last lifted by itself. */
  autoResumedAt?: Date | string;
  /** An overall cap reached now (the guard pauses the loop at the next model call). */
  capExceeded?: string;
  backlog?: { size: number; limit: number };
  now?: Date;
};

export type ResearchState = {
  state: ResearchStateKey;
  /** Short label for the status pill. */
  label: string;
  /** One sentence: why, and what happens next. */
  detail: string;
  /** The pill's tone (a StatusPill status). */
  tone: 'running' | 'paused' | 'blocked' | 'succeeded' | 'disabled' | 'warn';
  nextCycleAt?: string;
  run?: { id: string; status: string; startedAt: string; cancelRequested: boolean };
  /** Running, but new ideas wait (the Coder's backlog is full). */
  holds: string[];
  /** #365: things the loop did by itself lately (a daily-cap pause that lifted). */
  notes: string[];
  /** The controls that make sense now. */
  actions: ('start' | 'pause' | 'resume' | 'stop' | 'run_now')[];
};

const iso = (d?: Date | string | null) => (d ? new Date(d).toISOString() : undefined);
const when = (d: string) => new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export function researchState(i: ResearchStateInput): ResearchState {
  const now = i.now ?? new Date();
  const holds =
    i.backlog && i.backlog.size >= i.backlog.limit
      ? [
          `New ideas wait: the Coder has ${i.backlog.size} ideas to code (limit ${i.backlog.limit}). Revisions, coding and verdicts go on.`,
        ]
      : [];
  const run = i.activeRun
    ? {
        id: i.activeRun.id,
        status: i.activeRun.status,
        startedAt: iso(i.activeRun.startedAt)!,
        cancelRequested: !!i.activeRun.cancelRequested,
      }
    : undefined;
  const ended = !!i.schedule?.until && Date.parse(i.schedule.until) <= now.getTime();
  const scheduled = !!i.schedule?.enabled && !ended;
  const next = scheduled && !i.paused ? iso(i.nextRunAt) : undefined;
  const notes =
    i.autoResumedAt && now.getTime() - new Date(i.autoResumedAt).getTime() < 24 * 3600_000
      ? [`Resumed by itself on ${when(iso(i.autoResumedAt)!)}: a new UTC day began under the daily cap.`]
      : [];
  const base = { holds, notes, ...(run ? { run } : {}), ...(next ? { nextCycleAt: next } : {}) };
  if (!i.installed)
    return {
      ...base,
      state: 'not_installed',
      label: 'not set up',
      detail: 'The research loop is not installed yet: Start installs it and runs cycles on the schedule.',
      tone: 'disabled',
      actions: ['start'],
    };
  if (run) {
    const started = `started ${when(run.startedAt)}`;
    if (run.cancelRequested)
      return {
        ...base,
        state: 'stopping',
        label: 'stopping',
        detail: `The cycle (${started}) is being cancelled; it stops at its next step.`,
        tone: 'paused',
        actions: i.paused ? ['resume'] : ['pause'],
      };
    if (i.paused)
      return {
        ...base,
        state: 'pausing',
        label: 'pausing',
        detail: `Paused: the running cycle (${started}) finishes the step it is on, then its agents stop. No new cycles. Stop cancels it now.`,
        tone: 'paused',
        actions: ['resume', 'stop'],
      };
    return {
      ...base,
      state: 'running',
      label: run.status === 'queued' ? 'starting' : 'running',
      detail: `A cycle is ${run.status === 'queued' ? 'queued' : 'running'} (${started}).${scheduled ? '' : ' No schedule: this is a one-off cycle.'}`,
      tone: 'running',
      actions: ['pause', 'stop'],
    };
  }
  if (i.paused && (i.stoppedAt || i.capExceeded))
    return {
      ...base,
      state: 'paused_spend_cap',
      label: 'paused: spend cap',
      detail:
        `The loop paused itself${i.stoppedAt ? ` on ${when(iso(i.stoppedAt)!)}` : ''}: ${i.stopReason ?? i.capExceeded}. ` +
        ((i.stopKind ?? (i.stopReason && /daily cap/.test(i.stopReason) ? 'daily' : 'total')) === 'daily' &&
        i.stoppedAt
          ? 'It resumes by itself after 00:00 UTC if no cap is reached then; or raise the cap in Setup and Resume now.'
          : 'Raise the cap in Setup, then Resume.'),
      tone: 'blocked',
      actions: ['resume'],
    };
  if (i.paused)
    return {
      ...base,
      state: 'paused',
      label: 'paused',
      detail: 'Paused by you: no cycles run until you Resume.',
      tone: 'paused',
      actions: ['resume'],
    };
  if (i.capExceeded)
    return {
      ...base,
      state: 'paused_spend_cap',
      label: 'spend cap reached',
      detail: `${i.capExceeded}: the next cycle stops at its first model call. Raise the cap in Setup.`,
      tone: 'blocked',
      actions: ['pause'],
    };
  if (ended)
    return {
      ...base,
      state: 'ended',
      label: 'schedule ended',
      detail: `The schedule ran until ${when(i.schedule!.until!)} and stopped. Start runs it again (without the end date).`,
      tone: 'disabled',
      actions: ['start', 'run_now'],
    };
  if (!scheduled)
    return {
      ...base,
      state: 'not_scheduled',
      label: 'not scheduled',
      detail: 'No schedule: cycles run only when you click Run a cycle now. Start turns the schedule on.',
      tone: 'disabled',
      actions: ['start', 'run_now'],
    };
  return {
    ...base,
    state: 'idle',
    label: 'idle',
    detail: `Waiting for the next cycle${next ? ` at ${when(next)}` : ' (due now)'}; a cycle every ${i.schedule!.everyMinutes} min${i.schedule!.until ? ` until ${when(i.schedule!.until)}` : ''}.`,
    tone: 'succeeded',
    actions: ['pause', 'run_now'],
  };
}

/** The harness schedule the settings imply: on only when enabled, not paused and not past its end. */
export function harnessScheduleOf(
  s: { paused?: boolean; schedule?: { enabled: boolean; everyMinutes: number; until?: string } },
  now = new Date(),
) {
  if (!s.schedule) return undefined;
  const ended = !!s.schedule.until && Date.parse(s.schedule.until) <= now.getTime();
  return {
    enabled: !!s.schedule.enabled && !s.paused && !ended,
    everyMinutes: s.schedule.everyMinutes,
    input: 'Scheduled research cycle',
    ...(s.schedule.until ? { until: s.schedule.until } : {}),
  };
}

/** The label a cycle shows: its run status, or why a finished one did little. */
export function cycleOutcome(status: string, notes: string[] = []) {
  if (status !== 'succeeded') return status;
  if (notes.includes('paused')) return 'paused';
  if (notes.includes('backlog_full')) return 'held: backlog';
  return status;
}
