// One simulation (#126): header (ideas, period, actions), then tabs bound to the URL — Performance (equity against
// the S&P 500, drawdown, exposure, monthly returns, rolling Sharpe), Trades (the blotter; a trade's drawer has its
// entry signal, fills and the price around it), Positions (the book as of any session), Attribution (P&L by idea,
// sector, side, exit reason, holding period; calibration by signal rank) and Config (the frozen inputs).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Copy,
  Download,
  LineChart,
  ListOrdered,
  PieChart,
  Radio,
  Settings2,
  Trash2,
} from 'lucide-react';
import { api } from '../../api';
import { Drawer, KpiCard, Skeleton, StatusPill, Tabs } from '../kit';
import { BarChart, HeatmapChart, TimeSeriesChart } from '../../charts/Charts';
import { go, num, pct } from '../ideas/nav';
import { duration, money, openSchedule, when } from './SimulationsPage';

type TabId = 'performance' | 'trades' | 'positions' | 'attribution' | 'config';
const TABS: TabId[] = ['performance', 'trades', 'positions', 'attribution', 'config'];
const REASON_LABEL: Record<string, string> = {
  replaced: 'replaced',
  rebalance: 'resized',
  stop: 'stop',
  take_profit: 'take profit',
  horizon: 'horizon',
  invalidation: 'invalidated',
  p_outperform: 'p < 0.5',
  delisted: 'delisted',
  no_price: 'no price',
  open: 'still open',
  entry: 'entry',
};
const REASON_PILL: Record<string, string> = {
  stop: 'failed',
  delisted: 'failed',
  take_profit: 'ok',
  open: 'running',
  replaced: 'queued',
  horizon: 'pending',
  invalidation: 'warn',
  p_outperform: 'warn',
  no_price: 'warn',
};
export const ReasonPill = ({ reason }: { reason: string }) => (
  <StatusPill status={REASON_PILL[reason] ?? 'pending'} label={REASON_LABEL[reason] ?? reason} />
);

export function SimulationDetail({ id, tab, isAdmin }: { id: string; tab: string; isAdmin: boolean }) {
  const [s, setS] = useState<any>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let stop = false;
    const load = () =>
      api(`/simulations/${id}`)
        .then((x) => {
          if (stop) return;
          setS(x);
          if (x.status === 'running') setTimeout(load, 3000);
        })
        .catch((e) => setError(e?.message ?? String(e)));
    void load();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop = true;
      clearInterval(tick);
    };
  }, [id]);
  if (error) return <p className="error-line">{error}</p>;
  if (!s) return <Skeleton rows={10} />;
  const current = (TABS.includes(tab as TabId) ? tab : 'performance') as TabId;
  const c = s.config;
  const r = s.result;
  const remove = async () => {
    if (!confirm(`Delete "${s.name}" and its ledger?`)) return;
    await api(`/simulations/${id}`, { method: 'DELETE' });
    go('/simulations');
  };
  return (
    <section className="page-section sim-page">
      <nav className="breadcrumbs" aria-label="Breadcrumbs">
        <button type="button" className="link-button" onClick={() => go('/simulations')}>
          <ArrowLeft size={14} /> Simulations
        </button>
        <span aria-hidden="true">›</span> {s.name}
      </nav>
      <header className="idea-head">
        <div>
          <h2>{s.name}</h2>
          <div className="idea-meta">
            <StatusPill status={s.status} />
            <span>
              {c.period.start} → {c.period.end}
            </span>
            <span>{money(c.capital)} capital</span>
            <span className="chips">
              {c.ideas.map((i: any) => (
                <button
                  key={i.idea}
                  type="button"
                  className="chip"
                  title="Open the idea"
                  onClick={() => go(`/ideas/${i.idea}`)}
                >
                  {i.idea} · {i.plugin} v{i.version}
                </button>
              ))}
            </span>
            {s.usesHoldout && <StatusPill status="warn" label="uses the holdout" />}
            <span>created {when(s.createdAt)}</span>
          </div>
        </div>
        <div className="idea-actions">
          {isAdmin && (
            <button type="button" className="button" onClick={() => openSchedule({ clone: s.id })}>
              <Copy size={14} /> Clone and edit
            </button>
          )}
          <a className="button" href={`/api/simulations/${id}/export`} download>
            <Download size={14} /> Export YAML
          </a>
          <button
            type="button"
            className="button"
            disabled
            title="Paper trading of approved strategies comes in M7"
          >
            <Radio size={14} /> Go live (paper)
          </button>
          {isAdmin && s.status !== 'running' && (
            <button type="button" className="button danger" onClick={remove}>
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
      </header>
      {s.status === 'running' && (
        <div className="card-panel run-progress" role="status">
          <p>
            Running · {duration((now - Date.parse(s.createdAt)) / 1000)} of about{' '}
            {duration(s.estimateSeconds)}
          </p>
          <progress
            max={s.estimateSeconds}
            value={Math.min(s.estimateSeconds, (now - Date.parse(s.createdAt)) / 1000)}
          />
        </div>
      )}
      {s.status === 'failed' && (
        <div className="notice error-notice" role="alert">
          <AlertTriangle size={16} />
          <div>
            <strong>{s.error?.type ?? 'The simulation failed'}</strong>
            {s.error?.idea_id ? ` in ${s.error.idea_id}` : ''}: {s.error?.message}
            {s.error?.frames?.map((f: any, i: number) => (
              <div key={i} className="mono">
                {f.line ? `line ${f.line} in ${f.function}: ${f.code}` : f.stderr}
              </div>
            ))}
          </div>
        </div>
      )}
      {r && (
        <>
          <div className="kpi-row">
            <KpiCard
              label="CAGR"
              value={pct(r.summary.cagr)}
              footnote={`S&P 500 ${pct(r.summary.spx_total_return)} total`}
            />
            <KpiCard
              label="Sharpe"
              value={num(r.summary.sharpe)}
              footnote={`Sortino ${num(r.summary.sortino)}`}
            />
            <KpiCard
              label="Max drawdown"
              value={pct(r.summary.max_drawdown)}
              footnote={`Calmar ${num(r.summary.calmar)}`}
            />
            <KpiCard
              label="Excess / year"
              value={pct(r.excess?.excess_cagr)}
              footnote={`IR ${num(r.excess?.information_ratio)}`}
            />
            <KpiCard
              label="Final NAV"
              value={money(r.summary.final_nav)}
              footnote={`from ${money(r.summary.capital)}`}
            />
            <KpiCard
              label="Trades"
              value={String(r.summary.trades)}
              footnote={`${pct(r.summary.win_rate, 0)} winners · PF ${num(r.summary.profit_factor)}`}
            />
          </div>
          <Tabs
            tabs={[
              { id: 'performance', label: 'Performance', icon: <LineChart size={14} /> },
              {
                id: 'trades',
                label: 'Trades',
                icon: <ListOrdered size={14} />,
                badge: <small className="tab-badge">{r.counts.trades}</small>,
              },
              { id: 'positions', label: 'Positions', icon: <PieChart size={14} /> },
              { id: 'attribution', label: 'Attribution', icon: <BarChart3 size={14} /> },
              { id: 'config', label: 'Config', icon: <Settings2 size={14} /> },
            ]}
            value={current}
            onChange={(next) => go(`/simulations/${id}${next === 'performance' ? '' : `/${next}`}`)}
          />
          {current === 'performance' && <Performance r={r} />}
          {current === 'trades' && <Trades id={id} ideas={c.ideas.map((i: any) => i.idea)} />}
          {current === 'positions' && <Positions id={id} dates={r.series.dates} />}
          {current === 'attribution' && <Attribution r={r} />}
          {current === 'config' && <ConfigView s={s} isAdmin={isAdmin} />}
        </>
      )}
      {!r && s.status !== 'running' && current === 'config' && <ConfigView s={s} isAdmin={isAdmin} />}
    </section>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function Performance({ r }: { r: any }) {
  const s = r.series.series;
  const d = r.series.dates;
  const heat = useMemo(() => {
    const years = [...new Set<string>(r.monthly_returns.map((m: any) => m.month.slice(0, 4)))].sort();
    return {
      years,
      cells: r.monthly_returns.map(
        (m: any) =>
          [
            Number(m.month.slice(5, 7)) - 1,
            years.indexOf(m.month.slice(0, 4)),
            Math.round(m.return * 10000) / 100,
          ] as [number, number, number],
      ),
    };
  }, [r]);
  return (
    <div className="sim-performance">
      <TimeSeriesChart
        title="Equity"
        subtitle="Growth of 1 after costs, borrow and dividends, against the S&P 500"
        data={{ dates: d, series: { Strategy: s.equity, 'S&P 500': s.spx_equity } }}
        height={320}
        group="sim"
      />
      <div className="eval-grid">
        <TimeSeriesChart
          title="Drawdown"
          subtitle="From the running peak"
          data={{ dates: d, series: { Drawdown: s.drawdown } }}
          height={220}
          logToggle={false}
          group="sim"
        />
        <TimeSeriesChart
          title="Exposure"
          subtitle="Share of NAV: long, short (negative) and cash"
          data={{ dates: d, series: { Long: s.long, Short: s.short, Cash: s.cash } }}
          height={220}
          logToggle={false}
          group="sim"
        />
        <TimeSeriesChart
          title="Rolling Sharpe"
          subtitle="126 sessions"
          data={{ dates: d, series: { 'Rolling Sharpe': s.rolling_sharpe_126 } }}
          height={220}
          logToggle={false}
          group="sim"
        />
        <HeatmapChart
          title="Monthly returns"
          subtitle="Blue gains, red losses (%)"
          x={MONTHS}
          y={heat.years}
          cells={heat.cells}
          valueLabel="% return"
          diverging
          height={Math.max(160, 40 + heat.years.length * 26)}
        />
      </div>
      <p className="muted-line">
        Ledger checks: NAV = cash + positions to within {r.reconciliation.max_nav_error.toExponential(1)}, and
        each day&apos;s change in NAV = price P&amp;L + dividends − costs − borrow to within{' '}
        {r.reconciliation.max_pnl_error.toExponential(1)}. Costs paid {money(r.summary.costs_paid)}, dividends{' '}
        {money(r.summary.dividends)}, borrow {money(r.summary.borrow_paid)}; turnover{' '}
        {num(r.summary.annual_turnover, 1)}× a year.
      </p>
    </div>
  );
}

const ROW = 40;
function Trades({ id, ideas }: { id: string; ideas: string[] }) {
  const [filter, setFilter] = useState({ idea: '', reason: '', side: '', security: '', sort: 'recent' });
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [top, setTop] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const qs = new URLSearchParams(
      Object.entries({ ...filter, limit: '5000' }).filter(([, v]) => v) as [string, string][],
    );
    const t = setTimeout(() => void api(`/simulations/${id}/trades?${qs}`).then(setData), 250);
    return () => clearTimeout(t);
  }, [id, JSON.stringify(filter)]);
  const items: any[] = data?.items ?? [];
  const height = Math.min(600, items.length * ROW + 44);
  const first = Math.max(0, Math.floor(top / ROW) - 5);
  const last = Math.min(items.length, first + Math.ceil(height / ROW) + 10);
  return (
    <div className="sim-trades">
      <div className="filter-bar" role="toolbar" aria-label="Trade filters">
        <select
          aria-label="Idea"
          value={filter.idea}
          onChange={(e) => setFilter({ ...filter, idea: e.target.value })}
        >
          <option value="">All ideas</option>
          {ideas.map((i) => (
            <option key={i}>{i}</option>
          ))}
        </select>
        <select
          aria-label="Exit reason"
          value={filter.reason}
          onChange={(e) => setFilter({ ...filter, reason: e.target.value })}
        >
          <option value="">Any exit</option>
          {[
            'replaced',
            'stop',
            'take_profit',
            'horizon',
            'invalidation',
            'p_outperform',
            'delisted',
            'no_price',
            'open',
          ].map((x) => (
            <option key={x} value={x}>
              {REASON_LABEL[x]}
            </option>
          ))}
        </select>
        <select
          aria-label="Side"
          value={filter.side}
          onChange={(e) => setFilter({ ...filter, side: e.target.value })}
        >
          <option value="">Long and short</option>
          <option value="long">Long</option>
          <option value="short">Short</option>
        </select>
        <label className="search-field">
          <input
            aria-label="Security"
            placeholder="Ticker or SEC_…"
            value={filter.security}
            onChange={(e) => setFilter({ ...filter, security: e.target.value })}
          />
        </label>
        <select
          aria-label="Sort"
          value={filter.sort}
          onChange={(e) => setFilter({ ...filter, sort: e.target.value })}
        >
          <option value="recent">Most recent exit</option>
          <option value="oldest">Oldest entry</option>
          <option value="pnl">Best P&amp;L</option>
          <option value="worst">Worst P&amp;L</option>
          <option value="return">Best return</option>
        </select>
        <span className="muted-line">{data ? `${data.total} trades` : ''}</span>
      </div>
      {!data ? (
        <Skeleton rows={6} />
      ) : !items.length ? (
        <div className="empty-state">
          <p>No trades match.</p>
        </div>
      ) : (
        <div
          className="idea-table"
          ref={box}
          style={{ maxHeight: height }}
          onScroll={(e) => setTop((e.target as HTMLDivElement).scrollTop)}
        >
          <table aria-label="Trades">
            <thead>
              <tr>
                <th>#</th>
                <th>Security</th>
                <th>Idea</th>
                <th>Side</th>
                <th>Entry</th>
                <th>Exit</th>
                <th className="num">Sessions</th>
                <th className="num">Return</th>
                <th className="num">P&amp;L</th>
                <th>Exit reason</th>
              </tr>
            </thead>
            <tbody>
              {first > 0 && <tr style={{ height: first * ROW }} aria-hidden="true" />}
              {items.slice(first, last).map((t) => (
                <tr key={t.n} className="clickable" style={{ height: ROW }} onClick={() => setOpen(t.n)}>
                  <td className="mono">{t.n}</td>
                  <td>
                    <strong>{t.ticker ?? t.security_id}</strong>
                  </td>
                  <td>{t.idea_id}</td>
                  <td>{t.side}</td>
                  <td className="nowrap">{t.entry_date}</td>
                  <td className="nowrap">{t.exit_date ?? '—'}</td>
                  <td className="num">{t.days_held ?? '—'}</td>
                  <td className={`num ${t.return > 0 ? 'gain' : t.return < 0 ? 'loss' : ''}`}>
                    {pct(t.return)}
                  </td>
                  <td className={`num ${t.pnl > 0 ? 'gain' : t.pnl < 0 ? 'loss' : ''}`}>{money(t.pnl)}</td>
                  <td>
                    <ReasonPill reason={t.exit_reason} />
                  </td>
                </tr>
              ))}
              {last < items.length && (
                <tr style={{ height: (items.length - last) * ROW }} aria-hidden="true" />
              )}
            </tbody>
          </table>
        </div>
      )}
      {open !== null && <TradeDrawer id={id} n={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function TradeDrawer({ id, n, onClose }: { id: string; n: number; onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    void api(`/simulations/${id}/trades/${n}`).then(setD);
  }, [id, n]);
  const t = d?.trade;
  const chart = useMemo(() => {
    if (!d) return null;
    const dates = d.prices.map((p: any) => p.date);
    const close = d.prices.map((p: any) => p.close ?? null);
    const end = t.exit_date ?? dates.at(-1);
    const held = d.prices.map((p: any) =>
      p.date >= t.entry_date && p.date <= end ? (p.close ?? null) : null,
    );
    return { dates, series: { Close: close, Held: held } };
  }, [d]);
  return (
    <Drawer
      title={t ? `Trade ${n} · ${t.ticker ?? t.security_id} (${t.idea_id})` : `Trade ${n}`}
      onClose={onClose}
    >
      {!d ? (
        <Skeleton rows={6} />
      ) : (
        <div className="trade-detail">
          <p>
            <ReasonPill reason={t.exit_reason} /> {t.side} · {t.entry_date} → {t.exit_date ?? 'still open'} ·{' '}
            {t.days_held} sessions
          </p>
          <dl className="trade-numbers">
            <div>
              <dt>Return</dt>
              <dd>{pct(t.return)}</dd>
            </div>
            <div>
              <dt>P&amp;L</dt>
              <dd>{money(t.pnl)}</dd>
            </div>
            <div>
              <dt>Dividends</dt>
              <dd>{money(t.dividends)}</dd>
            </div>
            <div>
              <dt>Costs</dt>
              <dd>{money(t.costs)}</dd>
            </div>
            <div>
              <dt>Borrow</dt>
              <dd>{money(t.borrow)}</dd>
            </div>
            <div>
              <dt>Entry → exit price</dt>
              <dd>
                {num(t.entry_price)} → {num(t.exit_price)}
              </dd>
            </div>
          </dl>
          {t.signal && (
            <div className="card-panel">
              <h3>Why it was bought</h3>
              <p>
                On {t.signal.date} the idea&apos;s signal scored it <strong>{num(t.signal.score, 4)}</strong>,
                rank <strong>{t.signal.rank}</strong> of {t.signal.of} eligible names.{' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => go(`/ideas/${t.idea_id}/review`)}
                >
                  The idea&apos;s debate
                </button>{' '}
                ·{' '}
                <button type="button" className="link-button" onClick={() => go(`/ideas/${t.idea_id}/code`)}>
                  its code
                </button>
              </p>
            </div>
          )}
          {chart && chart.dates.length > 1 && (
            <TimeSeriesChart
              title="Price"
              subtitle={
                d.priceKind === 'close'
                  ? 'Close; the held period highlighted'
                  : 'Total-return index (no closes in the data); the held period highlighted'
              }
              data={chart}
              height={220}
              presets={false}
              logToggle={false}
            />
          )}
          <h3>Fills</h3>
          <table className="compact-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Side</th>
                <th className="num">Shares</th>
                <th className="num">Price</th>
                <th className="num">Notional</th>
                <th className="num">Cost</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {d.orders.map((o: any) => (
                <tr key={o.n}>
                  <td>{o.fill_date}</td>
                  <td>{o.side}</td>
                  <td className="num">{num(o.shares, 2)}</td>
                  <td className="num">{num(o.price)}</td>
                  <td className="num">{money(o.notional)}</td>
                  <td className="num">{money(o.cost)}</td>
                  <td>{REASON_LABEL[o.reason] ?? o.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Drawer>
  );
}

function Positions({ id, dates }: { id: string; dates: string[] }) {
  const [i, setI] = useState(dates.length - 1);
  const [data, setData] = useState<any>(null);
  const date = dates[i];
  useEffect(() => {
    const t = setTimeout(() => void api(`/simulations/${id}/positions?date=${date}`).then(setData), 150);
    return () => clearTimeout(t);
  }, [id, date]);
  const p = data?.portfolio;
  return (
    <div className="sim-positions">
      <div className="scrubber">
        <label htmlFor="sim-scrub">As of</label>
        <input
          id="sim-scrub"
          type="range"
          min={0}
          max={dates.length - 1}
          value={i}
          onChange={(e) => setI(Number(e.target.value))}
          aria-valuetext={date}
        />
        <input
          type="date"
          aria-label="Date"
          value={date}
          min={dates[0]}
          max={dates.at(-1)}
          onChange={(e) => {
            const k = dates.findIndex((x) => x >= e.target.value);
            setI(k < 0 ? dates.length - 1 : k);
          }}
        />
      </div>
      {!data ? (
        <Skeleton rows={5} />
      ) : (
        <>
          {p && (
            <p className="muted-line">
              {data.date}: NAV <strong>{money(p.nav)}</strong> · cash {money(p.cash)} · gross{' '}
              {pct(p.gross, 0)} · net {pct(p.net, 0)} · {data.positions.length} positions · day{' '}
              {pct(p.return, 2)}
            </p>
          )}
          {!data.positions.length ? (
            <div className="empty-state">
              <p>Flat on {data.date ?? date}: all cash.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table aria-label="Positions">
                <thead>
                  <tr>
                    <th>Security</th>
                    <th>Idea</th>
                    <th>Sector</th>
                    <th className="num">Shares</th>
                    <th className="num">Price</th>
                    <th className="num">Value</th>
                    <th className="num">Weight</th>
                    <th className="num">Unrealized P&amp;L</th>
                    <th>Since</th>
                  </tr>
                </thead>
                <tbody>
                  {data.positions.map((x: any) => (
                    <tr key={`${x.idea_id}-${x.security_id}`}>
                      <td>
                        <strong>{x.ticker ?? x.security_id}</strong>
                      </td>
                      <td>{x.idea_id}</td>
                      <td>{x.sector ?? '—'}</td>
                      <td className="num">{num(x.shares, 2)}</td>
                      <td className="num">{num(x.price)}</td>
                      <td className="num">{money(x.value)}</td>
                      <td className="num">{pct(x.weight)}</td>
                      <td
                        className={`num ${x.unrealized_pnl > 0 ? 'gain' : x.unrealized_pnl < 0 ? 'loss' : ''}`}
                      >
                        {money(x.unrealized_pnl)}
                      </td>
                      <td className="nowrap">{x.entry_date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Attribution({ r }: { r: any }) {
  const a = r.attribution;
  const groups: [string, string, any[]][] = [
    ['by_idea', 'P&L by idea', a.by_idea],
    ['by_sector', 'P&L by sector', a.by_sector],
    ['by_side', 'P&L by side', a.by_side],
    [
      'by_exit_reason',
      'P&L by exit reason',
      a.by_exit_reason.map((g: any) => ({ ...g, key: REASON_LABEL[g.key] ?? g.key })),
    ],
    ['by_holding_period', 'P&L by holding period', a.by_holding_period],
  ];
  return (
    <div className="sim-attribution">
      <div className="eval-grid">
        {groups.map(([k, title, rows]) =>
          rows.length ? (
            <BarChart
              key={k}
              title={title}
              subtitle={`${rows.reduce((n: number, g: any) => n + g.trades, 0)} trades, closed and open`}
              categories={rows.map((g: any) => String(g.key))}
              series={{ 'P&L (USD)': rows.map((g: any) => g.pnl) }}
              horizontal
              height={Math.max(160, 50 + rows.length * 30)}
            />
          ) : null,
        )}
      </div>
      <div className="card-panel">
        <h3>Calibration</h3>
        <p className="muted-line">
          Do higher-ranked names do better? Realized trade returns by the signal&apos;s rank at entry, in
          fifths of the eligible names (Q1 = the top fifth).
        </p>
        {a.calibration.length ? (
          <table className="compact-table" aria-label="Calibration">
            <thead>
              <tr>
                <th>Rank at entry</th>
                <th className="num">Trades</th>
                <th className="num">Mean return</th>
                <th className="num">Winners</th>
              </tr>
            </thead>
            <tbody>
              {a.calibration.map((c: any) => (
                <tr key={c.key}>
                  <td>{c.key}</td>
                  <td className="num">{c.trades}</td>
                  <td className="num">{pct(c.mean_return, 2)}</td>
                  <td className="num">{pct(c.win_rate, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted-line">No trade has a recorded signal rank.</p>
        )}
      </div>
    </div>
  );
}

function ConfigView({ s, isAdmin }: { s: any; isAdmin: boolean }) {
  const c = s.config;
  const rows: [string, React.ReactNode][] = [
    [
      'Ideas',
      c.ideas
        .map(
          (i: any) =>
            `${i.idea} (${i.plugin} v${i.version}${i.weight !== undefined ? `, ${pct(i.weight, 0)}` : ''})`,
        )
        .join(', '),
    ],
    ['Period', `${c.period.start} → ${c.period.end}${c.period.allowHoldout ? ' · holdout allowed' : ''}`],
    [
      'Scope',
      c.symbols?.length ? `${c.symbols.length} symbols: ${c.symbols.join(', ')}` : 'the whole universe',
    ],
    ['Capital', money(c.capital)],
    ['Allocation', c.allocation.replace('_', ' ')],
    [
      'Sizing',
      c.sizing.mode === 'quarter_kelly'
        ? `quarter-Kelly (fraction ${c.sizing.kellyFraction})`
        : 'equal weight',
    ],
    [
      'Constraints',
      `gross ${c.constraints.gross}× · net ${c.constraints.net ?? 'none'} · per position ${c.constraints.positionCap === null ? 'none' : pct(c.constraints.positionCap, 0)} · per sector ${c.constraints.sectorCap === null ? 'none' : pct(c.constraints.sectorCap, 0)}`,
    ],
    [
      'Exits',
      [
        'replaced at a rebalance',
        c.exits.stop !== null && `stop ${pct(c.exits.stop, 0)}`,
        c.exits.takeProfit !== null &&
          `take profit ${c.exits.takeProfit === 'p90' ? 'P90' : pct(c.exits.takeProfit, 0)}`,
        c.exits.horizon && 'horizon',
        c.exits.review && 'review()',
      ]
        .filter(Boolean)
        .join(' · '),
    ],
    [
      'Costs',
      Object.keys(c.costs).length
        ? Object.entries(c.costs)
            .map(([k, v]) => `${k} ${v}`)
            .join(' · ')
        : 'the evaluator defaults (backtest.yaml)',
    ],
    ['Seed', String(c.seed)],
    ['Ledger hash', <code key="h">{s.result?.ledger_hash ?? '—'}</code>],
    ['Simulator', s.result ? `${s.result.simulator_version} (evaluator ${s.result.evaluator_version})` : '—'],
    [
      'Ran',
      s.durationMs ? `${duration(s.durationMs / 1000)} (estimated ${duration(s.estimateSeconds)})` : '—',
    ],
  ];
  return (
    <div className="sim-config">
      <dl className="prose-list">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {isAdmin && (
        <button type="button" className="button secondary" onClick={() => openSchedule({ clone: s.id })}>
          <Copy size={14} /> Clone and edit
        </button>
      )}
    </div>
  );
}
