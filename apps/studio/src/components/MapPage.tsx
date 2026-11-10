// The Map (#312): how the whole workspace connects, on one page — data sources → data prep → research setup →
// ideas → evaluations → simulations — with a "start here" checklist. Every box says what it is, when it runs and
// where to see the result, and links to the page where it is changed.
import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Bot,
  CandlestickChart,
  CheckCircle2,
  Circle,
  Code2,
  Database,
  FlaskConical,
  Lightbulb,
  Target,
} from 'lucide-react';
import { api } from '../api';
import { Skeleton, StatusPill } from './kit';
import { IdeaStatus } from './ideas/IdeaStatus';
import { go } from './ideas/nav';

const n = (v: unknown) => (typeof v === 'number' ? v.toLocaleString() : '—');
const when = (v?: string | null) => (v ? new Date(v).toLocaleString() : 'never');
const SYNC_PILL: Record<string, string> = {
  ok: 'ok',
  failing: 'failed',
  paused: 'blocked',
  off: 'disabled',
  manual: 'pending',
};

export function MapPage() {
  const [m, setM] = useState<any>(null);
  const [error, setError] = useState('');
  const [showAllSources, setShowAllSources] = useState(false);
  useEffect(() => {
    const load = () =>
      api('/map')
        .then(setM)
        .catch((e) => setError(e?.message ?? String(e)));
    void load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);
  if (error) return <p className="error-line">{error}</p>;
  if (!m) return <Skeleton rows={10} />;
  const failing = m.sources.filter((s: any) => ['failing', 'paused'].includes(s.status));
  const sources = showAllSources
    ? m.sources
    : [...failing, ...m.sources.filter((s: any) => !failing.includes(s))].slice(0, 8);
  const first = m.checklist.find((c: any) => !c.done);
  return (
    <section className="page-section map-page">
      <header className="page-head">
        <div>
          <h2>Map</h2>
          <p className="muted-line">
            How the workspace fits together, left to right: data comes in, is prepared point in time, the
            research agents turn it into ideas, ideas are evaluated, and the good ones are simulated. Click
            any box to open or change it.
          </p>
        </div>
      </header>

      <ol className="map-checklist" aria-label="Start here">
        {m.checklist.map((c: any, i: number) => (
          <li key={c.step} className={`${c.done ? 'done' : ''}${first === c ? ' next' : ''}`}>
            <button type="button" onClick={() => go(c.href)}>
              {c.done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
              <span>
                <strong>
                  {i + 1}. {c.label}
                </strong>
                <small>{c.detail}</small>
              </span>
              {first === c && <span className="map-next">start here</span>}
            </button>
          </li>
        ))}
      </ol>

      <div className="map-flow" aria-label="The workspace">
        <Column
          n={1}
          icon={<Database size={16} />}
          title="Data sources"
          sub="Layer 1 · synced from FMP"
          href="/datasets/syncs"
        >
          <p className="map-note">
            {m.sources.length} syncs · {m.sources.filter((s: any) => s.status === 'ok').length} on a schedule
            {failing.length ? ` · ${failing.length} need attention` : ''}
          </p>
          {sources.map((s: any) => (
            <button
              key={s.id}
              type="button"
              className="map-card"
              onClick={() => go(`/datasets/syncs/${s.id}`)}
            >
              <span className="map-card-head">
                <strong>{s.name}</strong>
                <StatusPill status={SYNC_PILL[s.status] ?? 'pending'} label={s.status} />
              </span>
              <small>
                → <code>{s.collection}</code>
                {s.rows !== null && s.rows !== undefined ? ` · ${n(s.rows)} rows` : ''}
              </small>
              <small>{s.runs}</small>
              {s.pausedReason && <small className="error-line">{s.pausedReason.slice(0, 140)}</small>}
              {!s.pausedReason && s.error && <small className="error-line">{s.error.slice(0, 140)}</small>}
            </button>
          ))}
          {m.sources.length > 8 && (
            <button type="button" className="link-button" onClick={() => setShowAllSources(!showAllSources)}>
              {showAllSources ? 'Show fewer' : `Show all ${m.sources.length}`}
            </button>
          )}
        </Column>

        <Arrow label="raw collections" />

        <Column
          n={2}
          icon={<Code2 size={16} />}
          title="Data prep"
          sub="Layer 2 · point-in-time collections"
          href="/datasets/transforms"
        >
          <p className="map-note">
            Each transform is a Python script. When the data it reads changes, it runs by itself and rewrites
            its output collections, so every row says when it became known.
          </p>
          {!m.prep.length && <p className="muted-line">No transforms yet.</p>}
          {m.prep.map((t: any) => (
            <div key={t.id} className="map-card static">
              <span className="map-card-head">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => go(`/datasets/transforms/${t.name}`)}
                >
                  <strong>{t.name}</strong>
                </button>
                {t.lastRun ? (
                  <StatusPill status={t.lastRun.status} />
                ) : (
                  <StatusPill status="pending" label="never ran" />
                )}
              </span>
              <small>
                reads{' '}
                {t.reads.map((r: any, i: number) => (
                  <React.Fragment key={r.collection}>
                    {i ? ', ' : ''}
                    <code>{r.collection}</code>
                  </React.Fragment>
                ))}
              </small>
              <small>
                writes{' '}
                {t.writes.map((w: any, i: number) => (
                  <React.Fragment key={w.collection}>
                    {i ? ', ' : ''}
                    <button
                      type="button"
                      className="link-button"
                      title="See the rows"
                      onClick={() => go(`/datasets/catalog/${w.collection}`)}
                    >
                      <code>{w.collection}</code>
                    </button>
                    {w.rows !== null && w.rows !== undefined
                      ? ` (${n(w.rows)} rows${w.latest ? `, to ${String(w.latest).slice(0, 10)}` : ''})`
                      : ''}
                  </React.Fragment>
                ))}
              </small>
              <small>{t.runs}</small>
              {t.lastRun && (
                <small className="muted-line">
                  last run {when(t.lastRun.at)}
                  {t.lastRun.rows ? ` · ${n(t.lastRun.rows)} rows written` : ''}
                </small>
              )}
            </div>
          ))}
        </Column>

        <Arrow label="point-in-time data" />

        <Column
          n={3}
          icon={<FlaskConical size={16} />}
          title="Research setup"
          sub="Layer 4 · the agents"
          href="/research/setup"
        >
          {!m.research.installed ? (
            <div className="map-card static">
              <strong>Not set up yet</strong>
              <small>Choose the scope, the model and the skills for each agent, then Start.</small>
              <button type="button" className="button primary small" onClick={() => go('/research/setup')}>
                Set up research
              </button>
            </div>
          ) : (
            <>
              <button type="button" className="map-card" onClick={() => go('/research/setup')}>
                <span className="map-card-head">
                  <strong>
                    <Target size={13} /> Scope
                  </strong>
                </span>
                <small>{m.research.scope}</small>
                <small>
                  {m.research.years} years before the holdout · {m.research.runs}
                  {m.research.paused ? ' · paused' : ''}
                </small>
              </button>
              <div className="map-card static">
                <strong>
                  <Database size={13} /> Data the agents can read
                </strong>
                <small>
                  {m.research.readable.length} collections through the research data tools:{' '}
                  {m.research.readable.slice(0, 10).join(', ')}
                  {m.research.readable.length > 10 ? ' …' : ''}
                </small>
              </div>
              {groupAgents(m.research.agents).map((a: any) => (
                <button key={a.id} type="button" className="map-card" onClick={() => go('/research/how')}>
                  <span className="map-card-head">
                    <strong>
                      <Bot size={13} /> {a.name}
                      {a.count > 1 ? ` ×${a.count}` : ''}
                    </strong>
                  </span>
                  <small>
                    model <code>{a.model ?? 'default'}</code>
                  </small>
                  <small>
                    <BookOpen size={11} /> {a.skills.length ? a.skills.join(', ') : 'no skills'} · {a.tools}{' '}
                    tools
                  </small>
                </button>
              ))}
              {m.research.spend && (
                <small className="muted-line">
                  spend today ${m.research.spend.today.toFixed(2)}
                  {m.research.spend.capUsd !== undefined
                    ? ` · $${(m.research.spend.sinceCap ?? 0).toFixed(2)} of $${m.research.spend.capUsd} cap`
                    : ''}
                </small>
              )}
            </>
          )}
        </Column>

        <Arrow label="theories" />

        <Column
          n={4}
          icon={<Lightbulb size={16} />}
          title="Ideas"
          sub="theories, reviewed and judged"
          href="/ideas?show=all"
        >
          <button type="button" className="map-card" onClick={() => go('/ideas?show=all')}>
            <strong className="map-big">{n(m.ideas.total)}</strong>
            <small>
              <IdeaStatus status="successful" /> {m.ideas.successful}
            </small>
            <small>
              <IdeaStatus status="promising" /> {m.ideas.promising ?? 0}
            </small>
            <small>
              <IdeaStatus status="failed" /> {m.ideas.failed}
            </small>
            <small>
              <IdeaStatus status="coding" /> {m.ideas.inProgress} in progress
            </small>
          </button>
          <button type="button" className="map-card" onClick={() => go('/evaluations')}>
            <strong>Evaluations</strong>
            <small>
              {n(m.evaluations.total)} runs of the trusted evaluator · {n(m.evaluations.holdouts)} one-shot
              holdouts
            </small>
          </button>
        </Column>

        <Arrow label="approved ideas" />

        <Column
          n={5}
          icon={<CandlestickChart size={16} />}
          title="Simulations"
          sub="ideas run as a book"
          href="/simulations"
        >
          <button
            type="button"
            className="map-card"
            onClick={() => go(m.simulations.last ? `/simulations/${m.simulations.last.id}` : '/simulations')}
          >
            <strong className="map-big">{n(m.simulations.total)}</strong>
            {m.simulations.last ? (
              <small>
                last: {m.simulations.last.name} · <StatusPill status={m.simulations.last.status} />
                {typeof m.simulations.last.sharpe === 'number'
                  ? ` · Sharpe ${m.simulations.last.sharpe.toFixed(2)}`
                  : ''}
              </small>
            ) : (
              <small>Open an idea and press Simulate.</small>
            )}
          </button>
        </Column>
      </div>
    </section>
  );
}

function Column({
  n,
  icon,
  title,
  sub,
  href,
  children,
}: {
  n: number;
  icon: React.ReactNode;
  title: string;
  sub: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <div className="map-column" aria-label={title}>
      <button type="button" className="map-column-head" onClick={() => go(href)}>
        <span className="map-step">{n}</span>
        <span>
          <strong>
            {icon} {title}
          </strong>
          <small>{sub}</small>
        </span>
      </button>
      <div className="map-column-body">{children}</div>
    </div>
  );
}
function Arrow({ label }: { label: string }) {
  return (
    <div className="map-arrow" aria-hidden="true">
      <ArrowRight size={18} />
      <small>{label}</small>
    </div>
  );
}

/** Parallel agents with the same role, model and skills (the Theorists) show as one card. */
function groupAgents(agents: any[]) {
  const out: any[] = [];
  for (const a of agents) {
    const key = `${a.role}|${a.model}|${a.skills.join(',')}`;
    const g = out.find((x) => x.key === key);
    if (g) g.count += 1;
    else out.push({ ...a, key, count: 1, name: a.role === 'theorist' ? 'Theorist' : a.name });
  }
  return out;
}
