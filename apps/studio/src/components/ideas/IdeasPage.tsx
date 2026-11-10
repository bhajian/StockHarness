// Ideas (#119, #123, #269): the master table of the research loop's ideas, with filters kept in the URL, a card
// view, and multi-select to compare. /ideas/:id opens the idea (IdeaDetail), /ideas/compare?ids= compares 2–4.
import { OPTION_STRUCTURES } from '../../../../../packages/core/src/profiles.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  CircleDashed,
  GitCompare,
  LayoutGrid,
  Rows3,
  Search,
  Telescope,
  XCircle,
  TrendingUp,
} from 'lucide-react';
import { api } from '../../api';
import { KpiCard, Skeleton, Sparkline, StatusPill } from '../kit';
import { TimeSeriesChart } from '../../charts/Charts';
import { IdeaDetail } from './IdeaDetail';
import { IdeaStatus } from './IdeaStatus';
import { go, num, pct, setQuery, useLocation } from './nav';

export function IdeasPage({ isAdmin }: { isAdmin: boolean }) {
  const loc = useLocation();
  const parts = loc.path.split('/').filter(Boolean); // ['ideas', id?, tab?]
  if (parts[1] === 'compare') return <IdeaCompare search={loc.search} />;
  if (parts[1])
    return <IdeaDetail id={decodeURIComponent(parts[1])} tab={parts[2] ?? 'overview'} isAdmin={isAdmin} />;
  return <IdeasList search={loc.search} />;
}

const STATUS_VIEWS: { key: string; label: string; status?: string }[] = [
  { key: 'winners', label: 'Successful & approved', status: 'successful,approved' },
  { key: 'promising', label: 'Promising', status: 'promising' },
  { key: 'progress', label: 'In progress', status: 'in_progress' },
  { key: 'failed', label: 'Failed & rejected', status: 'failed,rejected_untestable,parked' },
  { key: 'all', label: 'All' },
];
const ROW_HEIGHT = 52;

function IdeasList({ search }: { search: string }) {
  const params = new URLSearchParams(search);
  const view = params.get('view') ?? 'table';
  const statusKey = params.get('show') ?? 'winners';
  const sort = params.get('sort') ?? 'dsr';
  const q = params.get('q') ?? '';
  const family = params.get('family') ?? '';
  const side = params.get('side') ?? '';
  const profile = params.get('profile') ?? '';
  const [data, setData] = useState<any>(null);
  const [families, setFamilies] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [typing, setTyping] = useState(q);
  useEffect(() => {
    const status = STATUS_VIEWS.find((v) => v.key === statusKey)?.status;
    const qs = new URLSearchParams({
      sort,
      ...(status ? { status } : {}),
      ...(q ? { q } : {}),
      ...(family ? { family } : {}),
      ...(side ? { side } : {}),
      ...(profile ? { profile } : {}),
      limit: '1000',
    });
    void api(`/ideas?${qs}`).then(setData);
  }, [statusKey, sort, q, family, side, profile]);
  useEffect(() => {
    void api('/ideas?limit=1000').then((all) =>
      setFamilies([...new Set<string>(all.items.map((i: any) => i.family))].sort()),
    );
  }, []);
  useEffect(() => {
    const t = setTimeout(() => typing !== q && setQuery({ q: typing || undefined }), 300);
    return () => clearTimeout(t);
  }, [typing]);
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 4 ? s : [...s, id]));
  if (!data) return <Skeleton rows={10} />;
  const k = data.kpis;
  return (
    <section className="page-section ideas-page">
      <header className="page-head">
        <div>
          <h2>Ideas</h2>
          <p className="muted-line">
            Theories from the research loop. Open one for its proof pack, the Judge&apos;s review, the code
            and every run.
          </p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={selected.length < 2}
          onClick={() => go(`/ideas/compare?ids=${selected.join(',')}`)}
        >
          <GitCompare size={14} /> Compare{selected.length ? ` (${selected.length})` : ''}
        </button>
      </header>
      <div className="kpi-row" aria-label="Idea KPIs">
        <KpiCard
          icon={<CheckCircle2 size={18} />}
          label="Successful"
          value={k.successful}
          footnote="passed every gate"
        />
        <KpiCard
          icon={<TrendingUp size={18} />}
          label="Promising"
          value={k.promising}
          footnote="beat the S&P 500, not proven"
        />
        <KpiCard
          icon={<CheckCircle2 size={18} />}
          label="Approved"
          value={k.approved}
          footnote="by a person"
        />
        <KpiCard icon={<XCircle size={18} />} label="Failed" value={k.failed} footnote="kept, never hidden" />
        <KpiCard icon={<CircleDashed size={18} />} label="In progress" value={k.inProgress} />
        <KpiCard
          icon={<Telescope size={18} />}
          label="Forward only"
          value={k.forwardOnly}
          footnote="paper tracking"
        />
      </div>
      <div className="filter-bar" role="toolbar" aria-label="Filters">
        <div className="segmented" role="radiogroup" aria-label="Show">
          {STATUS_VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              role="radio"
              aria-checked={statusKey === v.key}
              className={statusKey === v.key ? 'active' : ''}
              onClick={() => setQuery({ show: v.key === 'winners' ? undefined : v.key })}
            >
              {v.label}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={14} />
          <input
            aria-label="Search ideas"
            placeholder="Search title, hypothesis or T-n"
            value={typing}
            onChange={(e) => setTyping(e.target.value)}
          />
        </label>
        <select
          aria-label="Family"
          value={family}
          onChange={(e) => setQuery({ family: e.target.value || undefined })}
        >
          <option value="">All families</option>
          {families.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <select
          aria-label="Profile"
          value={profile}
          onChange={(e) => setQuery({ profile: e.target.value || undefined, side: undefined })}
        >
          <option value="">Any profile</option>
          <optgroup label="Equity">
            <option value="equity_long">Long</option>
            <option value="equity_short">Short</option>
            <option value="equity_long_short">Long / short</option>
          </optgroup>
          <optgroup label="Options">
            <option value="options">Any options idea</option>
            {Object.entries(OPTION_STRUCTURES).map(([id, o]) => (
              <option key={id} value={`options_${id}`}>
                {o.label}
              </option>
            ))}
          </optgroup>
        </select>
        <select
          aria-label="Sort"
          value={sort}
          onChange={(e) => setQuery({ sort: e.target.value === 'dsr' ? undefined : e.target.value })}
        >
          <option value="dsr">Deflated Sharpe</option>
          <option value="sharpe">Sharpe</option>
          <option value="excess">Excess / year</option>
          <option value="recent">Most recent</option>
        </select>
        <div className="segmented" role="radiogroup" aria-label="View">
          <button
            type="button"
            role="radio"
            aria-checked={view === 'table'}
            aria-label="Table view"
            className={view === 'table' ? 'active' : ''}
            onClick={() => setQuery({ view: undefined })}
          >
            <Rows3 size={14} />
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={view === 'cards'}
            aria-label="Card view"
            className={view === 'cards' ? 'active' : ''}
            onClick={() => setQuery({ view: 'cards' })}
          >
            <LayoutGrid size={14} />
          </button>
        </div>
      </div>
      <p className="muted-line" aria-live="polite">
        {data.total} {data.total === 1 ? 'idea' : 'ideas'}
        {selected.length ? ` · ${selected.length} selected for compare (2–4)` : ''}
      </p>
      {!data.items.length ? (
        <div className="empty-state">
          <p>No ideas match.</p>
          {statusKey === 'winners' && (
            <button type="button" className="link-button" onClick={() => setQuery({ show: 'all' })}>
              Show every idea
            </button>
          )}
        </div>
      ) : view === 'cards' ? (
        <div className="idea-cards">
          {data.items.map((i: any) => (
            <article key={i.id} className="idea-card" onClick={() => go(`/ideas/${i.ref}`)}>
              <header>
                <span className="mono">{i.ref}</span> <IdeaStatus status={i.status} />
                <input
                  type="checkbox"
                  aria-label={`Select ${i.ref}`}
                  checked={selected.includes(i.ref)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggle(i.ref)}
                />
              </header>
              <h3>{i.title}</h3>
              <p className="muted-line">
                {i.profileLabel ?? i.side} · {i.family} · {i.horizonDays}d
              </p>
              {i.spark.length > 1 && <Sparkline values={i.spark} width={240} height={36} />}
              <dl>
                <div>
                  <dt>Sharpe</dt>
                  <dd>{num(i.sharpe)}</dd>
                </div>
                <div>
                  <dt>Deflated</dt>
                  <dd>{pct(i.deflatedSharpe, 0)}</dd>
                </div>
                <div>
                  <dt>Excess/yr</dt>
                  <dd>{pct(i.excessPerYear)}</dd>
                </div>
                <div>
                  <dt>Max DD</dt>
                  <dd>{pct(i.maxDrawdown)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <IdeaTable items={data.items} selected={selected} toggle={toggle} />
      )}
    </section>
  );
}

/** The table, windowed so a thousand ideas scroll smoothly. */
function IdeaTable({
  items,
  selected,
  toggle,
}: {
  items: any[];
  selected: string[];
  toggle: (id: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const height = Math.min(640, items.length * ROW_HEIGHT + 44);
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - 5);
  const last = Math.min(items.length, first + Math.ceil(height / ROW_HEIGHT) + 10);
  const shown = items.slice(first, last);
  return (
    <div
      className="idea-table"
      ref={box}
      style={{ maxHeight: height }}
      onScroll={(e) => setTop((e.target as HTMLDivElement).scrollTop)}
    >
      <table aria-label="Ideas">
        <thead>
          <tr>
            <th aria-label="Select" />
            <th>ID</th>
            <th>Idea</th>
            <th>Status</th>
            <th>Side</th>
            <th>Horizon</th>
            <th className="num">Sharpe</th>
            <th className="num">Deflated</th>
            <th className="num">Excess / yr</th>
            <th className="num">Max DD</th>
            <th>Holdout</th>
            <th>Equity</th>
          </tr>
        </thead>
        <tbody>
          {first > 0 && <tr style={{ height: first * ROW_HEIGHT }} aria-hidden="true" />}
          {shown.map((i) => (
            <tr
              key={i.id}
              className="clickable"
              style={{ height: ROW_HEIGHT }}
              onClick={() => go(`/ideas/${i.ref}`)}
            >
              <td onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label={`Select ${i.ref}`}
                  checked={selected.includes(i.ref)}
                  onChange={() => toggle(i.ref)}
                />
              </td>
              <td className="mono">{i.ref}</td>
              <td>
                <strong>{i.title}</strong>
                <small className="muted-line">
                  {i.profileLabel ? `${i.profileLabel} · ` : ''}
                  {i.family}
                  {i.forwardOnly ? ' · forward only' : ''}
                </small>
              </td>
              <td>
                <IdeaStatus status={i.status} />
              </td>
              <td>{i.side.replace('_', ' / ')}</td>
              <td>{i.horizonDays}d</td>
              <td className="num">{num(i.sharpe)}</td>
              <td className="num">{pct(i.deflatedSharpe, 0)}</td>
              <td className="num">{pct(i.excessPerYear)}</td>
              <td className="num">{pct(i.maxDrawdown)}</td>
              <td>
                {i.holdout ? (
                  <StatusPill
                    status={
                      i.holdout.status === 'succeeded'
                        ? i.holdout.excess > 0
                          ? 'ok'
                          : 'failed'
                        : i.holdout.status
                    }
                    label={
                      i.holdout.status === 'succeeded'
                        ? `${num(i.holdout.sharpe)} · ${pct(i.holdout.excess)}`
                        : i.holdout.status
                    }
                  />
                ) : (
                  <span className="muted-line">—</span>
                )}
              </td>
              <td>
                {i.spark.length > 1 ? <Sparkline values={i.spark} /> : <span className="muted-line">—</span>}
              </td>
            </tr>
          ))}
          {last < items.length && (
            <tr style={{ height: (items.length - last) * ROW_HEIGHT }} aria-hidden="true" />
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Compare 2–4 ideas (#123): equity overlay, metrics with the best per row highlighted, correlation, holdings overlap. */
function IdeaCompare({ search }: { search: string }) {
  const ids = (new URLSearchParams(search).get('ids') ?? '').split(',').filter(Boolean);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/ideas/compare?ids=${ids.join(',')}`)
      .then(setData)
      .catch((e) => setError(e?.message ?? String(e)));
  }, [search]);
  const rows: [string, string, (v: any) => string, 'max' | 'min'][] = [
    ['cagr', 'CAGR', (v) => pct(v), 'max'],
    ['sharpe', 'Sharpe', (v) => num(v), 'max'],
    ['sortino', 'Sortino', (v) => num(v), 'max'],
    ['deflatedSharpe', 'Deflated Sharpe', (v) => pct(v, 0), 'max'],
    ['excessPerYear', 'Excess / year', (v) => pct(v), 'max'],
    ['maxDrawdown', 'Max drawdown', (v) => pct(v), 'max'],
    ['alphaT', 'Alpha t-stat', (v) => num(v), 'max'],
    ['trades', 'Trades', (v) => (v ?? '—').toString(), 'max'],
    ['annualTurnover', 'Turnover / year', (v) => (typeof v === 'number' ? `${v.toFixed(1)}×` : '—'), 'min'],
  ];
  const best = useMemo(() => {
    if (!data) return {};
    return Object.fromEntries(
      rows.map(([key, , , dir]) => {
        const vals = data.metrics.map((m: any) => m[key]).filter((v: any) => typeof v === 'number');
        return [key, vals.length ? (dir === 'max' ? Math.max(...vals) : Math.min(...vals)) : null];
      }),
    );
  }, [data]);
  if (error) return <p className="error-line">{error}</p>;
  if (!data) return <Skeleton rows={8} />;
  const refs = data.metrics.map((m: any) => m.ref);
  const shade = (v: number | null) =>
    v === null ? undefined : { background: `rgba(57, 135, 229, ${Math.abs(v) * 0.35})` };
  return (
    <section className="page-section ideas-page">
      <nav className="breadcrumbs" aria-label="Breadcrumbs">
        <button type="button" className="link-button" onClick={() => go('/ideas')}>
          Ideas
        </button>{' '}
        › Compare {refs.join(', ')}
      </nav>
      <h2>Compare {refs.length} ideas</h2>
      <TimeSeriesChart title="Equity" subtitle="Growth of 1, after costs" data={data.equity} />
      <div className="eval-grid">
        <div className="table-wrap">
          <table aria-label="Metrics">
            <thead>
              <tr>
                <th>Metric</th>
                {data.ideas.map((i: any) => (
                  <th key={i.id}>
                    <button type="button" className="link-button" onClick={() => go(`/ideas/${i.ref}`)}>
                      {i.ref}
                    </button>
                    <small className="muted-line">{i.title}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(([key, label, fmt]) => (
                <tr key={key}>
                  <td>{label}</td>
                  {data.metrics.map((m: any) => (
                    <td
                      key={m.ref}
                      className={`num${m[key] !== null && m[key] === best[key] ? ' best' : ''}`}
                    >
                      {fmt(m[key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="matrix-pair">
          {[
            ['Return correlation', data.correlation],
            ['Holdings overlap', data.holdingsOverlap],
          ].map(([title, m]: any) => (
            <div key={title} className="table-wrap">
              <table aria-label={title}>
                <caption>{title}</caption>
                <thead>
                  <tr>
                    <th />
                    {refs.map((r: string) => (
                      <th key={r}>{r}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {m.map((row: (number | null)[], i: number) => (
                    <tr key={refs[i]}>
                      <th>{refs[i]}</th>
                      {row.map((v, j) => (
                        <td key={j} className="num" style={shade(v)}>
                          {title === 'Holdings overlap' ? pct(v, 0) : num(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
