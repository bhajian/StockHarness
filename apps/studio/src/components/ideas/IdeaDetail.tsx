// One idea (#120, #121, #122): header with status and actions, the gate checklist and KPIs, then tabs bound to the
// URL — Overview (thesis, data), Results (the evaluation proof pack and the one-shot holdout), Review (the debate,
// with every cited number checked against the evaluations), Code (each version, diffed against the one before) and
// Runs (every evaluation, with reproduce).
import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CandlestickChart,
  Check,
  ClipboardCopy,
  Code2,
  Download,
  FileText,
  FlaskConical,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Undo2,
  XCircle,
} from 'lucide-react';
import { api, send } from '../../api';
import { GateChecklist, KpiCard, Skeleton, StatusPill, Tabs } from '../kit';
import { CodeEditor } from '../../editor/CodeEditor';
import { EvaluationReport } from '../EvaluationsPage';
import { SubsetPanel } from '../SubsetPanel';
import { IdeaStatus } from './IdeaStatus';
import { STATUS_LABEL, go, num, pct } from './nav';

type TabId = 'overview' | 'results' | 'review' | 'code' | 'runs';
const TABS: TabId[] = ['overview', 'results', 'review', 'code', 'runs'];
const ROLE_LABEL: Record<string, string> = {
  theorist: 'Theorist',
  judge: 'Judge',
  coder: 'Coder',
  evaluator: 'Evaluator',
  human: 'Person',
};
const when = (v: string) => new Date(v).toLocaleString();
const fmtGate = (v: unknown) =>
  typeof v === 'number'
    ? Number.isInteger(v)
      ? v.toLocaleString()
      : Math.abs(v) < 10
        ? v.toFixed(2)
        : v.toFixed(1)
    : String(v ?? '—');

export function IdeaDetail({ id, tab, isAdmin }: { id: string; tab: string; isAdmin: boolean }) {
  const [idea, setIdea] = useState<any>(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<null | 'reject' | 'send_back' | 'park'>(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const load = () =>
    api(`/ideas/${encodeURIComponent(id)}`)
      .then((x) => {
        setIdea(x);
        setError('');
      })
      .catch((e) => setError(e?.message ?? String(e)));
  useEffect(() => {
    setIdea(null);
    void load();
  }, [id]);
  const current = (TABS.includes(tab as TabId) ? tab : 'overview') as TabId;
  if (error) return <p className="error-line">{error}</p>;
  if (!idea) return <Skeleton rows={10} />;
  const t = idea.theory;
  const act = async (action: string, comment = '') => {
    setBusy(action);
    try {
      setIdea(await send(`/ideas/${t.id}/actions`, { action, comment }));
      setNotice(
        `${idea.ref} is now ${STATUS_LABEL[{ approve: 'approved', park: 'parked', reject: 'failed', send_back: 'revise' }[action]!]?.toLowerCase()}.`,
      );
      setDialog(null);
    } catch (e: any) {
      setNotice(e?.message ?? String(e));
    } finally {
      setBusy('');
    }
  };
  const reproduce = async (evaluationId?: string) => {
    setBusy('reproduce');
    setNotice('Reproducing the evaluation (same code, same parameters, not a new trial)…');
    try {
      const r = await send(`/ideas/${t.id}/reproduce`, evaluationId ? { evaluationId } : {});
      const m = r.reproduction.reproduces?.match;
      setNotice(
        r.reproduction.status === 'running'
          ? 'The reproduction is still running; it will appear under Runs.'
          : m === true
            ? 'Reproduced: the record hash matches the original.'
            : m === false
              ? 'The reproduction does not match the original record (see Runs).'
              : `Reproduction ${r.reproduction.status}.`,
      );
      go(`/ideas/${idea.ref}/runs`);
      void load();
    } catch (e: any) {
      setNotice(e?.message ?? String(e));
    } finally {
      setBusy('');
    }
  };
  const gates = idea.gates.results.map((g: any) => ({
    name: g.gate,
    value: fmtGate(g.value),
    threshold: fmtGate(g.threshold),
    pass: g.passed,
    definition: g.detail,
  }));
  return (
    <section className="page-section idea-page">
      <nav className="breadcrumbs" aria-label="Breadcrumbs">
        <button type="button" className="link-button" onClick={() => go('/ideas')}>
          <ArrowLeft size={14} /> Ideas
        </button>
        <span aria-hidden="true">›</span> <span className="mono">{idea.ref}</span>
      </nav>
      <header className="idea-head">
        <div>
          <h2>
            <span className="mono muted-line">{idea.ref}</span> {t.title}
          </h2>
          <div className="idea-meta">
            <IdeaStatus status={idea.status} />
            {idea.forwardOnly && <StatusPill status="forward-only" label="forward only" />}
            <span>{t.family}</span>
            <span>{t.direction.replace('_', ' / ')}</span>
            <span>{t.horizonDays}-day horizon</span>
            <span>
              gates v{idea.gates.version}
              {idea.gates.final ? ' (locked by the verdict)' : ' (current)'}
            </span>
            <span>
              {t.revisions} revision{t.revisions === 1 ? '' : 's'} · {t.trials} trial
              {t.trials === 1 ? '' : 's'}
            </span>
            {Object.entries(idea.models as Record<string, string[]>).map(([role, ms]) => (
              <span key={role} title={`${ROLE_LABEL[role] ?? role} model`}>
                {ROLE_LABEL[role] ?? role}: {ms.join(', ')}
              </span>
            ))}
          </div>
        </div>
        <div className="idea-actions">
          {isAdmin && idea.actions.approve && (
            <button type="button" className="button primary" disabled={!!busy} onClick={() => act('approve')}>
              <Check size={14} /> Approve
            </button>
          )}
          {isAdmin && idea.actions.park && (
            <button type="button" className="button" disabled={!!busy} onClick={() => setDialog('park')}>
              <PauseCircle size={14} /> Park
            </button>
          )}
          {isAdmin && idea.actions.reject && (
            <button
              type="button"
              className="button danger"
              disabled={!!busy}
              onClick={() => setDialog('reject')}
            >
              <XCircle size={14} /> Reject…
            </button>
          )}
          {isAdmin && idea.actions.sendBack && (
            <button type="button" className="button" disabled={!!busy} onClick={() => setDialog('send_back')}>
              <Undo2 size={14} /> Send back…
            </button>
          )}
          {isAdmin && idea.explore && (
            <button type="button" className="button" disabled={!!busy} onClick={() => reproduce()}>
              <RotateCcw size={14} /> Reproduce
            </button>
          )}
          {isAdmin && idea.explore && (
            <button
              type="button"
              className="button"
              title="Run this idea through the paper broker"
              onClick={() => go(`/simulations?new=${idea.ref}`)}
            >
              <CandlestickChart size={14} /> Simulate
            </button>
          )}
          <a className="button" href={`/api/ideas/${t.id}/export`} download>
            <Download size={14} /> Export YAML
          </a>
        </div>
      </header>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="kpi-row">
        <KpiCard label="Sharpe" value={num(idea.sharpe)} footnote="exploration, after costs" />
        <KpiCard
          label="Deflated Sharpe"
          value={pct(idea.deflatedSharpe, 0)}
          footnote={`over ${t.trials} trial${t.trials === 1 ? '' : 's'}`}
        />
        <KpiCard label="Excess / year" value={pct(idea.excessPerYear)} footnote="over the S&P 500" />
        <KpiCard label="Max drawdown" value={pct(idea.maxDrawdown)} />
        <KpiCard
          label="Holdout"
          value={
            idea.holdout?.status === 'succeeded'
              ? num(idea.holdout.sharpe)
              : (idea.holdout?.status ?? 'not run')
          }
          footnote={
            idea.holdout?.status === 'succeeded'
              ? `excess ${pct(idea.holdout.excess)} · evaluated once`
              : 'one shot, at the verdict'
          }
        />
      </div>
      <div className="idea-summary">
        <div className="card-panel">
          <h3>Gates</h3>
          {gates.length ? (
            <GateChecklist gates={gates} />
          ) : (
            <p className="muted-line">No evaluation yet, so the gates have nothing to check.</p>
          )}
          {idea.gates.mechanical && (
            <p className="muted-line">
              Mechanical verdict: <strong>{idea.gates.mechanical}</strong>
            </p>
          )}
        </div>
        <div className="card-panel">
          <h3>Judge</h3>
          {idea.judgeSummary ? (
            <>
              <p className="muted-line">
                {STATUS_LABEL[idea.judgeSummary.to] ?? idea.judgeSummary.to} · {when(idea.judgeSummary.at)}
                {idea.judgeSummary.model ? ` · ${idea.judgeSummary.model}` : ''}
              </p>
              <p className="prose">{idea.judgeSummary.reasoning}</p>
              <button type="button" className="link-button" onClick={() => go(`/ideas/${idea.ref}/review`)}>
                Read the whole review
              </button>
            </>
          ) : (
            <p className="muted-line">The Judge has not reviewed this idea yet.</p>
          )}
        </div>
      </div>
      <Tabs
        tabs={[
          { id: 'overview', label: 'Overview', icon: <FileText size={14} /> },
          { id: 'results', label: 'Results', icon: <FlaskConical size={14} /> },
          { id: 'review', label: 'Review', icon: <MessageSquare size={14} /> },
          { id: 'code', label: 'Code', icon: <Code2 size={14} /> },
          { id: 'runs', label: 'Runs', icon: <PlayCircle size={14} /> },
        ]}
        value={current}
        onChange={(next) => go(`/ideas/${idea.ref}${next === 'overview' ? '' : `/${next}`}`)}
      />
      {current === 'overview' && <Overview t={t} />}
      {current === 'results' && <Results idea={idea} />}
      {current === 'review' && <Review id={t.id} isAdmin={isAdmin} onChanged={setIdea} />}
      {current === 'code' && <CodeTab id={t.id} />}
      {current === 'runs' && <Runs id={t.id} isAdmin={isAdmin} reproduce={reproduce} busy={!!busy} />}
      {dialog && (
        <ActionDialog
          action={dialog}
          refName={idea.ref}
          busy={!!busy}
          onCancel={() => setDialog(null)}
          onSubmit={(comment) => act(dialog, comment)}
        />
      )}
    </section>
  );
}

function ActionDialog({
  action,
  refName,
  busy,
  onCancel,
  onSubmit,
}: {
  action: 'reject' | 'send_back' | 'park';
  refName: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (comment: string) => void;
}) {
  const [text, setText] = useState('');
  const copy = {
    reject: { title: `Reject ${refName}`, label: 'Why is it rejected?', button: 'Reject', min: 5 },
    send_back: {
      title: `Send ${refName} back to the Theorist`,
      label: 'What should the Theorist change?',
      button: 'Send back',
      min: 5,
    },
    park: { title: `Park ${refName}`, label: 'Note (optional)', button: 'Park', min: 0 },
  }[action];
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={copy.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title">
          <h2>{copy.title}</h2>
        </div>
        <label className="field">
          <span>{copy.label}</span>
          <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </label>
        {action === 'send_back' && (
          <p className="muted-line">
            The comment reaches the Theorist in the next research cycle&apos;s brief.
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`button ${action === 'reject' ? 'danger' : 'primary'}`}
            disabled={busy || text.trim().length < copy.min}
            onClick={() => onSubmit(text)}
          >
            {copy.button}
          </button>
        </div>
      </div>
    </div>
  );
}

function Overview({ t }: { t: any }) {
  const sections: [string, string][] = [
    ['Hypothesis', t.hypothesis],
    ['Why it should work', t.rationale],
    ['Signal', t.signalLogic],
    ['What would prove it wrong', t.falsification],
    ['Universe', t.universe],
    ...(t.differsFrom ? ([['How it differs from earlier ideas', t.differsFrom]] as [string, string][]) : []),
  ];
  return (
    <div className="idea-overview">
      <dl className="prose-list">
        {sections
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>
      <aside className="card-panel">
        <h3>Data</h3>
        {t.dataNeeded.length ? (
          <ul className="chip-list">
            {t.dataNeeded.map((d: string) => (
              <li key={d}>
                <button
                  type="button"
                  className="chip"
                  title="Open in the Schema Catalog"
                  onClick={() => go(`/datasets/catalog/${encodeURIComponent(d.split('.')[0]!)}`)}
                >
                  {d}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted-line">No data listed.</p>
        )}
        {t.forwardOnly && (
          <p className="notice">
            <AlertTriangle size={14} /> Uses snapshot-only data, so it can only be tracked forward, not
            backtested.
          </p>
        )}
        {t.tags?.length > 0 && (
          <>
            <h3>Tags</h3>
            <ul className="chip-list">
              {t.tags.map((x: string) => (
                <li key={x} className="chip static">
                  {x}
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}

/** The latest exploration record's proof pack, and the holdout evaluated once at the verdict. */
function Results({ idea }: { idea: any }) {
  const [explore, setExplore] = useState<any>(null);
  const [holdout, setHoldout] = useState<any>(null);
  useEffect(() => {
    if (idea.explore) void api(`/evaluations/${idea.explore.id}`).then(setExplore);
    if (idea.holdoutEvaluation) void api(`/evaluations/${idea.holdoutEvaluation.id}`).then(setHoldout);
  }, [idea.explore?.id, idea.holdoutEvaluation?.id]);
  if (!idea.explore)
    return (
      <div className="empty-state">
        <p>No finished evaluation yet.</p>
        <button type="button" className="link-button" onClick={() => go(`/ideas/${idea.ref}/runs`)}>
          See the runs
        </button>
      </div>
    );
  return (
    <div className="idea-results">
      <div className="section-heading">
        <h3>
          Exploration · v{idea.explore.pluginVersion} · trial {idea.explore.trial}
        </h3>
        <span className="muted-line">
          {idea.explore.params?.start} → {idea.explore.params?.end} · evaluator{' '}
          {idea.explore.evaluatorVersion} · prices as of {idea.explore.dataSnapshot?.prices_as_of ?? '—'}
        </span>
        <button type="button" className="link-button" onClick={() => go(`/evaluations/${idea.explore.id}`)}>
          Open the evaluation
        </button>
      </div>
      {idea.holdoutEvaluation && (
        <div className="card-panel holdout-panel">
          <h3>
            Holdout <StatusPill status="warn" label="evaluated once" />
          </h3>
          {idea.holdoutEvaluation.status === 'succeeded' ? (
            <p>
              Sharpe {num(idea.holdoutEvaluation.summary?.sharpe)} · CAGR{' '}
              {pct(idea.holdoutEvaluation.summary?.cagr)} · excess / year{' '}
              {pct(idea.holdoutEvaluation.excess?.spx?.excess_cagr)} · max drawdown{' '}
              {pct(idea.holdoutEvaluation.summary?.max_drawdown)}{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => go(`/evaluations/${idea.holdoutEvaluation.id}`)}
              >
                Open
              </button>
            </p>
          ) : (
            <p className="muted-line">{idea.holdoutEvaluation.status}</p>
          )}
          {holdout?.record && (
            <details>
              <summary>Holdout proof pack</summary>
              <EvaluationReport record={holdout.record} />
            </details>
          )}
        </div>
      )}
      {explore?.status === 'succeeded' && explore.mode === 'explore' && (
        <SubsetPanel evaluationId={explore.id} />
      )}
      {explore?.record ? <EvaluationReport record={explore.record} /> : <Skeleton rows={6} />}
    </div>
  );
}

/** The debate: every agent turn, with each number marked sourced (links to its evaluation) or unsourced. */
function Review({
  id,
  isAdmin,
  onChanged,
}: {
  id: string;
  isAdmin: boolean;
  onChanged: (idea: any) => void;
}) {
  const [events, setEvents] = useState<any[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api(`/ideas/${id}/debate`).then(setEvents);
  useEffect(() => {
    void load();
  }, [id]);
  if (!events) return <Skeleton rows={6} />;
  const comment = async () => {
    setBusy(true);
    try {
      onChanged(await send(`/ideas/${id}/comments`, { text }));
      setText('');
      await load();
    } finally {
      setBusy(false);
    }
  };
  const unsourced = events.reduce((n, e) => n + e.numbers.filter((c: any) => !c.evaluationId).length, 0);
  return (
    <div className="idea-review">
      <p className="muted-line">
        {events.length} events. Numbers the agents cite are checked against this idea&apos;s evaluations:{' '}
        <span className="num-chip sourced">sourced</span> links to the evaluation it comes from,{' '}
        <span className="num-chip unsourced">unsourced</span> matches none
        {unsourced ? ` (${unsourced} here)` : ''}.
      </p>
      <ol className="debate">
        {events.map((e) => (
          <li key={e.i} className={`debate-turn role-${e.role}`}>
            <span className="debate-avatar" aria-hidden="true">
              {(ROLE_LABEL[e.role] ?? e.role)[0]}
            </span>
            <div>
              <div className="debate-head">
                <strong>{ROLE_LABEL[e.role] ?? e.role}</strong>
                <span>{describe(e)}</span>
                {e.to && <IdeaStatus status={e.to} />}
                {e.model && <span className="muted-line">{e.model}</span>}
                <time className="muted-line">{when(e.at)}</time>
              </div>
              <p className="prose">{withChips(e.reasoning, e.numbers)}</p>
              {e.data?.gates && (
                <details>
                  <summary>Gates at the verdict (v{e.data.gatesVersion})</summary>
                  <GateChecklist
                    gates={e.data.gates.map((g: any) => ({
                      name: g.gate,
                      value: fmtGate(g.value),
                      threshold: fmtGate(g.threshold),
                      pass: g.passed,
                      definition: g.detail,
                    }))}
                  />
                </details>
              )}
            </div>
          </li>
        ))}
      </ol>
      {isAdmin && (
        <div className="comment-box">
          <label className="field">
            <span>Add a comment</span>
            <textarea
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Notes for the team; to ask the Theorist for changes use Send back."
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={busy || text.trim().length < 2}
            onClick={comment}
          >
            <MessageSquare size={14} /> Comment
          </button>
        </div>
      )}
    </div>
  );
}
function describe(e: any) {
  if (e.type === 'create') return 'proposed the idea';
  if (e.type === 'edit') return 'revised the idea';
  if (e.type === 'comment') return 'commented';
  if (e.type === 'link') return 'linked an evaluation';
  return `${STATUS_LABEL[e.from] ?? e.from} → ${STATUS_LABEL[e.to] ?? e.to}`;
}
/** The text with each cited number wrapped in a chip. */
function withChips(text: string, chips: { text: string; evaluationId: string | null }[]) {
  if (!chips.length) return text;
  const out: React.ReactNode[] = [];
  let rest = text;
  chips.forEach((c, i) => {
    const at = rest.indexOf(c.text);
    if (at < 0) return;
    out.push(rest.slice(0, at));
    out.push(
      c.evaluationId ? (
        <button
          key={i}
          type="button"
          className="num-chip sourced"
          title="Open the evaluation this number comes from"
          onClick={() => go(`/evaluations/${c.evaluationId}`)}
        >
          {c.text}
        </button>
      ) : (
        <span key={i} className="num-chip unsourced" title="Not found in this idea's evaluations">
          {c.text}
        </span>
      ),
    );
    rest = rest.slice(at + c.text.length);
  });
  out.push(rest);
  return out;
}

/** Every version of the idea's plugin: the test outcome, the error, the code, and a diff against the version before. */
function CodeTab({ id }: { id: string }) {
  const [version, setVersion] = useState<number | undefined>();
  const [data, setData] = useState<any>(null);
  const [diff, setDiff] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void api(`/ideas/${id}/code${version ? `?version=${version}` : ''}`).then(setData);
  }, [id, version]);
  if (!data) return <Skeleton rows={6} />;
  if (!data.plugin)
    return (
      <div className="empty-state">
        <p>The Coder has not written code for this idea yet.</p>
      </div>
    );
  const s = data.selected;
  return (
    <div className="idea-code">
      <aside className="version-list" aria-label="Versions">
        <h3>{data.plugin.name}</h3>
        <ol>
          {data.versions.map((v: any) => (
            <li key={v.version}>
              <button
                type="button"
                className={s?.version === v.version ? 'active' : ''}
                aria-current={s?.version === v.version}
                onClick={() => setVersion(v.version)}
              >
                <strong>v{v.version}</strong>
                {v.error ? (
                  <StatusPill status="error" label="error" />
                ) : v.tested ? (
                  <StatusPill status={v.tested === 'passed' ? 'ok' : 'failed'} label={v.tested} />
                ) : null}
                {data.plugin.current === v.version && <StatusPill status="ready" label="current" />}
                <small className="muted-line">{v.note || when(v.createdAt)}</small>
              </button>
            </li>
          ))}
        </ol>
      </aside>
      {s && (
        <div className="version-body">
          <div className="section-heading">
            <h3>
              v{s.version} <code className="muted-line">{s.hash?.slice(0, 19)}</code>
            </h3>
            <span className="muted-line">{when(s.createdAt)}</span>
            {data.previous && (
              <label className="toggle">
                <input type="checkbox" checked={diff} onChange={(e) => setDiff(e.target.checked)} /> Diff
                against v{data.previous.version}
              </label>
            )}
            <button
              type="button"
              className="button"
              onClick={() => {
                void navigator.clipboard?.writeText(s.code);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <ClipboardCopy size={14} /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {s.note && <p className="prose">{s.note}</p>}
          {s.error && (
            <div className="notice error-notice" role="alert">
              <AlertTriangle size={16} />
              <pre>{typeof s.error === 'string' ? s.error : JSON.stringify(s.error, null, 2)}</pre>
            </div>
          )}
          <CodeEditor
            key={`${s.version}-${diff}`}
            value={s.code}
            language="python"
            readOnly
            height={520}
            {...(diff && data.previous ? { original: data.previous.code } : {})}
          />
          {s.evaluations.length > 0 && (
            <p className="muted-line">
              Evaluated with this version:{' '}
              {s.evaluations.map((e: any, i: number) => (
                <React.Fragment key={e.id}>
                  {i ? ', ' : ''}
                  <button type="button" className="link-button" onClick={() => go(`/evaluations/${e.id}`)}>
                    {e.mode} ({e.status})
                  </button>
                </React.Fragment>
              ))}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Every evaluation of the idea, newest first, with reproduction results. */
function Runs({
  id,
  isAdmin,
  reproduce,
  busy,
}: {
  id: string;
  isAdmin: boolean;
  reproduce: (evaluationId: string) => void;
  busy: boolean;
}) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      api<any[]>(`/ideas/${id}/evaluations`).then((r) => {
        if (stop) return;
        setRows(r);
        if (r.some((e) => e.status === 'running')) setTimeout(load, 4000);
      });
    void load();
    return () => {
      stop = true;
    };
  }, [id, busy]);
  if (!rows) return <Skeleton rows={5} />;
  if (!rows.length)
    return (
      <div className="empty-state">
        <p>No evaluations yet.</p>
      </div>
    );
  return (
    <div className="table-wrap">
      <table aria-label="Evaluations">
        <thead>
          <tr>
            <th>When</th>
            <th>Mode</th>
            <th>Status</th>
            <th>Version</th>
            <th>Trial</th>
            <th>Period</th>
            <th className="num">Sharpe</th>
            <th className="num">Excess / yr</th>
            <th>Record</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className="clickable" onClick={() => go(`/evaluations/${e.id}`)}>
              <td>{when(e.createdAt)}</td>
              <td>
                {e.mode === 'holdout' ? <StatusPill status="warn" label="holdout" /> : e.mode}
                {e.reproduces && (
                  <StatusPill
                    status={
                      e.reproduces.match === true ? 'ok' : e.reproduces.match === false ? 'failed' : 'pending'
                    }
                    label={
                      e.reproduces.match === true
                        ? 'reproduced ✓'
                        : e.reproduces.match === false
                          ? 'mismatch'
                          : 'reproducing'
                    }
                  />
                )}
              </td>
              <td>
                <StatusPill status={e.status} />
              </td>
              <td>v{e.pluginVersion}</td>
              <td>{e.trial}</td>
              <td>
                {e.params?.start} → {e.params?.end}
              </td>
              <td className="num">{num(e.summary?.sharpe)}</td>
              <td className="num">{pct(e.excess?.spx?.excess_cagr)}</td>
              <td>
                <code title={e.recordHash}>{e.recordHash?.slice(0, 12) ?? '—'}</code>
              </td>
              <td onClick={(ev) => ev.stopPropagation()}>
                {isAdmin && e.status === 'succeeded' && e.mode !== 'holdout' && !e.reproduces && (
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => reproduce(e.id)}
                  >
                    <RotateCcw size={13} /> Reproduce
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
