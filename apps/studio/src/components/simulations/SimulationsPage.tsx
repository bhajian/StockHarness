// Simulations (#126): the list of runs, a run's own page (/simulations/:id[/tab]) and the schedule modal
// (/simulations?new=T-1,T-2 opens it with those ideas; #125).
import React, { useEffect, useState } from 'react';
import { Plus, Play } from 'lucide-react';
import { api } from '../../api';
import { Skeleton, StatusPill } from '../kit';
import { go, num, pct, setQuery, useLocation } from '../ideas/nav';
import { SimulationDetail } from './SimulationDetail';
import { ScheduleModal } from './ScheduleModal';

export const money = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v)
    ? v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '—';
export const when = (v: string | Date) => new Date(v).toLocaleString();
export const duration = (s: number) =>
  s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;

/** Open the schedule modal over the current page (with these ideas, or as a clone of a run). */
export function openSchedule(o: { ideas?: string[]; clone?: string } = {}) {
  const q = new URLSearchParams(location.search);
  q.set('new', (o.ideas ?? []).join(','));
  if (o.clone) q.set('clone', o.clone);
  else q.delete('clone');
  history.pushState({}, '', `${location.pathname}?${q}`);
  dispatchEvent(new PopStateEvent('popstate'));
}

export function SimulationsPage({ isAdmin }: { isAdmin: boolean }) {
  const loc = useLocation();
  const parts = loc.path.split('/').filter(Boolean); // ['simulations', id?, tab?]
  const params = new URLSearchParams(loc.search);
  const opening = params.get('new');
  return (
    <>
      {parts[1] ? (
        <SimulationDetail
          id={decodeURIComponent(parts[1])}
          tab={parts[2] ?? 'performance'}
          isAdmin={isAdmin}
        />
      ) : (
        <SimulationList isAdmin={isAdmin} />
      )}
      {opening !== null && isAdmin && (
        <ScheduleModal
          ideas={opening ? opening.split(',').filter(Boolean) : []}
          cloneOf={params.get('clone') ?? undefined}
          onClose={() => setQuery({ new: undefined, clone: undefined })}
        />
      )}
    </>
  );
}

function SimulationList({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      api<any[]>('/simulations').then((r) => {
        if (stop) return;
        setRows(r);
        if (r.some((x) => x.status === 'running')) setTimeout(load, 4000);
      });
    void load();
    return () => {
      stop = true;
    };
  }, []);
  if (!rows) return <Skeleton rows={8} />;
  return (
    <section className="page-section sims-page">
      <header className="page-head">
        <div>
          <h2>Simulations</h2>
          <p className="muted-line">
            Ideas run as one book through the paper broker: real shares and cash, costs, borrow, dividends and
            splits, exits with reasons. Open a run for its performance, trades, positions and attribution.
          </p>
        </div>
        {isAdmin && (
          <button type="button" className="button primary" onClick={() => openSchedule()}>
            <Plus size={14} /> New simulation
          </button>
        )}
      </header>
      {!rows.length ? (
        <div className="empty-state">
          <p>No simulations yet.</p>
          <p className="muted-line">
            Start one here, or from an idea&apos;s page (<em>Simulate</em>) once the idea has evaluated code.
          </p>
          {isAdmin && (
            <button type="button" className="button secondary" onClick={() => openSchedule()}>
              <Play size={14} /> New simulation
            </button>
          )}
        </div>
      ) : (
        <div className="table-wrap sims-table">
          <table aria-label="Simulations">
            <thead>
              <tr>
                <th>Name</th>
                <th>Ideas</th>
                <th>Period</th>
                <th>Status</th>
                <th className="num">CAGR</th>
                <th className="num">Sharpe</th>
                <th className="num">Max DD</th>
                <th className="num">Final NAV</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => go(`/simulations/${r.id}`)}>
                  <td>
                    <strong>{r.name}</strong>
                    {r.usesHoldout && <small className="muted-line">uses the holdout</small>}
                  </td>
                  <td>
                    <span className="chips">
                      {r.ideas.map((i: string) => (
                        <button
                          key={i}
                          type="button"
                          className="chip"
                          title={`Open ${i}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            go(`/ideas/${i}`);
                          }}
                        >
                          {i}
                        </button>
                      ))}
                    </span>
                  </td>
                  <td className="nowrap">
                    {r.period.start} → {r.period.end}
                  </td>
                  <td>
                    <StatusPill status={r.status} />
                    {r.status === 'running' && (
                      <small className="muted-line">≈ {duration(r.estimateSeconds)}</small>
                    )}
                    {r.error && (
                      <small className="error-line" title={r.error}>
                        {r.error.slice(0, 60)}
                      </small>
                    )}
                  </td>
                  <td className="num">{pct(r.cagr)}</td>
                  <td className="num">{num(r.sharpe)}</td>
                  <td className="num">{pct(r.maxDrawdown)}</td>
                  <td className="num">{money(r.finalNav)}</td>
                  <td className="nowrap">{when(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
