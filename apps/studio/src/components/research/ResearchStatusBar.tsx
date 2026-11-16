// The one research status and control (#458): the Research Lab and Setup show the same state, reason and buttons.
// Start turns the schedule on (and installs the loop); Pause lets the running step finish, then stops; Stop also
// cancels the running cycle; Resume clears a spend-cap stop when the spend is under the cap again.
import React, { useState } from 'react';
import { CirclePause, CirclePlay, CircleStop, Play } from 'lucide-react';
import { send } from '../../api';
import { StatusPill } from '../kit';
import { go } from '../ideas/nav';

export type ResearchStateView = {
  state: string;
  label: string;
  detail: string;
  tone: string;
  nextCycleAt?: string;
  run?: { id: string; status: string; startedAt: string; cancelRequested: boolean };
  holds: string[];
  notes?: string[];
  actions: ('start' | 'pause' | 'resume' | 'stop' | 'run_now')[];
};

const LABELS = { start: 'Start', pause: 'Pause', resume: 'Resume', stop: 'Stop', run_now: 'Run a cycle now' };
const ICONS = { start: CirclePlay, pause: CirclePause, resume: Play, stop: CircleStop, run_now: Play };
const TITLES = {
  start: 'Turn the schedule on (installs the loop the first time)',
  pause: 'No new cycles; a running cycle finishes the step it is on, then stops',
  resume: 'Cycles run on the schedule again',
  stop: 'Pause and cancel the cycle running now',
  run_now: 'Run one cycle now, whatever the schedule',
};

/** Default Start: the schedule on (an ended one without its end date), the loop installed, a pause lifted. */
export async function startResearch(status: any, settings?: any) {
  const s = settings ?? (await send('/research/settings', undefined, 'GET'));
  const { until, ...schedule } = s.schedule ?? { everyMinutes: 60 };
  const ended = until && Date.parse(until) <= Date.now();
  if (!status.harness) await send('/research/loop', {});
  await send(
    '/research/settings',
    {
      schedule: {
        ...schedule,
        everyMinutes: schedule.everyMinutes ?? 60,
        enabled: true,
        ...(ended || !until ? {} : { until }),
      },
    },
    'PUT',
  );
  if (status.paused) await send('/research/resume', {});
  return 'Started: cycles run on the schedule.';
}

export function ResearchStatusBar({
  status,
  isAdmin,
  onChanged,
  onStart,
  compact,
}: {
  status: any;
  isAdmin: boolean;
  onChanged: () => void;
  /** Setup's Start also saves the edited settings. */
  onStart?: () => Promise<string>;
  compact?: boolean;
}) {
  const st: ResearchStateView | undefined = status.state;
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  if (!st) return null;
  const act = async (a: ResearchStateView['actions'][number]) => {
    if (a === 'stop' && !window.confirm('Stop: pause the loop and cancel the cycle running now?')) return;
    setBusy(a);
    setMsg('');
    try {
      if (a === 'start') setMsg(await (onStart ?? (() => startResearch(status)))());
      else if (a === 'pause') (await send('/research/pause', {}), setMsg('Paused.'));
      else if (a === 'resume') (await send('/research/resume', {}), setMsg('Resumed.'));
      else if (a === 'stop') (await send('/research/stop', {}), setMsg('Stopped.'));
      else if (a === 'run_now') (await send('/research/run-now', {}), setMsg('A cycle started.'));
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    } finally {
      setBusy('');
      onChanged();
    }
  };
  return (
    <section
      className={`research-status${compact ? ' compact' : ''}`}
      aria-label="Research status"
      aria-live="polite"
    >
      <div className="research-status-main">
        <StatusPill status={st.tone} label={st.label} />
        <span className="research-status-detail">{st.detail}</span>
        {st.run && (
          <button type="button" className="link-button" onClick={() => go(`/research/cycles/${st.run!.id}`)}>
            Open the cycle
          </button>
        )}
      </div>
      {st.holds.map((h) => (
        <span key={h} className="research-status-hold">
          <StatusPill status="warn" label="new ideas held" /> {h}
        </span>
      ))}
      {(st.notes ?? []).map((n) => (
        <span key={n} className="research-status-hold muted-line">
          {n}
        </span>
      ))}
      {isAdmin && (
        <div className="research-status-actions">
          {st.actions.map((a) => {
            const Icon = ICONS[a];
            return (
              <button
                key={a}
                type="button"
                className={`button ${a === 'start' || a === 'resume' ? 'primary' : a === 'stop' ? 'danger' : 'secondary'} small`}
                title={TITLES[a]}
                disabled={!!busy}
                onClick={() => void act(a)}
              >
                <Icon size={14} /> {busy === a ? '…' : LABELS[a]}
              </button>
            );
          })}
          {msg && <span className="muted-line">{msg}</span>}
        </div>
      )}
    </section>
  );
}
