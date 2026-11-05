// Research Lab (#116): the research loop at a glance. KPIs, the pipeline board, the live activity feed (SSE), charts,
// the settings drawer (models and skills per role, focus, gates versions, budget alerts, schedule) and human steering.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  CircleDollarSign,
  FlaskConical,
  Gauge,
  Pause,
  Play,
  Settings2,
  Sigma,
  Sparkles,
} from 'lucide-react';
import { api, send, type Data } from '../api';
import { Button, Field } from './ui';
import { Drawer, KpiCard, Skeleton, StatusPill, Timeline } from './kit';
import { BarChart, TimeSeriesChart } from '../charts/Charts';
import { ObjectTransfer } from './ObjectTransfer';

type Card = {
  id: string;
  ref: string;
  title: string;
  status: string;
  family: string;
  revisions: number;
  codeAttempts: number;
  trials: number;
  forwardOnly?: boolean;
};
type Status = {
  paused: boolean;
  harness: { id: string; name: string; schedule: { enabled: boolean; everyMinutes: number } | null } | null;
  lastRun: { id: string; status: string; startedAt: string } | null;
  kpis: {
    theoriesToday: number;
    inFlight: number;
    successRate: number | null;
    decided: number;
    trials: number;
    tokensToday: number;
    costToday?: number;
  };
  budgetAlert: string | null;
  tokensByRole: Record<string, { input: number; output: number; calls: number }>;
  board: { columns: { key: string; label: string; cards: Card[] }[]; verdictsToday: Card[] };
};
type Item = {
  at: string;
  theory: string;
  theoryId: string;
  title: string;
  type: string;
  from?: string;
  to?: string;
  role: string;
  model?: string;
  reasoning: string;
};
const ROLES = ['theorist', 'judge', 'coder'] as const;
const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`;

export function ResearchPage({ data, isAdmin }: { data: Data; isAdmin: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [charts, setCharts] = useState<any>(null);
  const [feed, setFeed] = useState<Item[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api<Status>('/research/status'), api('/research/charts?days=30')]);
      setStatus(s);
      setCharts(c);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    // The live activity feed: the theories' debate as it happens.
    const since = new Date(Date.now() - 3 * 86400_000).toISOString();
    const es = new EventSource(`/api/research/activity?since=${encodeURIComponent(since)}`);
    es.addEventListener('activity', (e) => {
      const item = JSON.parse((e as MessageEvent).data) as Item;
      setFeed((f) => [item, ...f].slice(0, 200));
    });
    return () => es.close();
  }, []);
  const tokenChart = useMemo(() => {
    const t = charts?.tokensByRole ?? {};
    const roles = Object.keys(t);
    return {
      categories: roles,
      series: { input: roles.map((r) => t[r].input), output: roles.map((r) => t[r].output) },
    };
  }, [charts]);
  if (error) return <p className="error-line">{error}</p>;
  if (!status) return <Skeleton rows={8} />;
  const k = status.kpis;
  return (
    <section className="page-section research-page">
      <div className="section-heading">
        <h2>Research</h2>
        <StatusPill
          status={status.paused ? 'paused' : (status.lastRun?.status ?? 'idle')}
          label={
            status.paused ? 'paused' : status.lastRun ? `last cycle ${status.lastRun.status}` : 'no cycle yet'
          }
        />
        {status.harness?.schedule?.enabled && (
          <span className="muted-line">every {status.harness.schedule.everyMinutes} min</span>
        )}
        <span className="spacer" />
        {isAdmin && (
          <>
            <Button
              onClick={() => void send(status.paused ? '/research/resume' : '/research/pause').then(load)}
            >
              {status.paused ? <Play size={14} /> : <Pause size={14} />} {status.paused ? 'Resume' : 'Pause'}
            </Button>
            <Button onClick={() => setSettingsOpen(true)}>
              <Settings2 size={14} /> Settings
            </Button>
          </>
        )}
      </div>
      {!status.harness && (
        <p className="notice">
          No research loop yet. Open Settings and install it (the role connections and seed skills are created
          for you).
        </p>
      )}
      {status.budgetAlert && (
        <p className="schedule-warning" role="alert">
          <StatusPill status="warn" label="budget" /> {status.budgetAlert}
        </p>
      )}
      <div className="kpi-row" aria-label="Research KPIs">
        <KpiCard icon={<Sparkles size={18} />} label="Theories today" value={k.theoriesToday} />
        <KpiCard icon={<FlaskConical size={18} />} label="In flight" value={k.inFlight} />
        <KpiCard
          icon={<Gauge size={18} />}
          label="Successful"
          value={pct(k.successRate)}
          footnote={`of ${k.decided} verdicts`}
        />
        <KpiCard
          icon={<Sigma size={18} />}
          label="Total trials"
          value={k.trials}
          footnote="every evaluation counts"
        />
        <KpiCard
          icon={<CircleDollarSign size={18} />}
          label="Tokens today"
          value={k.tokensToday.toLocaleString()}
          footnote={k.costToday !== undefined ? `≈ $${k.costToday.toFixed(2)}` : 'set a $ rate in settings'}
        />
      </div>
      <div className="research-board" aria-label="Pipeline board">
        {[
          ...status.board.columns,
          { key: 'verdicts', label: "Today's verdicts", cards: status.board.verdictsToday },
        ].map((col) => (
          <div key={col.key} className="board-column" aria-label={col.label}>
            <h3>
              {col.label} <small>{col.cards.length}</small>
            </h3>
            {col.cards.map((c) => (
              <button key={c.id} type="button" className="board-card" onClick={() => setOpen(c.id)}>
                <strong>
                  {c.ref} {c.title}
                </strong>
                <span>
                  <StatusPill status={c.status} /> {c.family}
                  {c.forwardOnly ? ' · forward only' : ''}
                </span>
                <small>
                  {c.revisions} rev · {c.codeAttempts} code retries · {c.trials} trials
                </small>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="eval-grid">
        <div className="activity-feed" aria-label="Live activity">
          <h3>
            <Activity size={14} /> Live activity
          </h3>
          {!feed.length && <p className="muted-line">Nothing yet in the last three days.</p>}
          <ol>
            {feed.map((f, i) => (
              <li key={`${f.at}-${i}`}>
                <time>{new Date(f.at).toLocaleTimeString()}</time>{' '}
                <button type="button" className="link-button" onClick={() => setOpen(f.theoryId)}>
                  {f.theory}
                </button>{' '}
                <strong>{f.role}</strong> {f.type === 'transition' ? `${f.from} → ${f.to}` : f.type}
                {f.model ? <small> · {f.model}</small> : null}
                {f.reasoning && <p>{f.reasoning}</p>}
              </li>
            ))}
          </ol>
        </div>
        <div className="steering-box">
          <h3>Steer the Theorists</h3>
          <p className="muted-line">The next cycle's Theorists read the latest notes in their brief.</p>
          <textarea
            aria-label="Steering note"
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Focus on quality and low-volatility ideas; avoid pure momentum this week."
          />
          <Button
            disabled={!isAdmin || note.trim().length < 3}
            onClick={() =>
              void send('/research/steering', { note }).then(() => {
                setNote('');
                void load();
              })
            }
          >
            Send to the Theorists
          </Button>
        </div>
      </div>
      {charts && (
        <div className="eval-grid">
          <BarChart
            title="Verdicts per day"
            categories={charts.verdicts.dates}
            series={charts.verdicts.series}
            height={220}
          />
          <TimeSeriesChart
            title="Success rate"
            data={charts.successRate}
            presets={false}
            logToggle={false}
            height={220}
          />
          <TimeSeriesChart
            title="Cumulative trials"
            data={charts.trials}
            presets={false}
            logToggle={false}
            height={220}
          />
          <BarChart
            title="Tokens by role (30 days)"
            categories={tokenChart.categories}
            series={tokenChart.series}
            height={220}
          />
        </div>
      )}
      {open && <TheoryDrawer id={open} onClose={() => setOpen(null)} />}
      {settingsOpen && (
        <SettingsDrawer
          data={data}
          onClose={() => setSettingsOpen(false)}
          onSaved={load}
          hasHarness={!!status.harness}
        />
      )}
    </section>
  );
}

function TheoryDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [t, setT] = useState<any>(null);
  useEffect(() => {
    void api(`/theories/${id}`).then(setT);
  }, [id]);
  return (
    <Drawer title={t ? `${t.ref} ${t.title}` : 'Theory'} onClose={onClose}>
      {!t ? (
        <Skeleton rows={6} />
      ) : (
        <div className="theory-detail">
          <p>
            <StatusPill status={t.status} /> {t.family} · {t.direction} · {t.horizonDays} days · {t.trials}{' '}
            trials
            {t.forwardOnly ? ' · forward only' : ''}
          </p>
          <h4>Hypothesis</h4>
          <p>{t.hypothesis}</p>
          <h4>Signal</h4>
          <p>{t.signalLogic}</p>
          <h4>Falsified if</h4>
          <p>{t.falsification}</p>
          {t.plugin && (
            <p className="muted-line">
              Plugin {t.plugin.name} · versions {t.plugin.versions.join(', ')}
            </p>
          )}
          {t.evaluationIds.length > 0 && (
            <p>
              Evaluations:{' '}
              {t.evaluationIds.map((e: string) => (
                <a key={e} href={`/evaluations/${e}`}>
                  {e.slice(0, 8)}{' '}
                </a>
              ))}
              {t.holdoutEvaluationId && (
                <>
                  · holdout{' '}
                  <a href={`/evaluations/${t.holdoutEvaluationId}`}>{t.holdoutEvaluationId.slice(0, 8)}</a>
                </>
              )}
            </p>
          )}
          <h4>Debate</h4>
          <Timeline
            events={[...t.history].reverse().map((h: any, i: number) => ({
              id: String(i),
              at: h.at,
              role: h.actor.role,
              title:
                h.type === 'transition'
                  ? `${h.actor.role}: ${h.from} → ${h.to}`
                  : `${h.actor.role}: ${h.type}`,
              status: h.to,
              body: (
                <>
                  {h.reasoning && <p>{h.reasoning}</p>}
                  {h.actor.model && <small className="muted-line">{h.actor.model}</small>}
                </>
              ),
            }))}
          />
        </div>
      )}
    </Drawer>
  );
}

function SettingsDrawer({
  data,
  onClose,
  onSaved,
  hasHarness,
}: {
  data: Data;
  onClose: () => void;
  onSaved: () => Promise<void>;
  hasHarness: boolean;
}) {
  const [s, setS] = useState<any>(null);
  const [gates, setGates] = useState<any>(null);
  const [draftGates, setDraftGates] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState('');
  useEffect(() => {
    void api('/research/settings').then(setS);
    void api('/research/gates').then(setGates);
  }, []);
  if (!s || !gates)
    return (
      <Drawer title="Research settings" onClose={onClose}>
        <Skeleton rows={6} />
      </Drawer>
    );
  const llms = data.providers.filter((p: any) => p.modelType !== 'embedding');
  const active = gates.versions.find((v: any) => v.version === gates.active);
  const setAgent = (role: string, providerId: string) =>
    setS({ ...s, agents: { ...s.agents, [role]: { ...(s.agents?.[role] ?? {}), providerId } } });
  const save = async () => {
    const { steering, paused, ...rest } = s;
    if (!hasHarness) await send('/research/loop', {});
    await send('/research/settings', rest, 'PUT');
    if (Object.keys(draftGates).length) {
      const v = await send('/research/gates', { ...draftGates, note: 'Edited in the Research Lab' });
      setMsg(`Saved. Gates v${v.version} is now active; verdicts under v${gates.active} stay as they were.`);
    } else setMsg('Saved.');
    await onSaved();
  };
  return (
    <Drawer title="Research settings" onClose={onClose}>
      <div className="research-settings">
        <h4>Agents</h4>
        {ROLES.map((role) => (
          <Field key={role} label={`${role[0].toUpperCase()}${role.slice(1)} model`}>
            <select
              aria-label={`${role} model`}
              value={s.agents?.[role]?.providerId ?? ''}
              onChange={(e) => setAgent(role, e.target.value)}
            >
              <option value="">Default (first chat model)</option>
              {llms.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model}
                </option>
              ))}
            </select>
          </Field>
        ))}
        <p className="muted-line">
          Skills per role default to the seed skills. Agents have no temperature setting here.
        </p>
        <Field label="Focus">
          <textarea
            aria-label="Research focus"
            rows={3}
            value={s.focus}
            onChange={(e) => setS({ ...s, focus: e.target.value })}
          />
        </Field>
        <div className="two-columns">
          <Field label="Theorists per cycle">
            <input
              aria-label="Theorists per cycle"
              type="number"
              min={1}
              max={8}
              value={s.theoristsPerCycle}
              onChange={(e) => setS({ ...s, theoristsPerCycle: Number(e.target.value) })}
            />
          </Field>
          <Field label="Evaluation years (before the holdout)">
            <input
              aria-label="Evaluation years"
              type="number"
              min={1}
              max={15}
              value={s.evaluationYears}
              onChange={(e) => setS({ ...s, evaluationYears: Number(e.target.value) })}
            />
          </Field>
        </div>
        <Field label={`Evaluation symbols (${s.evaluationSymbols.length})`}>
          <textarea
            aria-label="Evaluation symbols"
            rows={3}
            value={s.evaluationSymbols.join(' ')}
            onChange={(e) =>
              setS({ ...s, evaluationSymbols: e.target.value.split(/[\s,]+/).filter(Boolean) })
            }
          />
        </Field>
        <h4>Schedule</h4>
        <div className="two-columns">
          <label className="check-row">
            <input
              type="checkbox"
              checked={!!s.schedule?.enabled}
              onChange={(e) =>
                setS({
                  ...s,
                  schedule: { everyMinutes: s.schedule?.everyMinutes ?? 120, enabled: e.target.checked },
                })
              }
            />
            Run a cycle on a schedule
          </label>
          <Field label="Every (minutes)">
            <input
              aria-label="Cycle minutes"
              type="number"
              min={10}
              value={s.schedule?.everyMinutes ?? 120}
              onChange={(e) =>
                setS({
                  ...s,
                  schedule: { enabled: !!s.schedule?.enabled, everyMinutes: Number(e.target.value) },
                })
              }
            />
          </Field>
        </div>
        <h4>Budget (alerts only)</h4>
        <div className="two-columns">
          <Field label="Daily token alert">
            <input
              aria-label="Daily token alert"
              type="number"
              min={0}
              value={s.budget?.dailyTokenAlert ?? ''}
              onChange={(e) =>
                setS({
                  ...s,
                  budget: {
                    ...s.budget,
                    dailyTokenAlert: e.target.value ? Number(e.target.value) : undefined,
                  },
                })
              }
            />
          </Field>
          <Field label="$ per million tokens">
            <input
              aria-label="Dollars per million tokens"
              type="number"
              min={0}
              step="0.01"
              value={s.budget?.usdPerMillionTokens ?? ''}
              onChange={(e) =>
                setS({
                  ...s,
                  budget: {
                    ...s.budget,
                    usdPerMillionTokens: e.target.value ? Number(e.target.value) : undefined,
                  },
                })
              }
            />
          </Field>
        </div>
        <h4>
          Gates v{gates.active} {active?.lockedAt ? <StatusPill status="locked" label="locked" /> : null}
        </h4>
        <p className="schedule-warning">
          <StatusPill status="warn" label="new version" /> Changing a threshold creates gates v
          {Math.max(...gates.versions.map((v: any) => v.version)) + 1}. Verdicts under different versions are
          not comparable.
        </p>
        <div className="two-columns">
          {Object.entries(active?.gates ?? {})
            .filter(([, v]) => typeof v === 'number')
            .map(([key, v]) => (
              <Field key={key} label={key}>
                <input
                  aria-label={`Gate ${key}`}
                  type="number"
                  step="0.01"
                  defaultValue={v as number}
                  onChange={(e) => setDraftGates({ ...draftGates, [key]: Number(e.target.value) })}
                />
              </Field>
            ))}
        </div>
        <div className="compact-actions">
          <Button onClick={() => void save().catch((e) => setMsg(e?.message ?? String(e)))}>
            {hasHarness ? 'Save' : 'Install the loop and save'}
          </Button>
          <ObjectTransfer kinds={['ResearchSettings', 'Gates']} onImported={onSaved} compact />
        </div>
        {msg && (
          <p className="muted-line" role="status">
            {msg}
          </p>
        )}
      </div>
    </Drawer>
  );
}
