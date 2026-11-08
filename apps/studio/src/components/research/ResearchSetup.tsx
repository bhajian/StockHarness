// Research → Setup (#301): set up and start an experiment in one place — the scope (the S&P 500 proxy, top N by
// market cap, or a symbol list), the agents (model and skills per role), the budget (overall and per model), the
// schedule (every N minutes, until a date) and the gates; then Start, Pause or run one cycle now.
import React, { useEffect, useMemo, useState } from 'react';
import { CirclePause, CirclePlay, Play, Save } from 'lucide-react';
import { api, send, type Data } from '../../api';
import { Field } from '../ui';
import { Skeleton, StatusPill } from '../kit';

const ROLES = [
  { id: 'theorist', label: 'Theorist', what: 'proposes theories (one per Theorist per cycle)' },
  { id: 'judge', label: 'Judge', what: 'reviews them before code, and judges the results' },
  { id: 'coder', label: 'Coder', what: 'writes and tests the strategy code, then evaluates it' },
] as const;
const usd = (v: unknown, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? `$${v.toFixed(d)}` : '—');
const numOr = (v: string) => (v.trim() === '' ? undefined : Number(v));
const localInput = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');

export function ResearchSetup({
  data,
  isAdmin,
  onChanged,
}: {
  data: Data;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [s, setS] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [gates, setGates] = useState<any>(null);
  const [draftGates, setDraftGates] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  // The skills each role's agents load now (the defaults, when no choice was saved).
  const [inUse, setInUse] = useState<Record<string, string[]>>({});
  const load = async () => {
    const [a, b, c] = await Promise.all([
      api('/research/settings'),
      api('/research/status'),
      api('/research/gates'),
    ]);
    setS(a);
    setStatus(b);
    setGates(c);
  };
  useEffect(() => {
    void load();
    api('/research/how')
      .then((h: any) => {
        const out: Record<string, string[]> = {};
        for (const st of h.steps)
          for (const a of st.kind === 'parallel' ? st.agents : st.kind === 'agent' ? [st] : []) {
            const role = String(a.role).split(' ')[0];
            out[role] = [...new Set([...(out[role] ?? []), ...a.skills.map((k: any) => k.id)])];
          }
        setInUse(out);
      })
      .catch(() => undefined);
  }, []);
  const llms = useMemo(
    () => data.providers.filter((p: any) => p.modelType !== 'embedding'),
    [data.providers],
  );
  if (!s || !status || !gates) return <Skeleton rows={10} />;
  const set = (patch: Record<string, unknown>) => setS({ ...s, ...patch });
  const setBudget = (patch: Record<string, unknown>) =>
    setS({ ...s, budget: { ...(s.budget ?? {}), ...patch, stoppedAt: undefined, stopReason: undefined } });
  const setAgent = (role: string, patch: Record<string, unknown>) =>
    set({ agents: { ...s.agents, [role]: { ...(s.agents?.[role] ?? {}), ...patch } } });
  const scopeKind = s.scope?.kind === 'top_market_cap' ? (s.scope.top === 500 ? 'sp500' : 'top') : 'symbols';
  const spend = status.spend ?? {};
  const models: any[] = spend.models ?? [];
  // Models of the agents, so they appear in the budget table before they have spent anything.
  const agentModels = [
    ...new Set(
      ROLES.map((r) => llms.find((p: any) => p.id === s.agents?.[r.id]?.providerId)?.model).filter(
        Boolean,
      ) as string[],
    ),
  ];
  const modelRows = [...new Set([...models.map((m) => m.model), ...agentModels])].map(
    (m) => models.find((x) => x.model === m) ?? { model: m, today: 0, sinceCap: 0 },
  );
  const setModelCap = (model: string, patch: Record<string, number | undefined>) =>
    setBudget({
      models: { ...(s.budget?.models ?? {}), [model]: { ...(s.budget?.models?.[model] ?? {}), ...patch } },
    });

  const save = async () => {
    const { steering: _s, paused: _p, ...rest } = s;
    if (!status.harness) await send('/research/loop', {});
    await send('/research/settings', rest, 'PUT');
    if (Object.keys(draftGates).length) {
      const v = await send('/research/gates', { ...draftGates, note: 'Edited in Research → Setup' });
      setDraftGates({});
      return `Saved. Gates v${v.version} is now active; verdicts under v${gates.active} stay as they were.`;
    }
    return 'Saved.';
  };
  const act = async (what: string, fn: () => Promise<string>) => {
    setBusy(what);
    try {
      setMsg(await fn());
      await load();
      onChanged();
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    } finally {
      setBusy('');
    }
  };
  const start = () =>
    act('start', async () => {
      set({ schedule: { ...(s.schedule ?? { everyMinutes: 60 }), enabled: true } });
      const { steering: _s, paused: _p, ...rest } = s;
      await send(
        '/research/settings',
        { ...rest, schedule: { ...(s.schedule ?? { everyMinutes: 60 }), enabled: true } },
        'PUT',
      );
      if (!status.harness) await send('/research/loop', {});
      if (status.paused) await send('/research/resume', {});
      return 'Started: cycles run on the schedule.';
    });
  const active = gates.versions.find((v: any) => v.version === gates.active);
  return (
    <div className="research-setup">
      <div className="card-panel setup-status">
        <div>
          <strong>
            {status.paused
              ? 'Paused'
              : status.harness?.schedule?.enabled
                ? 'Running on a schedule'
                : 'Not scheduled'}
          </strong>
          <span className="muted-line">
            {status.harness
              ? [
                  status.harness.name,
                  status.harness.schedule?.enabled
                    ? `every ${status.harness.schedule.everyMinutes} min`
                    : 'no schedule',
                  s.schedule?.until ? `until ${new Date(s.schedule.until).toLocaleString()}` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'The research loop is not installed yet: Start installs it.'}
            {status.lastRun
              ? ` · last cycle ${status.lastRun.status}, ${new Date(status.lastRun.startedAt).toLocaleString()}`
              : ''}
          </span>
          <span className="muted-line">
            Spend today {usd(spend.today)}
            {spend.dailyCapUsd !== undefined ? ` of ${usd(spend.dailyCapUsd, 0)} a day` : ''}
            {spend.capUsd !== undefined
              ? ` · ${usd(spend.sinceCap)} of ${usd(spend.capUsd, 0)} since the cap started`
              : ''}
          </span>
          {spend.stopReason && (
            <span className="error-line">
              <StatusPill status="blocked" label="spend cap" /> {spend.stopReason}
            </span>
          )}
        </div>
        {isAdmin && (
          <div className="idea-actions">
            <button type="button" className="button primary" disabled={!!busy} onClick={start}>
              <CirclePlay size={14} /> Start
            </button>
            <button
              type="button"
              className="button"
              disabled={!!busy || !status.harness}
              onClick={() =>
                act(
                  'pause',
                  async () => (
                    await send(status.paused ? '/research/resume' : '/research/pause', {}),
                    status.paused ? 'Resumed.' : 'Paused.'
                  ),
                )
              }
            >
              <CirclePause size={14} /> {status.paused ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              className="button"
              disabled={!!busy || !status.harness || status.paused}
              onClick={() =>
                act(
                  'run',
                  async () => (
                    await send('/research/run-now', {}),
                    'A cycle started; follow it in Lab or Cycles.'
                  ),
                )
              }
            >
              <Play size={14} /> Run a cycle now
            </button>
          </div>
        )}
      </div>

      <section className="setup-section" aria-label="Scope">
        <h3>Scope</h3>
        <p className="muted-line">
          The stocks every evaluation ranks. The FMP plan has no S&P 500 constituents list, so the S&P 500
          proxy is the 500 largest US stocks by market cap on each date (point in time, delisted names
          included).
        </p>
        <div className="segmented" role="radiogroup" aria-label="Scope kind">
          {[
            ['sp500', 'S&P 500 proxy (top 500)'],
            ['top', 'Top N by market cap'],
            ['symbols', 'A symbol list'],
          ].map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={scopeKind === k}
              className={scopeKind === k ? 'active' : ''}
              onClick={() =>
                set({
                  scope:
                    k === 'symbols'
                      ? { kind: 'symbols', top: s.scope?.top ?? 500 }
                      : {
                          kind: 'top_market_cap',
                          top: k === 'sp500' ? 500 : s.scope?.top && s.scope.top !== 500 ? s.scope.top : 1000,
                        },
                })
              }
            >
              {label}
            </button>
          ))}
        </div>
        <div className="form-row">
          {scopeKind === 'top' && (
            <Field label="N (largest by market cap)">
              <input
                type="number"
                min={10}
                max={5000}
                value={s.scope.top}
                onChange={(e) => set({ scope: { kind: 'top_market_cap', top: Number(e.target.value) } })}
              />
            </Field>
          )}
          <Field label="Evaluation years (before the holdout)">
            <input
              type="number"
              min={1}
              max={15}
              value={s.evaluationYears}
              onChange={(e) => set({ evaluationYears: Number(e.target.value) })}
            />
          </Field>
        </div>
        {scopeKind === 'symbols' && (
          <Field label={`Symbols (${s.evaluationSymbols.length})`}>
            <textarea
              rows={3}
              value={s.evaluationSymbols.join(' ')}
              onChange={(e) => set({ evaluationSymbols: e.target.value.split(/[\s,]+/).filter(Boolean) })}
            />
          </Field>
        )}
      </section>

      <section className="setup-section" aria-label="Agents">
        <h3>Agents</h3>
        <table className="compact-table setup-agents">
          <thead>
            <tr>
              <th>Role</th>
              <th>Model</th>
              <th>Skills it loads</th>
            </tr>
          </thead>
          <tbody>
            {ROLES.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.label}</strong>
                  <small className="muted-line">{r.what}</small>
                </td>
                <td>
                  <select
                    aria-label={`${r.label} model`}
                    value={s.agents?.[r.id]?.providerId ?? ''}
                    onChange={(e) => setAgent(r.id, { providerId: e.target.value })}
                  >
                    <option value="">Default (first chat model)</option>
                    {llms.map((p: any) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.model}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <div className="skill-picks">
                    {data.skills.map((k: any) => {
                      const chosen = s.agents?.[r.id]?.skillIds;
                      const byDefault = !chosen?.length;
                      const current: string[] = byDefault ? (inUse[r.id] ?? []) : chosen;
                      const on = current.includes(k.id);
                      return (
                        <label
                          key={k.id}
                          className={`chip${on ? ' on' : ''}${on && byDefault ? ' default' : ''}`}
                          title={on && byDefault ? 'Loaded by default (no choice saved)' : undefined}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() =>
                              setAgent(r.id, {
                                skillIds: on ? current.filter((x: string) => x !== k.id) : [...current, k.id],
                              })
                            }
                          />
                          {k.name}
                        </label>
                      );
                    })}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted-line">
          A dashed skill is loaded by default because no choice was saved for the role; tick or untick to
          choose.
        </p>
        <div className="form-row">
          <Field label="Theorists per cycle">
            <input
              type="number"
              min={1}
              max={8}
              value={s.theoristsPerCycle}
              onChange={(e) => set({ theoristsPerCycle: Number(e.target.value) })}
            />
          </Field>
          <Field label="Pause Theorists at (ideas waiting for code)">
            <input
              type="number"
              min={1}
              max={200}
              value={s.maxCoderBacklog ?? 8}
              onChange={(e) => set({ maxCoderBacklog: Number(e.target.value) })}
            />
          </Field>
          <Field label="Effort">
            <select value={s.agentEffort} onChange={(e) => set({ agentEffort: e.target.value })}>
              {['light', 'medium', 'high', 'extra-high', 'max'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
          <Field label="Turns per agent">
            <input
              type="number"
              min={3}
              max={200}
              value={s.agentMaxTurns}
              onChange={(e) => set({ agentMaxTurns: Number(e.target.value) })}
            />
          </Field>
        </div>
        <Field label="Focus for the Theorists">
          <textarea rows={4} value={s.focus} onChange={(e) => set({ focus: e.target.value })} />
        </Field>
      </section>

      <section className="setup-section" aria-label="Budget">
        <h3>Budget</h3>
        <p className="muted-line">
          Model calls are priced per model. At any cap the next call is refused and the loop pauses itself; a
          model&apos;s own cap stops only that model.
        </p>
        <div className="form-row">
          <Field label="Total cap (USD)" hint="Counted from when it is first set">
            <input
              aria-label="Total spend cap"
              type="number"
              min={0}
              value={s.budget?.capUsd ?? ''}
              onChange={(e) => {
                const v = numOr(e.target.value);
                setBudget({
                  capUsd: v,
                  capSince: v === undefined ? undefined : (s.budget?.capSince ?? new Date().toISOString()),
                });
              }}
            />
          </Field>
          <Field label="Daily cap (USD)" hint="The UTC day">
            <input
              aria-label="Daily spend cap"
              type="number"
              min={0}
              value={s.budget?.dailyCapUsd ?? ''}
              onChange={(e) => setBudget({ dailyCapUsd: numOr(e.target.value) })}
            />
          </Field>
        </div>
        <table className="compact-table" aria-label="Spend by model">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Price in / out (per 1M)</th>
              <th className="num">Today</th>
              <th className="num">Since the cap started</th>
              <th>Cap (USD)</th>
              <th>Daily cap (USD)</th>
            </tr>
          </thead>
          <tbody>
            {modelRows.map((m) => (
              <tr key={m.model}>
                <td>
                  <code>{m.model}</code>
                  {m.exceeded && <StatusPill status="blocked" label="capped" />}
                </td>
                <td className="num">{m.price ? `${usd(m.price.input)} / ${usd(m.price.output)}` : '—'}</td>
                <td className="num">{usd(m.today)}</td>
                <td className="num">{usd(m.sinceCap)}</td>
                <td>
                  <input
                    aria-label={`${m.model} cap`}
                    type="number"
                    min={0}
                    value={s.budget?.models?.[m.model]?.capUsd ?? ''}
                    onChange={(e) => setModelCap(m.model, { capUsd: numOr(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    aria-label={`${m.model} daily cap`}
                    type="number"
                    min={0}
                    value={s.budget?.models?.[m.model]?.dailyCapUsd ?? ''}
                    onChange={(e) => setModelCap(m.model, { dailyCapUsd: numOr(e.target.value) })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="setup-section" aria-label="Schedule">
        <h3>Schedule</h3>
        <div className="form-row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={!!s.schedule?.enabled}
              onChange={(e) =>
                set({
                  schedule: {
                    everyMinutes: s.schedule?.everyMinutes ?? 60,
                    ...(s.schedule ?? {}),
                    enabled: e.target.checked,
                  },
                })
              }
            />
            Run cycles on a schedule
          </label>
          <Field label="Every (minutes)">
            <input
              type="number"
              min={10}
              max={10080}
              value={s.schedule?.everyMinutes ?? 60}
              onChange={(e) =>
                set({
                  schedule: {
                    enabled: !!s.schedule?.enabled,
                    ...(s.schedule ?? {}),
                    everyMinutes: Number(e.target.value),
                  },
                })
              }
            />
          </Field>
          <Field label="Until (optional)" hint="The schedule turns itself off after this">
            <input
              type="datetime-local"
              value={localInput(s.schedule?.until)}
              onChange={(e) =>
                set({
                  schedule: {
                    enabled: !!s.schedule?.enabled,
                    everyMinutes: s.schedule?.everyMinutes ?? 60,
                    ...(e.target.value ? { until: new Date(`${e.target.value}Z`).toISOString() } : {}),
                  },
                })
              }
            />
          </Field>
        </div>
      </section>

      <section className="setup-section" aria-label="Gates">
        <h3>
          Success gates v{gates.active}{' '}
          {active?.lockedAt ? <StatusPill status="locked" label="locked" /> : null}
        </h3>
        <p className="muted-line">
          A theory is successful only when it passes every gate; changing a threshold creates gates v
          {Math.max(...gates.versions.map((v: any) => v.version)) + 1}, and verdicts under different versions
          are not compared.
        </p>
        <div className="form-row">
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
      </section>

      {isAdmin && (
        <div className="setup-footer">
          {msg && (
            <span className="muted-line" role="status">
              {msg}
            </span>
          )}
          <button
            type="button"
            className="button primary"
            disabled={!!busy}
            onClick={() => act('save', save)}
          >
            <Save size={14} /> Save
          </button>
        </div>
      )}
    </div>
  );
}
