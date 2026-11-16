// The schedule modal (#125): pick ideas, the period (presets up to the holdout), capital, allocation, sizing,
// constraints, exits and costs; the estimate (runtime, sessions, pinned code versions) updates as you type.
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Clock, Play } from 'lucide-react';
import { api, send } from '../../api';
import { Field, Modal } from '../ui';
import { IdeaStatus } from '../ideas/IdeaStatus';
import { go, num, pct } from '../ideas/nav';
import { duration } from './SimulationsPage';

type Config = Record<string, any>;
const yearsBefore = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);
const numOrNull = (v: string, scale = 1) => (v.trim() === '' ? null : Number(v) / scale);

export function ScheduleModal({
  ideas: preset,
  cloneOf,
  onClose,
}: {
  ideas: string[];
  cloneOf?: string;
  onClose: () => void;
}) {
  const [available, setAvailable] = useState<any[] | null>(null);
  const [readableEnd, setReadableEnd] = useState<string | undefined>();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [estimate, setEstimate] = useState<any>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([
      api('/ideas?limit=1000&sort=recent'),
      api('/evaluator/settings').catch(() => ({})),
      cloneOf ? api(`/simulations/${cloneOf}`) : Promise.resolve(null),
    ]).then(([list, settings, clone]) => {
      setAvailable(list.items);
      const end = (settings as any).readableEnd ?? today();
      setReadableEnd((settings as any).readableEnd);
      if (clone) {
        const c = { ...clone.config, name: `${clone.config.name} (copy)` };
        setCfg(c);
        return;
      }
      const picked = preset.length ? preset : [];
      setCfg({
        name: picked.length ? `${picked.join(' + ')} simulation` : 'New simulation',
        ideas: picked.map((idea) => ({ idea })),
        period: { start: yearsBefore(end, 10), end, allowHoldout: false },
        capital: 1_000_000,
        allocation: 'equal',
        sizing: { mode: 'equal' },
        constraints: { positionCap: null, sectorCap: null, gross: 1, net: null },
        exits: { stop: null, takeProfit: null, horizon: false, review: true },
        costs: {},
        dividends: 'reinvest',
        seed: 0,
      });
    });
  }, []);
  // The estimate follows the form (debounced); it also resolves the pinned code versions.
  useEffect(() => {
    if (!cfg || !cfg.ideas.length) {
      setEstimate(null);
      return;
    }
    const t = setTimeout(() => {
      send('/simulations/estimate', { config: cfg })
        .then((r) => {
          setEstimate(r);
          setProblem('');
        })
        .catch((e) => {
          setEstimate(null);
          setProblem(e?.message ?? String(e));
        });
    }, 450);
    return () => clearTimeout(t);
  }, [JSON.stringify(cfg)]);
  const set = (path: string, value: unknown) =>
    setCfg((c) => {
      const next = structuredClone(c) as Config;
      const keys = path.split('.');
      let o = next;
      for (const k of keys.slice(0, -1)) o = o[k] ??= {};
      o[keys.at(-1)!] = value;
      return next;
    });
  const chosen = new Set((cfg?.ideas ?? []).map((i: any) => i.idea));
  const toggleIdea = (ref: string) =>
    set(
      'ideas',
      chosen.has(ref)
        ? cfg!.ideas.filter((i: any) => i.idea !== ref)
        : cfg!.ideas.length >= 8
          ? cfg!.ideas
          : [...cfg!.ideas, { idea: ref }],
    );
  const pickable = useMemo(
    () =>
      (available ?? []).map((i) => ({
        ...i,
        hasCode: i.sharpe !== null || ['coding', 'evaluated'].includes(i.status),
      })),
    [available],
  );
  const [ideaQuery, setIdeaQuery] = useState('');
  const shownIdeas = useMemo(() => {
    const q = ideaQuery.trim().toLowerCase();
    return q
      ? pickable.filter((i) => chosen.has(i.ref) || `${i.ref} ${i.title}`.toLowerCase().includes(q))
      : pickable;
  }, [pickable, ideaQuery, chosen]);
  const insideHoldout = !!readableEnd && !!cfg && cfg.period.end > readableEnd;
  const launch = async () => {
    setBusy(true);
    try {
      const r = await send('/simulations', { config: cfg });
      onClose();
      go(`/simulations/${r.id}`);
    } catch (e: any) {
      setProblem(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={cloneOf ? 'Clone and edit a simulation' : 'New simulation'} onClose={onClose} wide>
      {!cfg || !available ? (
        <p className="muted-line">Loading…</p>
      ) : (
        <div className="schedule-form">
          <div className="schedule-body">
            <Field label="Name">
              <input value={cfg.name} onChange={(e) => set('name', e.target.value)} maxLength={120} />
            </Field>
            <fieldset>
              <legend>
                Ideas <small className="muted-line">({cfg.ideas.length} of up to 8)</small>
              </legend>
              {!pickable.length && (
                <p className="muted-line">No ideas yet: the research loop creates them.</p>
              )}
              {pickable.length > 8 && (
                <input
                  className="idea-search"
                  type="search"
                  placeholder="Search ideas by number or title"
                  aria-label="Search ideas"
                  value={ideaQuery}
                  onChange={(e) => setIdeaQuery(e.target.value)}
                />
              )}
              <div className="idea-picker" role="group" aria-label="Ideas">
                {shownIdeas.map((i) => (
                  <label
                    key={i.id}
                    className={`idea-pick${chosen.has(i.ref) ? ' on' : ''}${i.hasCode ? '' : ' off'}`}
                  >
                    <input
                      type="checkbox"
                      checked={chosen.has(i.ref)}
                      disabled={!i.hasCode && !chosen.has(i.ref)}
                      onChange={() => toggleIdea(i.ref)}
                    />
                    <span className="mono">{i.ref}</span>
                    <span className="idea-pick-title">{i.title}</span>
                    <IdeaStatus status={i.status} />
                    <small className="muted-line">
                      {i.hasCode
                        ? `Sharpe ${num(i.sharpe)} · ${pct(i.excessPerYear)} / yr`
                        : 'no evaluated code yet'}
                    </small>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Period</legend>
              <div className="form-row cols-2">
                <Field label="Start">
                  <input
                    type="date"
                    value={cfg.period.start}
                    onChange={(e) => set('period.start', e.target.value)}
                  />
                </Field>
                <Field label="End">
                  <input
                    type="date"
                    value={cfg.period.end}
                    onChange={(e) => set('period.end', e.target.value)}
                  />
                </Field>
              </div>
              <div className="preset-row" role="group" aria-label="Period presets">
                <span className="muted-line">Last</span>
                {[1, 3, 5, 10].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="button secondary small"
                    onClick={() => {
                      const end = readableEnd ?? today();
                      set('period', { ...cfg.period, start: yearsBefore(end, n), end });
                    }}
                  >
                    {n}y
                  </button>
                ))}
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={!!cfg.period.allowHoldout}
                  onChange={(e) => set('period.allowHoldout', e.target.checked)}
                />
                Allow the holdout{readableEnd ? ` (after ${readableEnd})` : ''}
              </label>
              {insideHoldout && (
                <p className={`notice ${cfg.period.allowHoldout ? 'warning-notice' : 'error-notice'}`}>
                  <AlertTriangle size={14} />{' '}
                  {cfg.period.allowHoldout
                    ? 'This run reads the holdout. Results after it are no longer an untouched test.'
                    : `The end is inside the locked holdout. End by ${readableEnd}, or allow the holdout.`}
                </p>
              )}
            </fieldset>
            <fieldset>
              <legend>Book</legend>
              <div className="form-row cols-4">
                <Field label="Capital">
                  <Unit unit="USD">
                    <input
                      type="number"
                      min={1000}
                      step={1000}
                      value={cfg.capital}
                      onChange={(e) => set('capital', Number(e.target.value))}
                    />
                  </Unit>
                </Field>
                <Field label="Allocation" hint="Across ideas; risk parity: inverse volatility of each book">
                  <select value={cfg.allocation} onChange={(e) => set('allocation', e.target.value)}>
                    <option value="equal">Equal</option>
                    <option value="risk_parity">Risk parity</option>
                    <option value="custom">Custom weights</option>
                  </select>
                </Field>
                <Field label="Sizing" hint="Quarter-Kelly: each idea's shrunk edge">
                  <select value={cfg.sizing.mode} onChange={(e) => set('sizing.mode', e.target.value)}>
                    <option value="equal">Equal weight (as evaluated)</option>
                    <option value="quarter_kelly">Quarter-Kelly</option>
                  </select>
                </Field>
                <Field label="Dividends" hint="Reinvest matches the evaluation">
                  <select
                    value={cfg.dividends ?? 'reinvest'}
                    onChange={(e) => set('dividends', e.target.value)}
                  >
                    <option value="reinvest">Reinvest in the stock</option>
                    <option value="cash">Keep in cash</option>
                  </select>
                </Field>
              </div>
              {cfg.allocation === 'custom' && (
                <table className="weights-table" aria-label="Weights by idea">
                  <thead>
                    <tr>
                      <th>Idea</th>
                      <th className="num">Weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cfg.ideas.map((i: any, k: number) => (
                      <tr key={i.idea}>
                        <td className="mono">{i.idea}</td>
                        <td className="num">
                          <Unit unit="%">
                            <input
                              type="number"
                              min={0}
                              max={100}
                              aria-label={`${i.idea} weight`}
                              value={i.weight === undefined ? '' : Math.round(i.weight * 100)}
                              onChange={(e) =>
                                set(
                                  'ideas',
                                  cfg.ideas.map((x: any, j: number) =>
                                    j === k ? { ...x, weight: Number(e.target.value) / 100 } : x,
                                  ),
                                )
                              }
                            />
                          </Unit>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td className="num">
                        {Math.round(cfg.ideas.reduce((a: number, x: any) => a + (x.weight ?? 0), 0) * 100)}%
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )}
              <h4 className="form-subhead">Limits</h4>
              <div className="form-row cols-4">
                <Field label="Per name" hint="Across ideas; empty: 10%">
                  <Unit unit="%">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      placeholder="10"
                      value={cfg.constraints.positionCap === null ? '' : cfg.constraints.positionCap * 100}
                      onChange={(e) => set('constraints.positionCap', numOrNull(e.target.value, 100))}
                    />
                  </Unit>
                </Field>
                <Field label="Per sector" hint="Empty: 30%">
                  <Unit unit="%">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      placeholder="30"
                      value={cfg.constraints.sectorCap === null ? '' : cfg.constraints.sectorCap * 100}
                      onChange={(e) => set('constraints.sectorCap', numOrNull(e.target.value, 100))}
                    />
                  </Unit>
                </Field>
                <Field label="Gross" hint="Long + short">
                  <Unit unit="×">
                    <input
                      type="number"
                      min={0.1}
                      max={3}
                      step={0.1}
                      value={cfg.constraints.gross}
                      onChange={(e) => set('constraints.gross', Number(e.target.value))}
                    />
                  </Unit>
                </Field>
                <Field label="Net" hint="Empty: none">
                  <Unit unit="×">
                    <input
                      type="number"
                      min={0}
                      max={3}
                      step={0.1}
                      value={cfg.constraints.net ?? ''}
                      onChange={(e) => set('constraints.net', numOrNull(e.target.value))}
                    />
                  </Unit>
                </Field>
              </div>
            </fieldset>
            <fieldset>
              <legend>Exits</legend>
              <p className="muted-line">
                A name always leaves when a rebalance replaces it. These add daily exits, decided at a close
                and filled at the next one.
              </p>
              <div className="form-row cols-3">
                <Field label="Stop loss" hint="Empty: none">
                  <Unit unit="%">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={cfg.exits.stop === null ? '' : cfg.exits.stop * 100}
                      onChange={(e) => set('exits.stop', numOrNull(e.target.value, 100))}
                    />
                  </Unit>
                </Field>
                <Field label="Take profit">
                  <select
                    value={
                      cfg.exits.takeProfit === null
                        ? 'none'
                        : cfg.exits.takeProfit === 'p90'
                          ? 'p90'
                          : 'fixed'
                    }
                    onChange={(e) =>
                      set(
                        'exits.takeProfit',
                        e.target.value === 'none' ? null : e.target.value === 'p90' ? 'p90' : 0.25,
                      )
                    }
                  >
                    <option value="none">None</option>
                    <option value="p90">P90 of closed trades</option>
                    <option value="fixed">A fixed return</option>
                  </select>
                </Field>
                {typeof cfg.exits.takeProfit === 'number' && (
                  <Field label="Take profit at">
                    <Unit unit="%">
                      <input
                        type="number"
                        min={1}
                        value={cfg.exits.takeProfit * 100}
                        onChange={(e) => set('exits.takeProfit', Number(e.target.value) / 100)}
                      />
                    </Unit>
                  </Field>
                )}
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={cfg.exits.horizon}
                  onChange={(e) => set('exits.horizon', e.target.checked)}
                />{' '}
                Exit after the idea&apos;s horizon without a rebalance keeping the name
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={cfg.exits.review}
                  onChange={(e) => set('exits.review', e.target.checked)}
                />{' '}
                Use the plugin&apos;s review() exits (invalidation, p_outperform), when it has one
              </label>
            </fieldset>
            <details className="form-section">
              <summary>Costs</summary>
              <p className="muted-line">
                Empty: the evaluator&apos;s (1 bp commission, 5 bps slippage, borrow by market cap). Market
                impact is added from each name&apos;s volume at this capital.
              </p>
              <div className="form-row cols-3">
                <Field label="Commission">
                  <Unit unit="bps">
                    <input
                      type="number"
                      min={0}
                      placeholder="1"
                      value={cfg.costs.commissionBps ?? ''}
                      onChange={(e) =>
                        set('costs.commissionBps', e.target.value === '' ? undefined : Number(e.target.value))
                      }
                    />
                  </Unit>
                </Field>
                <Field label="Slippage">
                  <Unit unit="bps">
                    <input
                      type="number"
                      min={0}
                      placeholder="5"
                      value={cfg.costs.slippageBps ?? ''}
                      onChange={(e) =>
                        set('costs.slippageBps', e.target.value === '' ? undefined : Number(e.target.value))
                      }
                    />
                  </Unit>
                </Field>
                <Field label="Borrow" hint="When the market cap is unknown">
                  <Unit unit="bps / yr">
                    <input
                      type="number"
                      min={0}
                      placeholder="50"
                      value={cfg.costs.borrowBps ?? ''}
                      onChange={(e) =>
                        set('costs.borrowBps', e.target.value === '' ? undefined : Number(e.target.value))
                      }
                    />
                  </Unit>
                </Field>
              </div>
            </details>
            <details className="form-section">
              <summary>Advanced</summary>
              <div className="form-row cols-3">
                <Field label="Fill lag" hint="Sessions after the signal">
                  <input
                    type="number"
                    min={1}
                    max={5}
                    placeholder="1"
                    value={cfg.costs.executionLagDays ?? ''}
                    onChange={(e) =>
                      set(
                        'costs.executionLagDays',
                        e.target.value === '' ? undefined : Number(e.target.value),
                      )
                    }
                  />
                </Field>
                <Field label="Seed" hint="Same config and seed, same ledger">
                  <input
                    type="number"
                    min={0}
                    value={cfg.seed}
                    onChange={(e) => set('seed', Number(e.target.value))}
                  />
                </Field>
              </div>
            </details>
          </div>
          <div className="schedule-footer">
            <div className="estimate-box" aria-live="polite">
              <Clock size={16} />
              {estimate ? (
                <span>
                  About <strong>{duration(estimate.estimate.seconds)}</strong> · {estimate.estimate.days}{' '}
                  sessions · code{' '}
                  {estimate.config.ideas.map((i: any) => `${i.idea} v${i.version}`).join(', ')}
                  {estimate.config.universeIndex
                    ? ` · ${({ sp500: 'S&P 500', ndx: 'Nasdaq-100', dji: 'Dow' } as Record<string, string>)[estimate.config.universeIndex]} members on each date`
                    : estimate.config.universeTop
                      ? ` · the ${estimate.config.universeTop} largest by market cap on each date`
                      : estimate.config.symbols
                        ? ` · ${estimate.config.symbols.length} symbols`
                        : ' · whole universe'}
                </span>
              ) : (
                <span className="muted-line">
                  {cfg.ideas.length ? 'Estimating…' : 'Pick at least one idea.'}
                </span>
              )}
            </div>
            {problem && (
              <p className="error-line" role="alert">
                {problem}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="button secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="button primary"
                disabled={
                  busy || !estimate || !cfg.ideas.length || (insideHoldout && !cfg.period.allowHoldout)
                }
                onClick={launch}
              >
                <Play size={14} /> Launch
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** An input with its unit inside the box (%, bps, ×, USD), so labels stay short and one line (#469). */
function Unit({
  unit,
  children,
  id,
}: {
  unit: string;
  children: React.ReactElement<{ id?: string }>;
  id?: string;
}) {
  return (
    <span className="input-unit">
      {id ? React.cloneElement(children, { id }) : children}
      <span aria-hidden="true">{unit}</span>
    </span>
  );
}
Unit.forwardsId = true;
