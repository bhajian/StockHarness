// Research → Setup (#301, #413): set up and start an experiment in one place, grouped by what each setting affects:
// the Theorists (how many; a model and an idea profile each), the Judge and Coder (model and skills), effort, the
// evaluation scope, the budget (overall and per model), the schedule and the gates; then Start, Pause or run a cycle.
import React, { useEffect, useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import { api, send, type Data } from '../../api';
import { Field } from '../ui';
import { Skeleton, StatusPill } from '../kit';
import { SortHead, useSort } from '../tableKit';
import { ResearchStatusBar, startResearch } from './ResearchStatusBar';
import { ALL_PROFILES } from '../../../../../packages/core/src/profiles.js';

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
  // #413: one row per Theorist, with its own model (empty = the default) and idea profile (Theorist i takes the
  // i-th profile, counting again from the first).
  const n: number = s.theoristsPerCycle ?? 2;
  const baseProfiles: string[] = s.profiles?.length ? s.profiles : DEFAULT_PROFILES;
  const theoristRows = Array.from({ length: n }, (_, i) => ({
    i,
    providerId: (s.theoristProviders ?? [])[i] ?? '',
    profile: baseProfiles[i % baseProfiles.length],
  }));
  const defaultTheoristModel = llms.find((p: any) => p.id === s.agents?.theorist?.providerId)?.model;
  const setTheoristModel = (i: number, v: string) =>
    set({ theoristProviders: theoristRows.map((r) => (r.i === i ? v : r.providerId)) });
  const setTheoristProfile = (i: number, v: string) =>
    set({ profiles: theoristRows.map((r) => (r.i === i ? v : r.profile)) });
  const scopeKind =
    s.scope?.kind === 'index'
      ? `index:${s.scope.index ?? 'sp500'}`
      : s.scope?.kind === 'top_market_cap'
        ? s.scope.top === 500
          ? 'sp500'
          : 'top'
        : 'symbols';
  const spend = status.spend ?? {};
  const models: any[] = spend.models ?? [];
  // Models of the agents, so they appear in the budget table before they have spent anything.
  const agentModels = [
    ...new Set(
      [...ROLES.map((r) => s.agents?.[r.id]?.providerId), ...(s.theoristProviders ?? [])]
        .map((id) => llms.find((p: any) => p.id === id)?.model)
        .filter(Boolean) as string[],
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
  // Start (#458) saves the edited settings with the schedule on; an ended schedule loses its end date.
  const start = async () => {
    const { steering: _s, paused: _p, ...rest } = s;
    if (!status.harness) await send('/research/loop', {});
    await send('/research/settings', rest, 'PUT');
    return startResearch(status, s);
  };
  const active = gates.versions.find((v: any) => v.version === gates.active);
  return (
    <div className="research-setup">
      <div className="card-panel setup-status">
        <ResearchStatusBar
          status={status}
          isAdmin={isAdmin}
          onChanged={() => (void load(), onChanged())}
          onStart={start}
        />
        <span className="muted-line">
          {status.harness ? `${status.harness.name} · ` : ''}
          Spend today {usd(spend.today)}
          {spend.dailyCapUsd !== undefined ? ` of ${usd(spend.dailyCapUsd, 0)} a day` : ''}
          {spend.capUsd !== undefined
            ? ` · ${usd(spend.sinceCap)} of ${usd(spend.capUsd, 0)} since the cap started`
            : ''}
          {status.lastRun
            ? ` · last cycle ${status.lastRun.status}, ${new Date(status.lastRun.startedAt).toLocaleString()}`
            : ''}
        </span>
      </div>

      <section className="setup-section" aria-label="Theorists">
        <h3>Theorists</h3>
        <p className="muted-line">
          Each Theorist proposes one idea per cycle, in parallel with the others. Choose how many, and give
          each its own model and the kind of idea it looks for.
        </p>
        <div className="form-row">
          <Field label="Number of Theorists">
            <input
              aria-label="Number of Theorists"
              type="number"
              min={1}
              max={8}
              value={s.theoristsPerCycle}
              onChange={(e) =>
                set({ theoristsPerCycle: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })
              }
            />
          </Field>
          <Field label="Default model" hint="For every Theorist set to the default">
            <ModelSelect
              label="Theorist default model"
              llms={llms}
              value={s.agents?.theorist?.providerId ?? ''}
              empty="First chat model"
              onChange={(v) => setAgent('theorist', { providerId: v })}
            />
          </Field>
          <Field label="Pause new ideas at" hint="Ideas waiting for code; revisions still go">
            <input
              type="number"
              min={1}
              max={200}
              value={s.maxCoderBacklog ?? 8}
              onChange={(e) => set({ maxCoderBacklog: Number(e.target.value) })}
            />
          </Field>
        </div>
        <table className="compact-table setup-theorists" aria-label="Theorist models">
          <thead>
            <tr>
              <th>Theorist</th>
              <th>Model</th>
              <th>Idea profile</th>
            </tr>
          </thead>
          <tbody>
            {theoristRows.map((row) => (
              <tr key={row.i}>
                <td>
                  <strong>Theorist {row.i + 1}</strong>
                </td>
                <td>
                  <ModelSelect
                    label={`Theorist ${row.i + 1} model`}
                    llms={llms}
                    value={row.providerId}
                    empty={`Default${defaultTheoristModel ? ` (${defaultTheoristModel})` : ''}`}
                    onChange={(v) => setTheoristModel(row.i, v)}
                  />
                </td>
                <td>
                  <select
                    aria-label={`Theorist ${row.i + 1} idea profile`}
                    value={row.profile}
                    onChange={(e) => setTheoristProfile(row.i, e.target.value)}
                  >
                    {ALL_PROFILES.map((p) => (
                      <option key={p.id} value={p.id} disabled={!p.available}>
                        {p.label}
                        {p.available ? '' : ' (when the options evaluator is ready)'}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Field label="Skills every Theorist loads">
          <SkillPicks role="theorist" skills={data.skills} s={s} inUse={inUse} setAgent={setAgent} />
        </Field>
        <Field label="Focus for the Theorists" hint="Shown in every Theorist's brief">
          <textarea rows={4} value={s.focus} onChange={(e) => set({ focus: e.target.value })} />
        </Field>
      </section>

      <section className="setup-section" aria-label="Judge and Coder">
        <h3>Judge and Coder</h3>
        <p className="muted-line">
          The Judge reviews each idea before any code is written, then judges the results against the gates.
          The Coder writes and tests the strategy code, then runs the evaluation.
        </p>
        <table className="compact-table setup-agents">
          <thead>
            <tr>
              <th>Role</th>
              <th>Model</th>
              <th>Skills it loads</th>
            </tr>
          </thead>
          <tbody>
            {ROLES.filter((r) => r.id !== 'theorist').map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.label}</strong>
                  <small className="muted-line">{r.what}</small>
                </td>
                <td>
                  <ModelSelect
                    label={`${r.label} model`}
                    llms={llms}
                    value={s.agents?.[r.id]?.providerId ?? ''}
                    empty="Default (first chat model)"
                    onChange={(v) => setAgent(r.id, { providerId: v })}
                  />
                </td>
                <td>
                  <SkillPicks role={r.id} skills={data.skills} s={s} inUse={inUse} setAgent={setAgent} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted-line">
          A dashed skill is loaded by default because no choice was saved for the role; tick or untick to
          choose.
        </p>
      </section>

      <section className="setup-section" aria-label="Effort">
        <h3>How hard the agents work</h3>
        <p className="muted-line">
          Applies to every agent above. More effort and more turns go deeper and cost more.
        </p>
        <div className="form-row">
          <Field label="Effort">
            <select value={s.agentEffort} onChange={(e) => set({ agentEffort: e.target.value })}>
              {['light', 'medium', 'high', 'extra-high', 'max'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
          <Field label="Turns per agent" hint="Tool calls and replies an agent may take per cycle">
            <input
              type="number"
              min={3}
              max={200}
              value={s.agentMaxTurns}
              onChange={(e) => set({ agentMaxTurns: Number(e.target.value) })}
            />
          </Field>
        </div>
      </section>

      <section className="setup-section" aria-label="Scope">
        <h3>Evaluation scope</h3>
        <p className="muted-line">
          What every evaluation tests: the stocks it ranks and the years before the holdout. An index means
          its members on each date (point in time, from the index change history, delisted members included).
          The S&P 500 proxy is the 500 largest US stocks by market cap on each date. A symbol list is
          today&apos;s choice of names, so its results carry a hindsight warning.
        </p>
        <div className="segmented" role="radiogroup" aria-label="Scope kind">
          {[
            ['index:sp500', 'S&P 500 members'],
            ['index:ndx', 'Nasdaq-100'],
            ['index:dji', 'Dow'],
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
                  scope: k.startsWith('index:')
                    ? { kind: 'index', index: k.slice(6), top: s.scope?.top ?? 500 }
                    : k === 'symbols'
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
          <Field
            label="Evaluation years (before the holdout)"
            hint="15 = all history, from a year after the first price"
          >
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
        <SpendTable rows={modelRows} caps={s.budget?.models ?? {}} setModelCap={setModelCap} />
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

const DEFAULT_PROFILES = ['equity_long', 'equity_short', 'equity_long_short'];

/** A chat model picker; the empty value is the default named by `empty`. */
function ModelSelect({
  label,
  llms,
  value,
  empty,
  onChange,
}: {
  label: string;
  llms: any[];
  value: string;
  empty: string;
  onChange: (v: string) => void;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {llms.map((p: any) => (
        <option key={p.id} value={p.id}>
          {p.name} · {p.model}
        </option>
      ))}
    </select>
  );
}

/** The skills a role's agents load; dashed = loaded by default because no choice was saved. */
function SkillPicks({
  role,
  skills,
  s,
  inUse,
  setAgent,
}: {
  role: string;
  skills: any[];
  s: any;
  inUse: Record<string, string[]>;
  setAgent: (role: string, patch: Record<string, unknown>) => void;
}) {
  const chosen: string[] | undefined = s.agents?.[role]?.skillIds;
  const byDefault = !chosen?.length;
  const current: string[] = byDefault ? (inUse[role] ?? []) : chosen!;
  return (
    <div className="skill-picks">
      {skills.map((k: any) => {
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
                setAgent(role, { skillIds: on ? current.filter((x) => x !== k.id) : [...current, k.id] })
              }
            />
            {k.name}
          </label>
        );
      })}
    </div>
  );
}

/** Spend per model (#385: sortable by model, price and spend; the cap inputs do not sort, so rows never jump
 * while a cap is typed). */
function SpendTable({
  rows,
  caps,
  setModelCap,
}: {
  rows: any[];
  caps: Record<string, { capUsd?: number; dailyCapUsd?: number }>;
  setModelCap: (model: string, patch: Record<string, number | undefined>) => void;
}) {
  const { sorted, sort, toggle } = useSort(rows, {
    model: { value: (m) => m.model },
    price: { value: (m) => m.price?.input, firstDesc: true },
    today: { value: (m) => m.today, firstDesc: true },
    since: { value: (m) => m.sinceCap, firstDesc: true },
  });
  return (
    <table className="compact-table" aria-label="Spend by model">
      <SortHead
        heads={[
          ['model', 'Model'],
          ['price', 'Price in / out (per 1M)', 'num'],
          ['today', 'Today', 'num'],
          ['since', 'Since the cap started', 'num'],
        ]}
        sort={sort}
        toggle={toggle}
        extra={
          <>
            <th>Cap (USD)</th>
            <th>Daily cap (USD)</th>
          </>
        }
      />
      <tbody>
        {sorted.map((m) => (
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
                value={caps[m.model]?.capUsd ?? ''}
                onChange={(e) => setModelCap(m.model, { capUsd: numOr(e.target.value) })}
              />
            </td>
            <td>
              <input
                aria-label={`${m.model} daily cap`}
                type="number"
                min={0}
                value={caps[m.model]?.dailyCapUsd ?? ''}
                onChange={(e) => setModelCap(m.model, { dailyCapUsd: numOr(e.target.value) })}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
