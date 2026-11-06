// Research → How it works (#302): the research loop as the pipeline it is — each step's agent, its model, the
// skills it loads, the MCP connection and tools it may call, and what it reads and writes.
import React, { useEffect, useState } from 'react';
import { ArrowRight, Bot, BookOpen, Database, Plug, Wrench } from 'lucide-react';
import { api } from '../../api';
import { Skeleton } from '../kit';
import { go } from '../ideas/nav';

export function ResearchHow() {
  const [how, setHow] = useState<any>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string>('');
  useEffect(() => {
    api('/research/how')
      .then((h) => {
        setHow(h);
        const first = h.steps.find((s: any) => s.kind === 'parallel')?.agents?.[0]?.id ?? '';
        setOpen(first);
      })
      .catch((e) => setError(e?.message ?? String(e)));
  }, []);
  if (error)
    return (
      <div className="empty-state">
        <p>{error}</p>
      </div>
    );
  if (!how) return <Skeleton rows={8} />;
  const agents: any[] = how.steps.flatMap((s: any) =>
    s.kind === 'parallel' ? s.agents : s.kind === 'agent' ? [s] : [],
  );
  const selected = agents.find((a) => a.id === open);
  return (
    <div className="research-how">
      <p className="muted-line">
        Each cycle runs the harness <strong>{how.harness.name}</strong> once, left to right. The agents never
        talk to each other directly: they work on shared records (theories, code, evaluations) through the
        research MCP tools, and each agent&apos;s connection only offers the tools of its role. Click a step
        to see what it uses.
      </p>
      <ol className="how-pipeline" aria-label="The research loop">
        {how.steps.map((s: any, i: number) => (
          <li key={s.id} className={`how-step kind-${s.kind}`}>
            {s.kind === 'parallel' ? (
              <div className="how-parallel" aria-label={`${s.name}: in parallel`}>
                <small className="muted-line">{s.name} · in parallel</small>
                {s.agents.map((a: any) => (
                  <StepCard key={a.id} a={a} active={open === a.id} onClick={() => setOpen(a.id)} />
                ))}
              </div>
            ) : s.kind === 'agent' ? (
              <StepCard a={s} active={open === s.id} onClick={() => setOpen(s.id)} />
            ) : (
              <div className="how-terminal">{s.name}</div>
            )}
            {i < how.steps.length - 1 && <ArrowRight size={16} className="how-arrow" aria-hidden="true" />}
          </li>
        ))}
      </ol>
      {selected && (
        <div className="card-panel how-detail" aria-label={`${selected.name} details`}>
          <h3>
            <Bot size={16} /> {selected.name} <small className="muted-line">{selected.role}</small>
          </h3>
          <div className="how-grid">
            <div>
              <h4>Model</h4>
              <p>
                {selected.model ? (
                  <>
                    {selected.model.name} · <code>{selected.model.model}</code>
                  </>
                ) : (
                  'the default chat model'
                )}
                <br />
                <small className="muted-line">
                  effort {selected.effort ?? '—'} · up to {selected.maxTurns ?? '—'} turns
                  {selected.pattern === 'loop' ? ' · loops until its queue is empty' : ''}
                </small>
              </p>
              <h4>
                <Database size={14} /> Reads
              </h4>
              <ul>
                {selected.reads.map((r: string) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <h4>Writes</h4>
              <ul>
                {selected.writes.map((r: string) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
            <div>
              <h4>
                <BookOpen size={14} /> Skills ({selected.skills.length})
              </h4>
              <p className="muted-line">
                Instructions the agent can load when it needs them (see each cycle for which it did).
              </p>
              <ul className="how-skills">
                {selected.skills.map((k: any) => (
                  <li key={k.id}>
                    <button type="button" className="link-button" onClick={() => go('/skills')}>
                      {k.name}
                    </button>
                    {k.description && <small className="muted-line">{k.description}</small>}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              {selected.connections.map((c: any) => (
                <div key={c.id}>
                  <h4>
                    <Plug size={14} /> {c.name}{' '}
                    {c.role && <small className="muted-line">role: {c.role}</small>}
                  </h4>
                  <p className="muted-line">
                    <Wrench size={12} /> The tools this agent may call ({c.tools.length}):
                  </p>
                  <div className="chips">
                    {c.tools.map((t: string) => (
                      <code key={t} className="chip static">
                        {t}
                      </code>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <details>
            <summary>Its instructions (system prompt)</summary>
            <pre className="how-prompt">{selected.prompt}</pre>
          </details>
        </div>
      )}
    </div>
  );
}

function StepCard({ a, active, onClick }: { a: any; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`how-card${active ? ' active' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      <strong>{a.name}</strong>
      <small>{a.model?.model ?? 'default model'}</small>
      <small>
        {a.skills.length} skills · {a.connections.reduce((n: number, c: any) => n + c.tools.length, 0)} tools
      </small>
    </button>
  );
}
