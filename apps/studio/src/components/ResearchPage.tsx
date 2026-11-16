// Research Lab (#116): the research loop at a glance. KPIs, the pipeline board, the live activity feed (SSE), charts,
// the settings drawer (models and skills per role, focus, gates versions, budget alerts, schedule) and human steering.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  CircleDollarSign,
  FlaskConical,
  Gauge,
  Lightbulb,
  Settings2,
  Sigma,
  Sparkles,
} from 'lucide-react';
import { api, send, type Data } from '../api';
import { Button, Field } from './ui';
import { KpiCard, Skeleton, StatusPill, Tabs } from './kit';
import { IdeaStatus } from './ideas/IdeaStatus';
import { go, useLocation } from './ideas/nav';
import { ResearchSetup } from './research/ResearchSetup';
import { ResearchHow } from './research/ResearchHow';
import { ResearchCycles } from './research/ResearchCycles';
import { ResearchStatusBar } from './research/ResearchStatusBar';
import { BarChart, TimeSeriesChart } from '../charts/Charts';
import { ObjectTransfer } from './ObjectTransfer';

type Card = {
  id: string;
  ref: string;
  title: string;
  status: string;
  family: string;
  revisions: number;
  codeAttempts: number;
  trials: number;
  forwardOnly?: boolean;
};
type Status = {
  paused: boolean;
  state?: import('./research/ResearchStatusBar').ResearchStateView;
  harness: { id: string; name: string; schedule: { enabled: boolean; everyMinutes: number } | null } | null;
  lastRun: { id: string; status: string; startedAt: string } | null;
  kpis: {
    theoriesToday: number;
    inFlight: number;
    successRate: number | null;
    decided: number;
    trials: number;
    tokensToday: number;
    costToday?: number;
  };
  budgetAlert: string | null;
  spend?: {
    today: number;
    sinceCap?: number;
    capUsd?: number;
    capSince?: string;
    dailyCapUsd?: number;
    exceeded?: string;
    stoppedAt?: string;
    stopReason?: string;
  };
  tokensByRole: Record<string, { input: number; output: number; calls: number }>;
  board: { columns: { key: string; label: string; cards: Card[] }[]; verdictsToday: Card[] };
};
type Item = {
  at: string;
  theory: string;
  theoryId: string;
  title: string;
  type: string;
  from?: string;
  to?: string;
  role: string;
  model?: string;
  reasoning: string;
};
const ROLES = ['theorist', 'judge', 'coder'] as const;
const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`;

function ResearchLab({ data, isAdmin }: { data: Data; isAdmin: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [charts, setCharts] = useState<any>(null);
  const [kpis, setKpis] = useState<any>(null);
  const [feed, setFeed] = useState<Item[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const [s, c, k] = await Promise.all([
        api<Status>('/research/status'),
        api('/research/charts?days=30'),
        api('/research/kpis').catch(() => null),
      ]);
      setStatus(s);
      setCharts(c);
      setKpis(k);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    // The live activity feed: the theories' debate as it happens.
    const since = new Date(Date.now() - 3 * 86400_000).toISOString();
    const es = new EventSource(`/api/research/activity?since=${encodeURIComponent(since)}`);
    es.addEventListener('activity', (e) => {
      const item = JSON.parse((e as MessageEvent).data) as Item;
      setFeed((f) => [item, ...f].slice(0, 200));
    });
    return () => es.close();
  }, []);
  const tokenChart = useMemo(() => {
    const t = charts?.tokensByRole ?? {};
    const roles = Object.keys(t);
    return {
      categories: roles,
      series: { input: roles.map((r) => t[r].input), output: roles.map((r) => t[r].output) },
    };
  }, [charts]);
  if (error) return <p className="error-line">{error}</p>;
  if (!status) return <Skeleton rows={8} />;
  const k = status.kpis;
  return (
    <div className="research-lab">
      <ResearchStatusBar status={status} isAdmin={isAdmin} onChanged={() => void load()} />
      <div className="section-heading">
        <span className="spacer" />
        <Button variant="secondary" onClick={() => go('/ideas')}>
          <Lightbulb size={14} /> All ideas
        </Button>
        {isAdmin && (
          <Button variant="secondary" onClick={() => go('/research/setup')}>
            <Settings2 size={14} /> Settings
          </Button>
        )}
      </div>
      {status.budgetAlert && (
        <p className="schedule-warning" role="alert">
          <StatusPill status="warn" label="budget" /> {status.budgetAlert}
        </p>
      )}
      <div className="kpi-row" aria-label="Research KPIs">
        <KpiCard icon={<Sparkles size={18} />} label="Theories today" value={k.theoriesToday} />
        <KpiCard icon={<FlaskConical size={18} />} label="In flight" value={k.inFlight} />
        <KpiCard
          icon={<Gauge size={18} />}
          label="Successful"
          value={pct(k.successRate)}
          footnote={`of ${k.decided} verdicts`}
        />
        <KpiCard
          icon={<Sigma size={18} />}
          label="Total trials"
          value={k.trials}
          footnote="every evaluation counts"
        />
        <KpiCard
          icon={<CircleDollarSign size={18} />}
          label="Spend today"
          value={`$${(status.spend?.today ?? k.costToday ?? 0).toFixed(2)}`}
          footnote={[
            `${k.tokensToday.toLocaleString()} tokens`,
            status.spend?.dailyCapUsd !== undefined ? `daily cap $${status.spend.dailyCapUsd}` : '',
            status.spend?.capUsd !== undefined
              ? `$${(status.spend.sinceCap ?? 0).toFixed(2)} of $${status.spend.capUsd} since ${
                  status.spend.capSince ? new Date(status.spend.capSince).toLocaleDateString() : 'the start'
                }`
              : 'no spend cap',
          ]
            .filter(Boolean)
            .join(' · ')}
        />
      </div>
      {kpis && <Scorecards kpis={kpis} />}
      <div className="research-board" aria-label="Pipeline board">
        {[
          ...status.board.columns,
          { key: 'verdicts', label: "Today's verdicts", cards: status.board.verdictsToday },
        ].map((col) => (
          <div key={col.key} className="board-column" aria-label={col.label}>
            <h3>
              {col.label} <small>{col.cards.length}</small>
            </h3>
            {!col.cards.length && <span className="board-empty">Nothing here now</span>}
            {col.cards.map((c) => (
              <button key={c.id} type="button" className="board-card" onClick={() => go(`/ideas/${c.ref}`)}>
                <strong>
                  {c.ref} {c.title}
                </strong>
                <span>
                  <IdeaStatus status={c.status} /> {c.family}
                  {c.forwardOnly ? ' · forward only' : ''}
                </span>
                <small>
                  {c.revisions} rev · {c.codeAttempts} code retries · {c.trials} trials
                </small>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="eval-grid">
        <div className="activity-feed" aria-label="Live activity">
          <h3>
            <Activity size={14} /> Live activity
          </h3>
          {!feed.length && <p className="muted-line">Nothing yet in the last three days.</p>}
          <ol>
            {feed.map((f, i) => (
              <li key={`${f.at}-${i}`}>
                <time>{new Date(f.at).toLocaleTimeString()}</time>{' '}
                <button type="button" className="link-button" onClick={() => go(`/ideas/${f.theoryId}`)}>
                  {f.theory}
                </button>{' '}
                <strong>{f.role}</strong> {f.type === 'transition' ? `${f.from} → ${f.to}` : f.type}
                {f.model ? <small> · {f.model}</small> : null}
                {f.reasoning && <p>{f.reasoning}</p>}
              </li>
            ))}
          </ol>
        </div>
        <div className="steering-box">
          <h3>Steer the Theorists</h3>
          <p className="muted-line">The next cycle's Theorists read the latest notes in their brief.</p>
          <textarea
            aria-label="Steering note"
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Focus on quality and low-volatility ideas; avoid pure momentum this week."
          />
          <Button
            disabled={!isAdmin || note.trim().length < 3}
            onClick={() =>
              void send('/research/steering', { note }).then(() => {
                setNote('');
                void load();
              })
            }
          >
            Send to the Theorists
          </Button>
        </div>
      </div>
      {charts && (
        <div className="eval-grid">
          <BarChart
            title="Verdicts per day"
            categories={charts.verdicts.dates}
            series={charts.verdicts.series}
            height={220}
          />
          <TimeSeriesChart
            title="Success rate"
            data={charts.successRate}
            presets={false}
            logToggle={false}
            height={220}
          />
          <TimeSeriesChart
            title="Cumulative trials"
            data={charts.trials}
            presets={false}
            logToggle={false}
            height={220}
          />
          <BarChart
            title="Tokens by role (30 days)"
            categories={tokenChart.categories}
            series={tokenChart.series}
            height={220}
          />
        </div>
      )}
    </div>
  );
}

type ResearchTab = 'lab' | 'setup' | 'how' | 'cycles';
/** Research (#116, #301, #302): Lab (the loop at a glance), Setup, How it works, Cycles — each a URL. */
export function ResearchPage({ data, isAdmin }: { data: Data; isAdmin: boolean }) {
  const loc = useLocation();
  const parts = loc.path.split('/').filter(Boolean); // ['research', tab?, id?]
  const tab = (['setup', 'how', 'cycles'].includes(parts[1] ?? '') ? parts[1] : 'lab') as ResearchTab;
  const [version, setVersion] = useState(0);
  return (
    <section className="page-section research-page">
      <div className="section-heading research-title">
        <h2>Research</h2>
        <p className="muted-line">
          Agents propose, review, code and judge trading ideas; every step is a record you can open.
        </p>
      </div>
      <Tabs
        tabs={[
          { id: 'lab', label: 'Lab' },
          { id: 'setup', label: 'Setup' },
          { id: 'how', label: 'How it works' },
          { id: 'cycles', label: 'Cycles' },
        ]}
        value={tab}
        onChange={(t) => go(t === 'lab' ? '/research' : `/research/${t}`)}
      />
      {tab === 'lab' && <ResearchLab key={version} data={data} isAdmin={isAdmin} />}
      {tab === 'setup' && (
        <ResearchSetup data={data} isAdmin={isAdmin} onChanged={() => setVersion((v) => v + 1)} />
      )}
      {tab === 'how' && <ResearchHow />}
      {tab === 'cycles' && <ResearchCycles id={parts[2]} />}
    </section>
  );
}

/** #460: how each Theorist model and each strategy family has done (yield = promising or successful per 100). */
function Scorecards({ kpis }: { kpis: any }) {
  const [win, setWin] = useState<'all' | 'last90' | 'last30'>('all');
  const [by, setBy] = useState<'byModel' | 'byFamily'>('byModel');
  const rows: any[] = kpis?.[win]?.[by] ?? [];
  const n = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? '—' : x.toFixed(d));
  const pc = (x: number | null | undefined) =>
    x === null || x === undefined ? '—' : `${(x * 100).toFixed(0)}%`;
  return (
    <section className="research-scorecards" aria-label="Scorecards">
      <div className="section-heading">
        <h3>Scorecards</h3>
        <span className="spacer" />
        <Tabs
          compact
          label="Group by"
          value={by}
          onChange={setBy}
          tabs={[
            { id: 'byModel', label: 'By model' },
            { id: 'byFamily', label: 'By family' },
          ]}
        />
        <Tabs
          compact
          label="Window"
          value={win}
          onChange={setWin}
          tabs={[
            { id: 'all', label: 'All time' },
            { id: 'last90', label: '90 days' },
            { id: 'last30', label: '30 days' },
          ]}
        />
      </div>
      <div className="table-wrap">
        <table aria-label={by === 'byModel' ? 'Scorecards by model' : 'Scorecards by family'}>
          <thead>
            <tr>
              <th>{by === 'byModel' ? 'Model' : 'Family'}</th>
              <th className="num">Proposed</th>
              <th className="num">Approved</th>
              <th className="num">Evaluated</th>
              <th className="num">Promising</th>
              <th className="num">Successful</th>
              <th className="num">Yield / 100</th>
              <th className="num">Median Sharpe</th>
              <th className="num">Median excess</th>
              <th className="num">Code attempts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{r.key}</td>
                <td className="num">{r.proposed}</td>
                <td className="num">{pc(r.approvedRate)}</td>
                <td className="num">{r.evaluated}</td>
                <td className="num">{r.promising}</td>
                <td className="num">{r.successful}</td>
                <td className="num">{n(r.yieldPer100, 1)}</td>
                <td className="num">{n(r.medianSharpe)}</td>
                <td className="num">{pc(r.medianExcess)}</td>
                <td className="num">{n(r.meanCodeAttempts, 1)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={10} className="muted-line">
                  No ideas in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
