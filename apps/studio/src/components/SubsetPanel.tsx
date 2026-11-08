// Name subsets (#325): find the names of the scope a strategy works for, picked on the first part of the window
// and checked on the rest against random subsets of the same size.
import React, { useCallback, useEffect, useState } from 'react';
import { api, send } from '../api';
import { StatusPill } from './kit';
import { INK, SERIES_COLORS } from '../charts/chartData';

const pct = (v: unknown, d = 1) =>
  typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—';
const num = (v: unknown, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const go = (path: string) => {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
};

type Sub = {
  id: string;
  status: string;
  createdAt: string;
  select?: Record<string, unknown>;
  record?: any;
  error?: any;
};

/** Start a subset search from an exploration, and list the searches already run. */
export function SubsetPanel({ evaluationId }: { evaluationId: string }) {
  const [runs, setRuns] = useState<Sub[] | null>(null);
  const [topK, setTopK] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(
    () =>
      api<{ items: Sub[] }>(`/evaluations?subsetOf=${encodeURIComponent(evaluationId)}`)
        .then((x) => setRuns(x.items))
        .catch((e) => setError(String(e?.message ?? e))),
    [evaluationId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const running = runs?.some((r) => r.status === 'running');
  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => void load(), 4000);
    return () => clearTimeout(t);
  }, [running, runs, load]);
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      await send(`/evaluations/${evaluationId}/subset`, { top_k: topK }, 'POST');
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const latest = runs?.[0];
  return (
    <section className="card-panel subset-panel" aria-label="Names it works for">
      <div className="subset-head">
        <div>
          <h3>Names it works for</h3>
          <p className="muted-line">
            Picks the best names on the first two thirds of the window, then runs the strategy on only those
            names over the last third and compares them with random sets of the same size. Counts as one
            trial.
          </p>
        </div>
        <div className="subset-start">
          <label>
            Names
            <input
              type="number"
              min={2}
              max={200}
              value={topK}
              onChange={(e) => setTopK(Math.max(2, Math.min(200, Number(e.target.value) || 20)))}
            />
          </label>
          <button
            type="button"
            className="button primary"
            disabled={busy || running}
            onClick={() => void start()}
          >
            {running ? 'Searching…' : 'Find the names'}
          </button>
        </div>
      </div>
      {error && <p className="error-line">{error}</p>}
      {latest?.status === 'running' && (
        <p className="muted-line">Running: about 2 to 15 minutes, by scope size.</p>
      )}
      {latest?.status === 'failed' && <p className="error-line">{latest.error?.message}</p>}
      {latest?.record?.subset && <SubsetResult record={latest.record} evaluationId={latest.id} />}
      {runs && runs.length > 1 && (
        <details>
          <summary>Earlier searches ({runs.length - 1})</summary>
          <ul className="subset-earlier">
            {runs.slice(1).map((r) => (
              <li key={r.id}>
                <button type="button" className="link-button" onClick={() => go(`/evaluations/${r.id}`)}>
                  {new Date(r.createdAt).toLocaleString()}
                </button>{' '}
                · {String(r.select?.top_k ?? 20)} names ·{' '}
                {r.record?.subset ? (r.record.subset.passed ? 'shown' : 'not shown') : r.status}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** What a subset search found: the names, the periods, and how the names did against random sets. */
export function SubsetResult({ record: r, evaluationId }: { record: any; evaluationId?: string }) {
  const s = r.subset;
  return (
    <div className="subset-result">
      <p className="subset-verdict">
        <StatusPill
          status={s.passed ? 'succeeded' : 'warn'}
          label={s.passed ? 'shown out of sample' : 'not shown'}
        />{' '}
        {s.verdict}.
      </p>
      <div className="table-wrap">
        <table aria-label="Subset comparison">
          <thead>
            <tr>
              <th>Over the check period ({`${s.check_period.start} → ${s.check_period.end}`})</th>
              <th>Sharpe</th>
              <th>CAGR</th>
              <th>Excess / year</th>
              <th>Max drawdown</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>The {s.chosen.length} chosen names</strong>
              </td>
              <td>{num(s.check.sharpe)}</td>
              <td>{pct(s.check.cagr)}</td>
              <td>{pct(s.check.excess_cagr)}</td>
              <td>{pct(s.check.max_drawdown)}</td>
            </tr>
            <tr>
              <td>The whole scope</td>
              <td>{num(s.whole.sharpe)}</td>
              <td>{pct(s.whole.cagr)}</td>
              <td>{pct(s.whole.excess_cagr)}</td>
              <td>{pct(s.whole.max_drawdown)}</td>
            </tr>
            <tr>
              <td>
                {s.random.n} random sets of {s.chosen.length} (average)
              </td>
              <td>{num(s.random.mean_sharpe)}</td>
              <td colSpan={3} className="muted-line">
                the chosen names beat {s.random.beaten} of {s.random.n} · p = {num(s.random.p_value, 3)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <SharpeStrip random={s.random.sharpes} chosen={s.check.sharpe} whole={s.whole.sharpe} />
      <p className="muted-line">
        Picked on {s.pick_period.start} → {s.pick_period.end} (by {String(s.select.metric)}, held at least{' '}
        {String(s.select.min_days)} days; {s.pool} of {s.names_held_in_pick} names held qualified). The
        strategy holds {s.top_n} of them at a time.
      </p>
      <div className="chips" aria-label="Chosen names">
        {s.chosen.map((c: any) => (
          <span
            key={c.security_id}
            className="chip"
            title={`${c.sector} · ${pct(c.contribution, 2)} in the pick period`}
          >
            {c.ticker ?? c.security_id}
          </span>
        ))}
      </div>
      {evaluationId && (
        <button type="button" className="link-button" onClick={() => go(`/evaluations/${evaluationId}`)}>
          Open the check run
        </button>
      )}
    </div>
  );
}

/** One axis of Sharpe ratios: random sets as dots, the chosen names and the whole scope marked. */
function SharpeStrip({ random, chosen, whole }: { random: number[]; chosen: number; whole: number }) {
  const values = [...random, chosen, whole].filter((v) => Number.isFinite(v));
  if (!values.length) return null;
  const lo = Math.min(...values, 0);
  const hi = Math.max(...values, 0);
  const pad = (hi - lo) * 0.08 || 1;
  const [a, b] = [lo - pad, hi + pad];
  const W = 640;
  const H = 100;
  const L = 16;
  const R = 16;
  const x = (v: number) => L + ((v - a) / (b - a)) * (W - L - R);
  const ticks = Array.from({ length: 5 }, (_, i) => a + ((b - a) * i) / 4);
  // Equal values stack upward (a dot per random set stays visible).
  const rows = new Map<number, number>();
  const stacked = [...random]
    .sort((p, q) => p - q)
    .map((v) => {
      const bucket = Math.round(x(v) / 8);
      const row = rows.get(bucket) ?? 0;
      rows.set(bucket, row + 1);
      return { v, row: Math.min(row, 5) };
    });
  const blue = SERIES_COLORS[0];
  const orange = SERIES_COLORS[1];
  return (
    <figure className="sharpe-strip">
      <figcaption>
        <span className="legend-item">
          <svg width="10" height="10" aria-hidden>
            <circle cx="5" cy="5" r="4" fill={INK.muted} opacity={0.55} />
          </svg>
          random sets
        </span>
        <span className="legend-item">
          <svg width="10" height="10" aria-hidden>
            <circle cx="5" cy="5" r="5" fill={blue} />
          </svg>
          chosen names
        </span>
        <span className="legend-item">
          <svg width="12" height="10" aria-hidden>
            <line x1="6" y1="0" x2="6" y2="10" stroke={orange} strokeWidth="2" strokeDasharray="3 2" />
          </svg>
          whole scope
        </span>
        <span className="muted-line">Sharpe over the check period</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Sharpe of the chosen names against random sets">
        <line x1={L} x2={W - R} y1={66} y2={66} stroke={INK.axis} />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={64} y2={69} stroke={INK.axis} />
            <text x={x(t)} y={84} textAnchor="middle" fontSize="11" fill={INK.muted}>
              {t.toFixed(1)}
            </text>
          </g>
        ))}
        {Number.isFinite(whole) && (
          <g>
            <line
              x1={x(whole)}
              x2={x(whole)}
              y1={16}
              y2={66}
              stroke={orange}
              strokeWidth={2}
              strokeDasharray="4 3"
            />
            <title>Whole scope: {whole.toFixed(2)}</title>
          </g>
        )}
        {stacked.map(({ v, row }, i) => (
          <circle
            key={i}
            cx={x(v)}
            cy={58 - row * 7}
            r={4}
            fill={INK.muted}
            opacity={0.55}
            stroke="#fff"
            strokeWidth={1}
          >
            <title>Random set: {v.toFixed(2)}</title>
          </circle>
        ))}
        {Number.isFinite(chosen) && (
          <g>
            <line x1={x(chosen)} x2={x(chosen)} y1={16} y2={66} stroke={blue} strokeWidth={2} />
            <circle cx={x(chosen)} cy={58} r={6} fill={blue} stroke="#fff" strokeWidth={2} />
            <text x={x(chosen)} y={11} textAnchor="middle" fontSize="11" fill={INK.primary}>
              {chosen.toFixed(2)}
            </text>
            <title>Chosen names: {chosen.toFixed(2)}</title>
          </g>
        )}
      </svg>
    </figure>
  );
}
