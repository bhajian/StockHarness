// Dev-only evaluation pages (#109): /evaluations lists the trusted evaluator's records; /evaluations/:id renders
// one: KPIs, equity vs the S&P 500, drawdown, rolling Sharpe, returns by year, folds, factor exposures, regimes,
// sectors, trades and provenance. Linked from evaluate_strategy results; not in the main navigation (M5 builds
// the Ideas pages on the same record).
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Activity, AlertTriangle, BarChart3, Gauge, TrendingDown, TrendingUp } from 'lucide-react';
import { api } from '../api';
import { KpiCard, Skeleton, StatusPill } from './kit';
import { PagedRows, rankOf, SortHead, SortTh, useSort } from './tableKit';
import { BarChart, TimeSeriesChart } from '../charts/Charts';
import { fmtNumber } from '../charts/chartData';
import { ObjectTransfer } from './ObjectTransfer';
import { Empty } from './ui';
import { SubsetPanel, SubsetResult } from './SubsetPanel';
import { scopeLabel } from './evaluationScope';

type Evaluation = {
  id: string;
  pluginName: string;
  pluginVersion: number;
  codeHash: string;
  theoryId?: string;
  mode: 'explore' | 'holdout';
  trial: number;
  status: 'running' | 'succeeded' | 'failed';
  params: { start: string; end: string; symbols?: string[]; universe?: { top_by_market_cap?: number } };
  error?: { type?: string; message: string; problems?: string[]; frames?: any[] };
  record?: Record<string, any>;
  createdAt: string;
  durationMs?: number;
  /** #325: a name subset of this evaluation. */
  subsetOf?: string;
};

const pct = (v: unknown, digits = 1) =>
  typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '—';
const num = (v: unknown, digits = 2) =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';
const go = (path: string) => {
  history.pushState({}, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
};

export function EvaluationsPage() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  const id = path.split('/')[2];
  return id ? <EvaluationDetail id={id} /> : <EvaluationList />;
}

function EvaluationList() {
  const [data, setData] = useState<{ trials: number; items: Evaluation[] } | null>(null);
  useEffect(() => {
    void api('/evaluations').then(setData);
  }, []);
  // Click a header to sort (#385); unsorted, newest first.
  const { sorted, sort, toggle } = useSort(data?.items ?? [], {
    started: { value: (e) => new Date(e.createdAt), firstDesc: true },
    plugin: { value: (e) => `${e.pluginName} v${String(e.pluginVersion).padStart(6, '0')}` },
    period: { value: (e) => e.params.start },
    status: { value: (e) => rankOf(['failed', 'running', 'queued', 'succeeded'])(e.status) },
    cagr: { value: (e) => e.record?.summary?.cagr, firstDesc: true },
    sharpe: { value: (e) => e.record?.summary?.sharpe, firstDesc: true },
    maxdd: { value: (e) => e.record?.summary?.max_drawdown, firstDesc: true },
    trial: { value: (e) => e.trial, firstDesc: true },
  });
  if (!data) return <Skeleton rows={6} />;
  return (
    <section className="page-section">
      <div className="section-heading evaluations-heading">
        <h2>Evaluations</h2>
        <span className="muted-line">
          {data.items.length} shown · {data.trials} trials in this workspace · dev view
        </span>
      </div>
      {!data.items.length && (
        <Empty
          icon={<BarChart3 size={22} />}
          title="No evaluations yet"
          text="The trusted evaluator scores a strategy when the Coder tests one in a research cycle, or when you rerun an idea from its Runs tab. Each run appears here with its period, returns and trial number."
          action={
            <button type="button" className="button secondary" onClick={() => go('/research/lab')}>
              Open Research
            </button>
          }
        />
      )}
      <div className="table-wrap" hidden={!data.items.length}>
        <table aria-label="Evaluations">
          <SortHead
            heads={[
              ['started', 'Started'],
              ['plugin', 'Plugin'],
              ['period', 'Period'],
              ['status', 'Status'],
              ['cagr', 'CAGR'],
              ['sharpe', 'Sharpe'],
              ['maxdd', 'Max DD'],
              ['trial', 'Trial'],
            ]}
            sort={sort}
            toggle={toggle}
          />
          <tbody>
            <PagedRows rows={sorted} resetKey={sort}>
              {(e) => (
                <tr key={e.id} className="clickable" onClick={() => go(`/evaluations/${e.id}`)}>
                  <td>{new Date(e.createdAt).toLocaleString()}</td>
                  <td>
                    {e.pluginName} v{e.pluginVersion}{' '}
                    {e.mode === 'holdout' && <StatusPill status="warn" label="holdout" />}
                  </td>
                  <td>
                    {e.params.start} → {e.params.end}
                  </td>
                  <td>
                    <StatusPill status={e.status === 'succeeded' ? 'succeeded' : e.status} />
                  </td>
                  <td>{pct(e.record?.summary?.cagr)}</td>
                  <td>{num(e.record?.summary?.sharpe)}</td>
                  <td>{pct(e.record?.summary?.max_drawdown)}</td>
                  <td>{e.trial}</td>
                </tr>
              )}
            </PagedRows>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EvaluationDetail({ id }: { id: string }) {
  const [e, setE] = useState<Evaluation | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stop = false;
    const load = () =>
      api<Evaluation>(`/evaluations/${id}`)
        .then((x) => {
          if (stop) return;
          setE(x);
          if (x.status === 'running') setTimeout(load, 3000);
        })
        .catch((err) => setError(String(err?.message ?? err)));
    void load();
    return () => {
      stop = true;
    };
  }, [id]);
  const r = e?.record;
  if (error) return <p className="error-line">{error}</p>;
  if (!e) return <Skeleton rows={8} />;
  return (
    <section className="page-section evaluation-page">
      <div className="section-heading">
        <button type="button" className="link-button" onClick={() => go('/evaluations')}>
          <ArrowLeft size={14} /> Evaluations
        </button>
        <h2>
          {e.pluginName} v{e.pluginVersion}{' '}
          <StatusPill status={e.status === 'succeeded' ? 'succeeded' : e.status} />
          {e.mode === 'holdout' && <StatusPill status="warn" label="holdout (one shot)" />}
        </h2>
        <span className="muted-line">
          {e.params.start} → {e.params.end}
          {` · ${scopeLabel(e.params)}`}
          {e.subsetOf ? ' · name subset' : ''} · trial {e.trial} ·{' '}
          <code title={e.codeHash}>{e.codeHash.slice(0, 19)}</code>
          {r && ` · evaluator ${r.evaluator_version} · prices as of ${r.data_snapshot?.prices_as_of ?? '—'}`}
        </span>
        <ObjectTransfer kinds={['Evaluation']} names={[e.id]} onImported={() => undefined} compact />
      </div>
      {e.status === 'running' && <Skeleton rows={4} />}
      {e.status === 'failed' && (
        <div className="notice error-notice" role="alert">
          <AlertTriangle size={16} />
          <div>
            <strong>{e.error?.type ?? 'Error'}</strong>: {e.error?.message}
            {e.error?.problems && (
              <ul>
                {e.error.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            {e.error?.frames?.map((f, i) => (
              <div key={i} className="mono">
                {f.line ? `line ${f.line} in ${f.function}: ${f.code}` : f.stderr}
              </div>
            ))}
          </div>
        </div>
      )}
      {r?.subset && (
        <div className="card-panel subset-panel">
          <h3>Name subset</h3>
          <SubsetResult record={r} />
          {e.subsetOf && (
            <button type="button" className="link-button" onClick={() => go(`/evaluations/${e.subsetOf}`)}>
              The evaluation it was picked from
            </button>
          )}
        </div>
      )}
      {e.status === 'succeeded' && e.mode === 'explore' && !e.subsetOf && <SubsetPanel evaluationId={e.id} />}
      {r && <EvaluationReport record={r} />}
    </section>
  );
}

/**
 * The proof pack of one evaluation record: KPIs, equity against the S&P 500, drawdown, rolling Sharpe, return by
 * year, trade returns, folds, factor exposures, regimes, sector contributions and provenance. Shared by the
 * evaluation page and the idea's Results tab (#120).
 */
export function EvaluationReport({ record: r }: { record: Record<string, any> }) {
  const series = r?.series;
  const charts = useMemo(() => {
    if (!series) return null;
    const s = series.series;
    return {
      equity: { dates: series.dates, series: { Strategy: s.equity, 'S&P 500': s.spx_equity } },
      drawdown: { dates: series.dates, series: { Drawdown: s.drawdown } },
      rolling: { dates: series.dates, series: { 'Rolling Sharpe (126d)': s.rolling_sharpe_126 } },
    };
  }, [series]);
  if (!charts) return null;
  const sm = r?.summary ?? {};
  const folds: any[] = r?.folds ?? [];
  const betas: Record<string, number> = r?.factors?.betas ?? {};
  const tstats: Record<string, number> = r?.factors?.t ?? {};
  const hist = r?.trade_stats?.histogram;
  return (
    <div className="evaluation-report">
      <div className="kpi-row" aria-label="Key metrics">
        <KpiCard
          icon={<TrendingUp size={18} />}
          label="CAGR"
          value={pct(sm.cagr)}
          footnote={`total ${pct(sm.total_return)}`}
        />
        <KpiCard
          icon={<Gauge size={18} />}
          label="Sharpe"
          value={num(sm.sharpe)}
          footnote={`Sortino ${num(sm.sortino)}`}
        />
        <KpiCard
          icon={<TrendingDown size={18} />}
          label="Max drawdown"
          value={pct(sm.max_drawdown)}
          footnote={`Calmar ${num(sm.calmar)}`}
        />
        <KpiCard
          icon={<Activity size={18} />}
          label="Hit rate"
          value={pct(sm.hit_rate)}
          footnote={`${sm.trades} trades · ${num(sm.annual_turnover, 1)}× turnover/yr`}
        />
        <KpiCard
          icon={<BarChart3 size={18} />}
          label="Excess vs S&P 500"
          value={pct(r.excess?.spx?.excess_cagr)}
          footnote={`IR ${num(r.excess?.spx?.information_ratio)}${r.excess?.sector ? ` · vs sector ${pct(r.excess.sector.excess_cagr)}` : ''}`}
        />
        <KpiCard
          icon={<Gauge size={18} />}
          label="Deflated Sharpe"
          value={pct(r.trial_context?.dsr, 0)}
          footnote={`over ${r.trial_context?.trials ?? '?'} trials`}
        />
      </div>
      {(r.warnings ?? []).map((w: any) => (
        <p key={w.code} className="schedule-warning">
          <StatusPill status="warn" label={w.code} /> {w.count} · {w.hint}
        </p>
      ))}
      <TimeSeriesChart
        title="Equity"
        subtitle="Growth of 1, after costs"
        data={charts.equity}
        group="evaluation"
      />
      <div className="eval-grid">
        <TimeSeriesChart
          title="Drawdown"
          data={charts.drawdown}
          group="evaluation"
          presets={false}
          logToggle={false}
          height={220}
        />
        <TimeSeriesChart
          title="Rolling Sharpe"
          data={charts.rolling}
          group="evaluation"
          presets={false}
          logToggle={false}
          height={220}
          empty="A rolling Sharpe needs 126 sessions of returns; this window is shorter."
        />
      </div>
      <div className="eval-grid">
        <BarChart
          title="Return by year"
          categories={folds.map((f) => f.fold)}
          series={{ Return: folds.map((f) => f.total_return) }}
          height={220}
        />
        {hist && (
          <BarChart
            title="Trade returns"
            subtitle={`${r.trade_stats.count} trades · win rate ${pct(r.trade_stats.win_rate, 0)} · median ${pct(r.trade_stats.median)}`}
            categories={hist.counts.map(
              (_: number, i: number) => `${pct(hist.edges[i], 0)}…${pct(hist.edges[i + 1], 0)}`,
            )}
            series={{ Trades: hist.counts }}
            height={220}
          />
        )}
      </div>
      <div className="eval-grid">
        <div className="table-wrap">
          {' '}
          <FoldsTable folds={folds} />
        </div>
        <div className="table-wrap">
          {' '}
          <FactorsTable factors={r.factors} betas={betas} tstats={tstats} />
        </div>
      </div>
      <div className="eval-grid">
        <div className="table-wrap">
          {' '}
          <RegimesTable byRegime={r.by_regime ?? {}} />
        </div>
        <BarChart
          title="Contribution by sector"
          categories={(r.by_sector ?? []).map((x: any) => x.sector)}
          series={{ Contribution: (r.by_sector ?? []).map((x: any) => x.contribution) }}
          horizontal
          height={Math.max(160, 26 * (r.by_sector ?? []).length)}
        />
      </div>
      {r.by_name?.rows?.length ? <ByNameTable byName={r.by_name} /> : null}
      <details className="provenance">
        <summary>Provenance</summary>
        <pre>
          {JSON.stringify(
            {
              record_hash: r.record_hash,
              plugin: r.plugin,
              params: r.params,
              costs: r.costs,
              period: r.period,
              data_snapshot: r.data_snapshot,
              reader: r.reader,
              holdings: r.holdings,
            },
            null,
            1,
          )}
        </pre>
      </details>
      <p className="muted-line">
        {fmtNumber(series.dates.length)} trading days · {r.rebalances?.length} rebalances
      </p>
    </div>
  );
}

type NameRow = {
  security_id: string;
  ticker?: string | null;
  sector?: string;
  contribution: number;
  days_long: number;
  days_short: number;
  avg_weight: number;
  trades: number;
  hit_rate: number | null;
  avg_trade_return: number | null;
  by_year: Record<string, number>;
};
/** How each name held did (#324): which of the universe the strategy works for. */
export function ByNameTable({ byName }: { byName: any }) {
  const rows: NameRow[] = byName.rows ?? [];
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const years = useMemo(() => [...new Set(rows.flatMap((x) => Object.keys(x.by_year ?? {})))].sort(), [rows]);
  const filtered = useMemo(() => {
    const f = q.trim().toLowerCase();
    return rows.filter(
      (x) => !f || `${x.ticker ?? ''} ${x.sector ?? ''} ${x.security_id}`.toLowerCase().includes(f),
    );
  }, [rows, q]);
  // Every column sorts (#385); numbers start with the largest. Best contribution first by default.
  const {
    sorted: shown,
    sort,
    toggle,
  } = useSort(
    filtered,
    {
      name: { value: (x) => x.ticker ?? x.security_id },
      sector: { value: (x) => x.sector },
      contribution: { value: (x) => x.contribution, firstDesc: true },
      ...Object.fromEntries(
        years.map((y) => [`y${y}`, { value: (x: NameRow) => x.by_year?.[y], firstDesc: true }]),
      ),
      trades: { value: (x) => x.trades, firstDesc: true },
      hit_rate: { value: (x) => x.hit_rate, firstDesc: true },
      avg_trade_return: { value: (x) => x.avg_trade_return, firstDesc: true },
      avg_weight: { value: (x) => x.avg_weight, firstDesc: true },
      days: { value: (x) => x.days_long + x.days_short, firstDesc: true },
    },
    { by: 'contribution', desc: true },
  );
  const head = (id: string, label: string) => (
    <SortTh key={id} id={id} sort={sort} onSort={toggle}>
      {label}
    </SortTh>
  );
  const limit = all ? shown.length : 25;
  return (
    <section className="by-name" aria-label="Results by name">
      <div className="by-name-head">
        <h3>Results by name</h3>
        <p className="muted-line">
          {fmtNumber(byName.names)} names held · {fmtNumber(byName.positive)} added to the return,{' '}
          {fmtNumber(byName.negative)} took away
          {byName.top_decile_share_of_gains != null
            ? ` · the best 10% of names made ${pct(byName.top_decile_share_of_gains, 0)} of the gains`
            : ''}
          {byName.truncated ? ` · showing the best and worst ${fmtNumber(rows.length / 2)}` : ''}.
          Contribution is before costs.
        </p>
        <input
          type="search"
          placeholder="Find a ticker or sector"
          aria-label="Find a ticker or sector"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="table-wrap">
        <table aria-label="Results by name">
          <thead>
            <tr>
              {head('name', 'Name')}
              {head('sector', 'Sector')}
              {head('contribution', 'Contribution')}
              {years.map((y) => head(`y${y}`, y))}
              {head('trades', 'Trades')}
              {head('hit_rate', 'Hit rate')}
              {head('avg_trade_return', 'Avg trade')}
              {head('avg_weight', 'Avg weight')}
              {head('days', 'Days held')}
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((x) => (
              <tr key={x.security_id}>
                <td title={x.security_id}>
                  <strong>{x.ticker ?? x.security_id}</strong>
                </td>
                <td>{x.sector}</td>
                <td className={x.contribution >= 0 ? 'pos' : 'neg'}>{pct(x.contribution, 2)}</td>
                {years.map((y) => (
                  <td key={y}>{x.by_year?.[y] != null ? pct(x.by_year[y], 2) : '—'}</td>
                ))}
                <td>{x.trades}</td>
                <td>{x.hit_rate != null ? pct(x.hit_rate, 0) : '—'}</td>
                <td>{x.avg_trade_return != null ? pct(x.avg_trade_return) : '—'}</td>
                <td>{pct(x.avg_weight, 2)}</td>
                <td>
                  {x.days_long + x.days_short}
                  {x.days_short ? ` (${x.days_short} short)` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length > 25 ? (
        <button type="button" className="button secondary small" onClick={() => setAll((v) => !v)}>
          {all ? 'Show the first 25' : `Show all ${fmtNumber(shown.length)}`}
        </button>
      ) : null}
    </section>
  );
}

// --- Sortable detail tables (#385) ---------------------------------------------------------------------
function FoldsTable({ folds }: { folds: any[] }) {
  const { sorted, sort, toggle } = useSort(folds, {
    fold: { value: (f) => String(f.fold) },
    ret: { value: (f) => f.total_return, firstDesc: true },
    sharpe: { value: (f) => f.sharpe, firstDesc: true },
    maxdd: { value: (f) => f.max_drawdown, firstDesc: true },
    days: { value: (f) => f.days, firstDesc: true },
  });
  return (
    <table aria-label="Walk-forward folds">
      <caption>Walk-forward folds (by calendar year)</caption>
      <SortHead
        heads={[
          ['fold', 'Fold'],
          ['ret', 'Return'],
          ['sharpe', 'Sharpe'],
          ['maxdd', 'Max DD'],
          ['days', 'Days'],
        ]}
        sort={sort}
        toggle={toggle}
      />
      <tbody>
        {sorted.map((f) => (
          <tr key={f.fold}>
            <td>
              {f.fold}
              {f.partial ? ' (partial)' : ''}
            </td>
            <td>{pct(f.total_return)}</td>
            <td>{num(f.sharpe)}</td>
            <td>{pct(f.max_drawdown)}</td>
            <td>{f.days}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FactorsTable({
  factors,
  betas,
  tstats,
}: {
  factors: any;
  betas: Record<string, number>;
  tstats: Record<string, number>;
}) {
  const { sorted, sort, toggle } = useSort(Object.keys(betas), {
    factor: { value: (k) => k },
    beta: { value: (k) => betas[k], firstDesc: true },
    t: { value: (k) => tstats[k], firstDesc: true },
  });
  return (
    <table aria-label="Factor exposures">
      <caption>
        Factor exposures · alpha {pct(factors?.alpha_annual)} a year (t {num(factors?.alpha_t)}) · R²{' '}
        {num(factors?.r2)}
      </caption>
      <SortHead
        heads={[
          ['factor', 'Factor'],
          ['beta', 'Beta'],
          ['t', 't (Newey-West)'],
        ]}
        sort={sort}
        toggle={toggle}
      />
      <tbody>
        {sorted.map((k) => (
          <tr key={k}>
            <td>{k}</td>
            <td>{num(betas[k])}</td>
            <td>{num(tstats[k])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RegimesTable({ byRegime }: { byRegime: Record<string, Record<string, any>> }) {
  const rows = Object.entries(byRegime).flatMap(([g, rs]) =>
    Object.entries(rs).map(([k, v]) => ({
      key: `${g}-${k}`,
      label: g === 'trend' ? `S&P 500 trend ${k}` : `VIX ${k}`,
      ...v,
    })),
  );
  const { sorted, sort, toggle } = useSort(rows, {
    regime: { value: (x) => x.label },
    days: { value: (x) => x.days, firstDesc: true },
    ret: { value: (x) => x.total_return, firstDesc: true },
    sharpe: { value: (x) => x.sharpe, firstDesc: true },
  });
  return (
    <table aria-label="Regimes">
      <caption>By regime</caption>
      <SortHead
        heads={[
          ['regime', 'Regime'],
          ['days', 'Days'],
          ['ret', 'Return'],
          ['sharpe', 'Sharpe'],
        ]}
        sort={sort}
        toggle={toggle}
      />
      <tbody>
        {!sorted.length && (
          <tr>
            <td colSpan={4} className="muted-line">
              No regime split: it needs the S&amp;P 500 trend and VIX columns of macro_daily over this window.
            </td>
          </tr>
        )}
        {sorted.map((x) => (
          <tr key={x.key}>
            <td>{x.label}</td>
            <td>{x.days}</td>
            <td>{pct(x.total_return)}</td>
            <td>{num(x.sharpe)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
