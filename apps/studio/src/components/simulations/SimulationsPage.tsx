// Simulations (#126): the list of runs, a run's own page (/simulations/:id[/tab]) and the schedule modal
// (/simulations?new=T-1,T-2 opens it with those ideas; #125).
import React, { useEffect, useState } from 'react';
import { Plus, Play, Layers } from 'lucide-react';
import { api } from '../../api';
import { Skeleton, StatusPill } from '../kit';
import { PagedRows, rankOf, SortHead, useSort } from '../tableKit';
import { go, num, pct, setQuery, useLocation } from '../ideas/nav';
import { SimulationDetail } from './SimulationDetail';
import { ScheduleModal } from './ScheduleModal';
import { PortfolioBuilder } from './PortfolioBuilder';

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
  const [building, setBuilding] = useState(false);
  // Archived runs (e.g. from before the data fixes) are kept but hidden unless asked for.
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    let stop = false;
    const load = () =>
      api<any[]>(showArchived ? '/simulations?archived=1' : '/simulations').then((r) => {
        if (stop) return;
        setRows(r);
        if (r.some((x) => x.status === 'running')) setTimeout(load, 4000);
      });
    void load();
    return () => {
      stop = true;
    };
  }, [showArchived]);
  // Click a header to sort (#385); unsorted, newest first.
  const { sorted, sort, toggle } = useSort(rows ?? [], {
    name: { value: (r) => r.name },
    ideas: { value: (r) => r.ideas.join(', ') },
    period: { value: (r) => r.period.start },
    status: { value: (r) => rankOf(['failed', 'running', 'queued', 'succeeded'])(r.status) },
    cagr: { value: (r) => r.cagr, firstDesc: true },
    sharpe: { value: (r) => r.sharpe, firstDesc: true },
    maxdd: { value: (r) => r.maxDrawdown, firstDesc: true },
    nav: { value: (r) => r.finalNav, firstDesc: true },
    created: { value: (r) => new Date(r.createdAt), firstDesc: true },
  });
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
          <div className="idea-actions">
            <button type="button" className="button secondary" onClick={() => setBuilding(true)}>
              <Layers size={14} /> Build a portfolio
            </button>
            <button type="button" className="button primary" onClick={() => openSchedule()}>
              <Plus size={14} /> New simulation
            </button>
          </div>
        )}
      </header>
      <label className="muted-line archived-toggle">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />{' '}
        Show archived simulations (kept, hidden: e.g. run before the data fixes)
      </label>
      {building && <PortfolioBuilder onClose={() => setBuilding(false)} />}
      {!rows.length ? (
        <div className="empty-state">
          <p>{showArchived ? 'No archived simulations.' : 'No simulations yet.'}</p>
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
            <SortHead
              heads={[
                ['name', 'Name'],
                ['ideas', 'Ideas'],
                ['period', 'Period'],
                ['status', 'Status'],
                ['cagr', 'CAGR', 'num'],
                ['sharpe', 'Sharpe', 'num'],
                ['maxdd', 'Max DD', 'num'],
                ['nav', 'Final NAV', 'num'],
                ['created', 'Created'],
              ]}
              sort={sort}
              toggle={toggle}
            />
            <tbody>
              <PagedRows rows={sorted} resetKey={sort}>
                {(r) => (
                  <tr key={r.id} className="clickable" onClick={() => go(`/simulations/${r.id}`)}>
                    <td>
                      <strong>{r.name}</strong>{' '}
                      {r.label && (
                        <StatusPill
                          status={r.label === 'successful' ? 'succeeded' : 'warn'}
                          label={r.auto ? `${r.label} · automatic` : r.label}
                        />
                      )}
                      {r.usesHoldout && <small className="muted-line">uses the holdout</small>}
                      {r.archived && <small className="muted-line">archived: {r.archived.reason}</small>}
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
                )}
              </PagedRows>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
