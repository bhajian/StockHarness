// Datasets → Health (#86): freshness of every collection, coverage, a gap strip of the expected sessions (hollow
// cells are missing days), DQ issues and caveats, failed syncs and transforms, pipelines' latest runs.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, GitBranch, Layers, RefreshCw, XCircle } from 'lucide-react';
import { type DataHealth, type HealthRow, fetchDataHealth, fetchGaps, resolveDrift, timestamp } from '../api';
import type { DatasetsRoute } from '../datasetsRoute';
import { Button } from './ui';
import { KpiCard, Skeleton, StatusPill } from './kit';
import { PagedRows, SortTh, useSort } from './tableKit';
import { fmtNumber } from '../charts/chartData';

type Go = (r: DatasetsRoute) => void;
const PILL = { fresh: 'fresh', stale: 'stale', failed: 'failed', unknown: 'pending' } as const;
const ORDER = { failed: 0, stale: 1, unknown: 2, fresh: 3 };

function GapStrip({ cells }: { cells: { date: string; rows: number | null; partial?: boolean }[] }) {
  const missing = cells.filter((c) => !c.rows).length;
  const partial = cells.filter((c) => c.partial).length;
  return (
    <span
      className="gap-strip"
      role="img"
      aria-label={`${missing} missing and ${partial} partial of ${cells.length} sessions`}
    >
      {cells.map((c) => (
        <i
          key={c.date}
          className={!c.rows ? 'gap' : c.partial ? 'partial' : 'has'}
          title={`${c.date}: ${c.rows ? `${c.rows.toLocaleString()} rows${c.partial ? ' (far fewer than usual)' : ''}` : 'no rows'}`}
        />
      ))}
    </span>
  );
}

function GapCell({ row }: { row: HealthRow }) {
  const [cells, setCells] = useState(row.gaps);
  const [computing, setComputing] = useState(false);
  useEffect(() => {
    if (!computing) return;
    const t = setInterval(
      () =>
        void fetchGaps(row.collection).then((g) => {
          if (g) {
            setCells(g.cells);
            setComputing(false);
          }
        }),
      3000,
    );
    return () => clearInterval(t);
  }, [computing, row.collection]);
  if (cells) return <GapStrip cells={cells} />;
  // Gaps are about trading sessions: weekly, monthly, period-end and feed data have none (#395).
  if (row.gapsApplicable === false) return <span className="muted-line">not daily</span>;
  return (
    <Button
      variant="ghost"
      onClick={() => setComputing(true)}
      disabled={computing}
      title="Aggregate rows per day for this collection"
    >
      {computing ? 'Computing…' : 'Compute gaps'}
    </Button>
  );
}

export function HealthTab({ go, isAdmin = false }: { go: Go; isAdmin?: boolean }) {
  const [h, setH] = useState<DataHealth | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'issues'>('issues');
  const load = useCallback(async () => {
    try {
      setH(await fetchDataHealth());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60000);
    return () => clearInterval(t);
  }, [load]);
  const rows = useMemo(
    () =>
      (h?.collections ?? [])
        .filter(
          (r) =>
            filter === 'all' ||
            r.freshness !== 'fresh' ||
            (r.dq.research ? r.dq.research.error : r.dq.error) ||
            (r.gaps ?? []).some((c) => !c.rows || c.partial),
        )
        .sort(
          (a, b) =>
            ORDER[a.freshness] - ORDER[b.freshness] ||
            (a.layer ?? 9) - (b.layer ?? 9) ||
            a.collection.localeCompare(b.collection),
        ),
    [h, filter],
  );
  // Click a header to sort (#385); unsorted, the table keeps its worst-first order.
  const table = useSort(rows, {
    collection: { value: (r) => r.collection },
    layer: { value: (r) => r.layer },
    freshness: { value: (r) => ORDER[r.freshness] },
    latest: { value: (r) => r.dateMax?.slice(0, 10), firstDesc: true },
    coverage: { value: (r) => r.coveragePct, firstDesc: true },
    gaps: { value: (r) => (r.gaps ? r.gaps.filter((c) => !c.rows).length : null), firstDesc: true },
    issues: { value: (r) => r.dq.error * 1e9 + r.caveats.blocking * 1e6 + r.dq.warn, firstDesc: true },
  });
  const drift = useSort(h?.drift ?? [], {
    collection: { value: (d) => d.collection },
    field: { value: (d) => d.field },
    change: { value: (d) => `${d.breaking ? 0 : 1}${d.kind}` },
    seen: { value: (d) => new Date(d.lastSeenAt), firstDesc: true },
  });
  if (!h) return error ? <div className="notice error">{error}</div> : <Skeleton rows={8} />;
  return (
    <div className="health">
      <div className={`health-banner level-${h.indicator.level}`} role="status">
        {h.indicator.level === 'green' ? (
          <CheckCircle2 size={16} />
        ) : h.indicator.level === 'amber' ? (
          <AlertTriangle size={16} />
        ) : (
          <XCircle size={16} />
        )}
        <strong>{h.indicator.text}</strong>
        <Button variant="ghost" onClick={() => void load()}>
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>
      <div className="kpi-row">
        <KpiCard
          icon={<CheckCircle2 size={18} />}
          label="Fresh"
          value={h.kpis.fresh}
          footnote={`of ${h.collections.length} collections`}
        />
        <KpiCard
          icon={<AlertTriangle size={18} />}
          label="Stale"
          value={h.kpis.stale}
          footnote={h.syncs.late.length ? `${h.syncs.late.length} syncs late` : undefined}
        />
        <KpiCard
          icon={<XCircle size={18} />}
          label="Failed"
          value={h.kpis.failed}
          footnote="collections and transforms"
        />
        <KpiCard
          icon={<Layers size={18} />}
          label="Drift alerts"
          value={h.kpis.drift}
          footnote="schema changes in synced data"
        />
        <KpiCard
          icon={<AlertTriangle size={18} />}
          label="Gaps"
          value={h.kpis.gaps ?? 0}
          footnote="daily series with missing or partial sessions"
        />
        <KpiCard
          icon={<XCircle size={18} />}
          label="DQ errors"
          value={h.kpis.dqResearchErrors ?? 0}
          footnote="on rows in the research universe"
        />
      </div>
      {(h.drift ?? []).length > 0 && (
        <section className="health-drift">
          <h3>
            <Layers size={14} /> Drift alerts
          </h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh id="collection" sort={drift.sort} onSort={drift.toggle}>
                    Collection
                  </SortTh>
                  <SortTh id="field" sort={drift.sort} onSort={drift.toggle}>
                    Field
                  </SortTh>
                  <SortTh id="change" sort={drift.sort} onSort={drift.toggle}>
                    Change
                  </SortTh>
                  <SortTh id="seen" sort={drift.sort} onSort={drift.toggle}>
                    Seen
                  </SortTh>
                  <th />
                </tr>
              </thead>
              <tbody>
                <PagedRows rows={drift.sorted} resetKey={drift.sort}>
                  {(d) => (
                    <tr key={d.id}>
                      <td>
                        <button
                          className="link-button"
                          onClick={() => go({ tab: 'catalog', item: d.collection })}
                          title="Open the collection (Sample shows the rows)"
                        >
                          <code>{d.collection}</code>
                        </button>
                        {d.syncName && <div className="muted-line">{d.syncName}</div>}
                      </td>
                      <td>
                        <code>{d.field}</code>
                      </td>
                      <td>
                        <StatusPill
                          status={d.breaking ? 'blocked' : 'warn'}
                          label={d.kind.replace('_', ' ')}
                        />{' '}
                        <span className="muted-line">{d.detail}</span>
                        {d.breaking && (
                          <div className="muted-line">Breaking: those items were not written</div>
                        )}
                      </td>
                      <td>
                        {d.count}× · {timestamp(d.lastSeenAt)}
                      </td>
                      <td>
                        {isAdmin && (
                          <Button variant="ghost" onClick={() => void resolveDrift(d.id).then(load)}>
                            Resolve
                          </Button>
                        )}
                      </td>
                    </tr>
                  )}
                </PagedRows>
              </tbody>
            </table>
          </div>
        </section>
      )}
      {(h.syncs.failed.length > 0 || h.transforms.some((t) => t.status === 'failed')) && (
        <section className="health-failures">
          <h3>Failing</h3>
          <ul>
            {h.syncs.failed.map((s) => (
              <li key={`s-${s.name}`}>
                <StatusPill status="failed" label="sync" /> <strong>{s.name}</strong>{' '}
                <span className="muted-line">{s.error}</span>
              </li>
            ))}
            {h.transforms
              .filter((t) => t.status === 'failed')
              .map((t) => (
                <li key={`t-${t.name}`}>
                  <StatusPill status="failed" label="transform" />{' '}
                  <button className="link-button" onClick={() => go({ tab: 'transforms', item: t.name })}>
                    <strong>{t.name}</strong>
                  </button>{' '}
                  <span className="muted-line">{t.error}</span>
                </li>
              ))}
          </ul>
        </section>
      )}
      {h.pipelines.length > 0 && (
        <section className="health-pipelines">
          <h3>
            <GitBranch size={14} /> Pipelines
          </h3>
          <ul>
            {h.pipelines.map((p) => (
              <li key={p.name}>
                <StatusPill
                  status={
                    p.blockedAt
                      ? 'blocked'
                      : p.status === 'succeeded'
                        ? 'ok'
                        : p.status === 'running'
                          ? 'running'
                          : p.status
                  }
                  label={p.blockedAt ? 'blocked' : p.status}
                />
                <button className="link-button" onClick={() => go({ tab: 'pipelines', item: p.name })}>
                  <strong>{p.name}</strong>
                </button>
                <span className="muted-line">
                  {p.period}
                  {p.blockedAt ? ` · at ${p.blockedAt} (${p.blockedStatus?.replace('_', ' ')})` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="tab-head">
        <p className="muted-line">
          The gap strip shows the last {h.expected.length} expected NYSE sessions; hollow cells had no rows.
          Freshness uses each source's cadence and how many sessions the data lags.
        </p>
        <span className="chart-presets" role="group" aria-label="Show">
          {(['issues', 'all'] as const).map((f) => (
            <button
              key={f}
              className={`chart-tool${filter === f ? ' active' : ''}`}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f === 'issues' ? 'Needs attention' : 'All collections'}
            </button>
          ))}
        </span>
      </div>
      <div className="table-wrap health-table">
        <table>
          <thead>
            <tr>
              {(
                [
                  ['collection', 'Collection'],
                  ['layer', 'Layer'],
                  ['freshness', 'Freshness'],
                  ['latest', 'Latest'],
                  ['coverage', 'Coverage'],
                  ['gaps', 'Gaps'],
                  ['issues', 'Issues'],
                ] as const
              ).map(([id, label]) => (
                <SortTh key={id} id={id} sort={table.sort} onSort={table.toggle}>
                  {label}
                </SortTh>
              ))}
            </tr>
          </thead>
          <tbody>
            <PagedRows rows={table.sorted} resetKey={table.sort}>
              {(r) => (
                <tr key={r.collection}>
                  <td>
                    <button
                      className="link-button"
                      onClick={() => go({ tab: 'catalog', item: r.collection })}
                    >
                      <code>{r.collection}</code>
                    </button>
                    {r.producer && (
                      <div className="muted-line">
                        {r.producer.type} {r.producer.name}
                      </div>
                    )}
                  </td>
                  <td>{r.layer ? `L${r.layer}` : '—'}</td>
                  <td>
                    <StatusPill status={PILL[r.freshness]} label={r.freshness} />
                    {r.lagSessions ? <div className="muted-line">{r.lagSessions} sessions behind</div> : null}
                  </td>
                  <td>
                    {r.dateMax ? r.dateMax.slice(0, 10) : '—'}
                    {r.lastUpdated && <div className="muted-line">updated {timestamp(r.lastUpdated)}</div>}
                  </td>
                  <td>
                    {r.coveragePct !== undefined ? (
                      <span
                        title={
                          r.coverageListed !== undefined
                            ? `${r.coverageListed}% of listed universe names, ${r.coverageDelisted ?? 0}% of delisted ones (${r.coveragePct}% overall)`
                            : `${r.coveragePct}% of the ${r.coverageBasis === 'active' ? 'listed universe: this data exists for listed companies only' : 'universe'}${r.coverageSparse ? `; ${r.coverageSparse}` : ''}`
                        }
                      >
                        {r.coverageListed ?? r.coveragePct}% <small>listed</small>
                        {r.coverageDelisted !== undefined && (
                          <div className="muted-line">{r.coverageDelisted}% delisted</div>
                        )}
                      </span>
                    ) : (
                      '—'
                    )}
                    {r.coverageSparse && <div className="muted-line">{r.coverageSparse}</div>}
                    <div className="muted-line">{fmtNumber(r.rows)} rows</div>
                  </td>
                  <td>
                    <GapCell row={r} />
                  </td>
                  <td className="health-issues">
                    <div>
                      {/* #428: the research-relevant part leads; flags on rows no strategy can read are muted. */}
                      {(r.dq.research?.error ?? r.dq.error) > 0 && (
                        <StatusPill
                          status="failed"
                          label={`${fmtNumber(r.dq.research?.error ?? r.dq.error)} DQ errors${r.dq.research ? ' in the research universe' : ''}`}
                        />
                      )}
                      {(r.dq.research?.warn ?? r.dq.warn) > 0 && (
                        <StatusPill
                          status="warn"
                          label={`${fmtNumber(r.dq.research?.warn ?? r.dq.warn)} DQ warnings${r.dq.research ? ' in the research universe' : ''}`}
                        />
                      )}
                      {r.dq.research &&
                        r.dq.error + r.dq.warn - r.dq.research.error - r.dq.research.warn > 0 && (
                          <div
                            className="muted-line"
                            title="Flags on rows of securities that were not in the research universe on that date (penny stocks, shells): kept and flagged, never read by strategies"
                          >
                            {fmtNumber(r.dq.error + r.dq.warn - r.dq.research.error - r.dq.research.warn)}{' '}
                            flags outside the research universe
                          </div>
                        )}
                      {r.caveats.blocking > 0 && (
                        <span title="FMP keeps no history of this data: it exists from the first sync on, so backtests cannot use it before then (strategies on it are paper-tracked forward). A fact of the source, not a defect; agents see the full caveat.">
                          <StatusPill status="outline" label="forward-only" />
                        </span>
                      )}
                      {r.error && (
                        <span className="muted-line" title={r.error}>
                          {r.error.slice(0, 60)}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </PagedRows>
            {!rows.length && (
              <tr>
                <td colSpan={7} className="muted-line">
                  Nothing needs attention.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The top-bar indicator: polls the health summary; clicking opens Datasets → Health. */
export function DataFreshness({ onOpen }: { onOpen: () => void }) {
  const [ind, setInd] = useState<DataHealth['indicator'] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void fetchDataHealth(20).then(
        (h) => alive && setInd(h.indicator),
        () => undefined,
      );
    load();
    const t = setInterval(load, 5 * 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!ind) return null;
  return (
    <button className={`data-freshness level-${ind.level}`} onClick={onOpen} title="Open Datasets → Health">
      <i />
      {ind.text}
    </button>
  );
}
