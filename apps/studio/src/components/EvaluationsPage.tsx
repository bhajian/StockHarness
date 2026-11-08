// Dev-only evaluation pages (#109): /evaluations lists the trusted evaluator's records; /evaluations/:id renders
// one: KPIs, equity vs the S&P 500, drawdown, rolling Sharpe, returns by year, folds, factor exposures, regimes,
// sectors, trades and provenance. Linked from evaluate_strategy results; not in the main navigation (M5 builds
// the Ideas pages on the same record).
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Activity, AlertTriangle, BarChart3, Gauge, TrendingDown, TrendingUp } from 'lucide-react';
import { api } from '../api';
import { KpiCard, Skeleton, StatusPill } from './kit';
import { BarChart, TimeSeriesChart } from '../charts/Charts';
import { fmtNumber } from '../charts/chartData';
import { ObjectTransfer } from './ObjectTransfer';

type Evaluation = {
  id: string;
  pluginName: string;
  pluginVersion: number;
  codeHash: string;
  theoryId?: string;
  mode: 'explore' | 'holdout';
  trial: number;
  status: 'running' | 'succeeded' | 'failed';
  params: { start: string; end: string; symbols?: string[] };
  error?: { type?: string; message: string; problems?: string[]; frames?: any[] };
  record?: Record<string, any>;
  createdAt: string;
  durationMs?: number;
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
  if (!data) return <Skeleton rows={6} />;
  return (
    <section className="page-section">
      <div className="section-heading evaluations-heading">
        <h2>Evaluations</h2>
        <span className="muted-line">
          {data.items.length} shown · {data.trials} trials in this workspace · dev view
        </span>
      </div>
      <div className="table-wrap">
        {' '}
        <table aria-label="Evaluations">
          <thead>
            <tr>
              <th>Started</th>
              <th>Plugin</th>
              <th>Period</th>
              <th>Status</th>
              <th>CAGR</th>
              <th>Sharpe</th>
              <th>Max DD</th>
              <th>Trial</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((e) => (
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
            ))}
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
          {e.params.symbols ? ` · ${e.params.symbols.length} symbols` : ' · whole universe'} · trial {e.trial}{' '}
          · <code title={e.codeHash}>{e.codeHash.slice(0, 19)}</code>
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
          <table aria-label="Walk-forward folds">
            <caption>Walk-forward folds (by calendar year)</caption>
            <thead>
              <tr>
                <th>Fold</th>
                <th>Return</th>
                <th>Sharpe</th>
                <th>Max DD</th>
                <th>Days</th>
              </tr>
            </thead>
            <tbody>
              {folds.map((f) => (
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
        </div>
        <div className="table-wrap">
          {' '}
          <table aria-label="Factor exposures">
            <caption>
              Factor exposures · alpha {pct(r.factors?.alpha_annual)} a year (t {num(r.factors?.alpha_t)}) ·
              R² {num(r.factors?.r2)}
            </caption>
            <thead>
              <tr>
                <th>Factor</th>
                <th>Beta</th>
                <th>t (Newey-West)</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(betas).map((k) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{num(betas[k])}</td>
                  <td>{num(tstats[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="eval-grid">
        <div className="table-wrap">
          {' '}
          <table aria-label="Regimes">
            <caption>By regime</caption>
            <thead>
              <tr>
                <th>Regime</th>
                <th>Days</th>
                <th>Return</th>
                <th>Sharpe</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(r.by_regime ?? {}).flatMap(([g, rows]: [string, any]) =>
                Object.entries(rows).map(([k, v]: [string, any]) => (
                  <tr key={`${g}-${k}`}>
                    <td>{g === 'trend' ? `S&P 500 trend ${k}` : `VIX ${k}`}</td>
                    <td>{v.days}</td>
                    <td>{pct(v.total_return)}</td>
                    <td>{num(v.sharpe)}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
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
const NAME_SORTS: Record<string, { label: string; key: (x: NameRow) => number }> = {
  contribution: { label: 'Contribution', key: (x) => x.contribution },
  trades: { label: 'Trades', key: (x) => x.trades },
  hit_rate: { label: 'Hit rate', key: (x) => x.hit_rate ?? -1 },
  avg_trade_return: { label: 'Avg trade', key: (x) => x.avg_trade_return ?? -Infinity },
  days: { label: 'Days held', key: (x) => x.days_long + x.days_short },
};
/** How each name held did (#324): which of the universe the strategy works for. */
export function ByNameTable({ byName }: { byName: any }) {
  const rows: NameRow[] = byName.rows ?? [];
  const [sort, setSort] = useState<{ by: string; desc: boolean }>({ by: 'contribution', desc: true });
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const years = useMemo(() => [...new Set(rows.flatMap((x) => Object.keys(x.by_year ?? {})))].sort(), [rows]);
  const shown = useMemo(() => {
    const f = q.trim().toLowerCase();
    const k = NAME_SORTS[sort.by].key;
    return rows
      .filter((x) => !f || `${x.ticker ?? ''} ${x.sector ?? ''} ${x.security_id}`.toLowerCase().includes(f))
      .sort((a, b) => (sort.desc ? k(b) - k(a) : k(a) - k(b)));
  }, [rows, q, sort]);
  const head = (id: string) => (
    <th aria-sort={sort.by === id ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button
        type="button"
        className="th-sort"
        onClick={() => setSort((s) => ({ by: id, desc: s.by === id ? !s.desc : true }))}
      >
        {NAME_SORTS[id].label}
        {sort.by === id ? (sort.desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
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
              <th>Name</th>
              <th>Sector</th>
              {head('contribution')}
              {years.map((y) => (
                <th key={y}>{y}</th>
              ))}
              {head('trades')}
              {head('hit_rate')}
              {head('avg_trade_return')}
              <th>Avg weight</th>
              {head('days')}
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
        <button type="button" className="btn ghost" onClick={() => setAll((v) => !v)}>
          {all ? 'Show the first 25' : `Show all ${fmtNumber(shown.length)}`}
        </button>
      ) : null}
    </section>
  );
}
