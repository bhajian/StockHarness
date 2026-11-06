// Research → Cycles (#302): every run of the research loop, and for one cycle what each agent did — the skills it
// loaded, its tool calls with their inputs and results, its tokens and cost — and the theories it touched.
import React, { useEffect, useState } from 'react';
import { ArrowLeft, BookOpen, Wrench } from 'lucide-react';
import { api } from '../../api';
import { Skeleton, StatusPill } from '../kit';
import { IdeaStatus } from '../ideas/IdeaStatus';
import { go } from '../ideas/nav';

const mins = (ms: number | null) =>
  ms === null ? '—' : ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`;
const usd = (v: number) => `$${(v ?? 0).toFixed(2)}`;
const when = (v: string) => new Date(v).toLocaleString();

export function ResearchCycles({ id }: { id?: string }) {
  return id ? <Cycle id={id} /> : <CycleList />;
}

function CycleList() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api('/research/cycles')
      .then(setRows)
      .catch((e) => setError(e?.message ?? String(e)));
  }, []);
  if (error)
    return (
      <div className="empty-state">
        <p>{error}</p>
      </div>
    );
  if (!rows) return <Skeleton rows={6} />;
  if (!rows.length)
    return (
      <div className="empty-state">
        <p>No cycles yet. Start the loop in Setup, or run one cycle now.</p>
      </div>
    );
  return (
    <div className="table-wrap">
      <table aria-label="Cycles">
        <thead>
          <tr>
            <th>Started</th>
            <th>Status</th>
            <th className="num">Took</th>
            <th className="num">Cost</th>
            <th className="num">Model calls</th>
            <th className="num">Proposed</th>
            <th className="num">Reviewed</th>
            <th className="num">Coded</th>
            <th className="num">Evaluated</th>
            <th className="num">Judged</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => go(`/research/cycles/${r.id}`)}>
              <td className="nowrap">{when(r.startedAt)}</td>
              <td>
                <StatusPill status={r.status} />
                {r.error && <small className="error-line">{r.error.slice(0, 80)}</small>}
              </td>
              <td className="num">{mins(r.durationMs)}</td>
              <td className="num">{usd(r.usd)}</td>
              <td className="num">{r.calls}</td>
              <td className="num">{r.theories.proposed}</td>
              <td className="num">{r.theories.reviewed}</td>
              <td className="num">{r.theories.coded}</td>
              <td className="num">{r.theories.evaluated}</td>
              <td className="num">{r.theories.judged}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cycle({ id }: { id: string }) {
  const [c, setC] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/research/cycles/${id}`)
      .then(setC)
      .catch((e) => setError(e?.message ?? String(e)));
  }, [id]);
  if (error) return <p className="error-line">{error}</p>;
  if (!c) return <Skeleton rows={8} />;
  return (
    <div className="research-cycle">
      <nav className="breadcrumbs" aria-label="Breadcrumbs">
        <button type="button" className="link-button" onClick={() => go('/research/cycles')}>
          <ArrowLeft size={14} /> Cycles
        </button>
        <span aria-hidden="true">›</span> {when(c.startedAt)}
      </nav>
      <p>
        <StatusPill status={c.status} />{' '}
        {c.finishedAt
          ? `took ${mins(new Date(c.finishedAt).getTime() - new Date(c.startedAt).getTime())}`
          : 'running'}{' '}
        · cost {usd(c.usd)}
        {c.error && <span className="error-line"> · {c.error}</span>}
      </p>
      <h3>Theories this cycle touched</h3>
      {!c.theories.length ? (
        <p className="muted-line">None.</p>
      ) : (
        <ul className="cycle-theories">
          {c.theories.map((t: any) => (
            <li key={t.ref}>
              <button type="button" className="link-button" onClick={() => go(`/ideas/${t.ref}`)}>
                <span className="mono">{t.ref}</span> {t.title}
              </button>{' '}
              <IdeaStatus status={t.status} />
              <ol className="cycle-events">
                {t.events.map((e: any, i: number) => (
                  <li key={i}>
                    <strong>{e.role}</strong> {e.type === 'transition' ? `${e.from} → ${e.to}` : e.type}
                    {e.reasoning && <small className="muted-line"> — {e.reasoning.slice(0, 200)}</small>}
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      )}
      <h3>What each agent did</h3>
      {c.agents.map((a: any) => (
        <details key={a.id} className="card-panel cycle-agent">
          <summary>
            <strong>{a.name}</strong>{' '}
            <StatusPill status={a.status === 'completed' ? 'succeeded' : a.status} />
            <span className="muted-line">
              {a.model ?? ''} · {a.calls} model calls · {(a.input + a.output_tokens).toLocaleString()} tokens
              · ${a.usd.toFixed(2)} · {a.tools.length} tool calls
            </span>
          </summary>
          {a.skills.length > 0 && (
            <p>
              <BookOpen size={13} /> Loaded skills:{' '}
              {a.skills.map((k: string) => (
                <code key={k} className="chip static">
                  {k}
                </code>
              ))}
            </p>
          )}
          <ol className="cycle-tools">
            {a.tools.map((t: any, i: number) => (
              <li key={i}>
                <details>
                  <summary>
                    <Wrench size={12} /> <code>{t.tool}</code>{' '}
                    {t.error && <StatusPill status="error" label="error" />}
                  </summary>
                  <div className="cycle-io">
                    <small className="muted-line">input</small>
                    <pre>{t.arguments || '—'}</pre>
                    <small className="muted-line">result</small>
                    <pre>{t.result ?? '—'}</pre>
                  </div>
                </details>
              </li>
            ))}
          </ol>
          {a.output && (
            <>
              <small className="muted-line">Its final answer</small>
              <pre className="cycle-output">{a.output}</pre>
            </>
          )}
        </details>
      ))}
    </div>
  );
}
