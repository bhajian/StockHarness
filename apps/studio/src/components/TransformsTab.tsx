// Layer 2 Transforms tab (#94): a list of Python transforms (inputs → outputs, trigger, last run) and a
// full-page editor: inputs pane (catalog fields → oh.read_df snippets), code, outputs and trigger panel,
// and the latest run's logs with traceback markers. Every save is a new version. Layer 2 is optional.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Code2,
  Database,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
  Activity,
  AlertTriangle,
  Rows3,
  Eye,
  LoaderCircle,
} from 'lucide-react';
import {
  type CatalogField,
  type CatalogListItem,
  type Transform,
  type TransformDraft,
  type TransformRun,
  type TransformPreview,
  startTransformPreview,
  fetchTransformPreview,
  deleteTransform,
  fetchCatalog,
  fetchCatalogEntry,
  fetchRecentTransformRuns,
  fetchTransformRun,
  fetchTransformRuns,
  fetchTransforms,
  fetchPipelines,
  runTransform,
  saveTransform,
  timestamp,
} from '../api';
import { describeSchedule } from '../../../../packages/core/src/schedule.js';
import type { Schedule } from '../../../../packages/core/src/schema.js';
import { TEMPLATES, readSnippet, type TemplateOutput } from '../transformTemplates';
import type { DatasetsRoute } from '../datasetsRoute';
import { Button, Empty, Field, IconButton, Modal } from './ui';
import { KpiCard, Skeleton, StatusPill, Tabs } from './kit';
import { BackfillProgress, RunHistory, VersionsPanel } from './TransformHistory';
import { ScheduleFields } from './agentFields';
import { ObjectTransfer } from './ObjectTransfer';
import { CodeEditor, tracebackMarkers } from '../editor/CodeEditor';

type Go = (r: DatasetsRoute) => void;
const fmtMs = (ms?: number) =>
  ms === undefined
    ? '—'
    : ms < 1000
      ? `${ms} ms`
      : ms < 120000
        ? `${(ms / 1000).toFixed(1)} s`
        : `${Math.round(ms / 60000)} min`;
const rowsWritten = (r?: TransformRun | null) =>
  Object.values(r?.outputs ?? {}).reduce((n, o) => n + (o.written ?? 0), 0);
const triggerText = (t: Pick<TransformDraft, 'trigger'>) => {
  const parts = [];
  if (t.trigger.schedule?.enabled) parts.push(describeSchedule(t.trigger.schedule as Schedule));
  if (t.trigger.after.length) parts.push(`after ${t.trigger.after.map((a) => a.split(':')[1]).join(', ')}`);
  return parts.join(' · ') || 'Manual';
};
/** When a transform runs, in a sentence (#312). */
const whenItRuns = (t: Pick<TransformDraft, 'trigger'>) => {
  const after = t.trigger.after.map((a) => {
    const [kind, name] = a.split(':');
    return kind === 'transform' ? `the ${name} transform` : `new ${name} data`;
  });
  const parts = [];
  if (after.length)
    parts.push(`Automatically, after ${after.join(' and ')} ${after.length === 1 ? 'arrives' : 'arrive'}`);
  if (t.trigger.schedule?.enabled) parts.push(describeSchedule(t.trigger.schedule as Schedule));
  return parts.join('; ') || 'Only when run by hand';
};
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
export const toDraft = (t: Transform): TransformDraft => ({
  name: t.name,
  description: t.description ?? '',
  code: t.code,
  inputs: t.inputs ?? [],
  outputs: t.outputs,
  trigger: {
    ...(t.trigger?.schedule ? { schedule: t.trigger.schedule } : {}),
    after: t.trigger?.after ?? [],
  },
  incremental: t.incremental ?? { mode: 'full', lookback_days: 0 },
  params: t.params ?? {},
  secrets: t.secrets ?? [],
  enabled: t.enabled ?? true,
});

export function TransformsTab({ item, go, isAdmin }: { item?: string; go: Go; isAdmin: boolean }) {
  const [list, setList] = useState<Transform[] | null>(null);
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState<TransformDraft | null>(null);
  // A message that survives the editor remounting on a new URL (create, rename).
  const [flash, setFlash] = useState('');
  const load = useCallback(async () => {
    try {
      setList(await fetchTransforms());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, item]);

  if (item === 'new')
    return (
      <TransformEditor
        key="new"
        initial={fresh ?? TEMPLATES[0].draft}
        go={go}
        isAdmin={isAdmin}
        onSaved={load}
        flash={flash}
        onFlash={setFlash}
      />
    );
  if (item) {
    if (!list) return <Skeleton rows={6} />;
    const t = list.find((x) => x.name === item);
    if (!t)
      return (
        <Empty
          icon={<Code2 size={28} />}
          title={`No transform named ${item}`}
          text="It may have been renamed or deleted."
          action={<Button onClick={() => go({ tab: 'transforms' })}>Back to transforms</Button>}
        />
      );
    return (
      <TransformEditor
        key={t.id}
        transform={t}
        initial={toDraft(t)}
        go={go}
        isAdmin={isAdmin}
        onSaved={load}
        flash={flash}
        onFlash={setFlash}
      />
    );
  }
  return (
    <TransformsList
      list={list}
      error={error}
      reload={load}
      go={go}
      isAdmin={isAdmin}
      onNew={(d) => {
        setFresh(d);
        go({ tab: 'transforms', item: 'new' });
      }}
    />
  );
}

function TransformsList({
  list,
  error,
  reload,
  go,
  isAdmin,
  onNew,
}: {
  list: Transform[] | null;
  error: string;
  reload: () => Promise<void>;
  go: Go;
  isAdmin: boolean;
  onNew: (d: TransformDraft) => void;
}) {
  const [today, setToday] = useState<TransformRun[]>([]);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState('');
  const active = (list ?? []).some((t) => t.lastRun && ['queued', 'running'].includes(t.lastRun.status));
  useEffect(() => {
    fetchRecentTransformRuns(startOfToday())
      .then(setToday)
      .catch(() => undefined);
  }, [list]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void reload(), 4000);
    return () => clearInterval(t);
  }, [active, reload]);

  if (!list) return error ? <div className="notice error">{error}</div> : <Skeleton rows={6} />;
  const enabled = list.filter((t) => t.enabled).length;
  const failedToday = today.filter((r) => r.status === 'failed').length;
  const newBtn = isAdmin && (
    <Button onClick={() => setPicking(true)}>
      <Plus size={16} /> New transform
    </Button>
  );
  async function runNow(t: Transform) {
    try {
      await runTransform(t.id, { range: 'last_day' });
      setNotice(`Queued ${t.name}`);
      await reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <>
      <div className="tab-head">
        <p>
          Layer 2: Python transforms that turn Layer 1 data into flat, point-in-time collections, the data
          research and simulations read. One transform can write several collections.
        </p>
        <div className="tab-head-actions">
          {isAdmin && <ObjectTransfer kinds={['Transform']} onImported={reload} compact />}
          {newBtn}
        </div>
      </div>
      {notice && (
        <div className="notice" role="status">
          {notice}
          <IconButton title="Dismiss" onClick={() => setNotice('')}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      <ol className="how-l2" aria-label="How Layer 2 works">
        <li>
          <strong>1. New data arrives.</strong> A Layer 1 sync finishes, or another transform does.
        </li>
        <li>
          <strong>2. The transforms that read it run by themselves</strong>, in order. One with several inputs
          waits for all of them (at most 24 hours).
        </li>
        <li>
          <strong>3. Each writes its output collections</strong>, every row stamped with when it became known.
          Click an output to see its rows in the Catalog, or open the Map for the whole chain.
        </li>
      </ol>
      {!list.length ? (
        <Empty
          icon={<Code2 size={28} />}
          title="No transforms yet"
          text="Simple Layer 1 collections can be used directly. Add a transform when raw data needs flattening, joining or point-in-time fixes."
          action={newBtn}
        />
      ) : (
        <>
          <div className="kpi-row">
            <KpiCard
              icon={<Code2 size={18} />}
              label="Transforms"
              value={list.length}
              footnote={`${enabled} enabled`}
            />
            <KpiCard icon={<Activity size={18} />} label="Runs today" value={today.length} />
            <KpiCard
              icon={<AlertTriangle size={18} />}
              label="Failed today"
              value={failedToday}
              {...(failedToday ? { delta: { text: 'needs attention', tone: 'down' as const } } : {})}
            />
            <KpiCard
              icon={<Rows3 size={18} />}
              label="Rows written today"
              value={today.reduce((n, r) => n + rowsWritten(r), 0).toLocaleString()}
            />
          </div>
          <div className="table-wrap transforms-table">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Reads</th>
                  <th>Writes (click to see the rows)</th>
                  <th>When it runs</th>
                  <th>Last run</th>
                  <th>Rows</th>
                  <th>Duration</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <a
                        href={`/datasets/transforms/${t.name}`}
                        onClick={(e) => {
                          e.preventDefault();
                          go({ tab: 'transforms', item: t.name });
                        }}
                      >
                        <strong>{t.name}</strong>
                      </a>
                      <div className="muted-line">
                        v{t.version}
                        {!t.enabled && (
                          <>
                            {' '}
                            · <StatusPill status="disabled" />
                          </>
                        )}
                      </div>
                    </td>
                    <td>
                      <Chips items={t.inputs} />
                    </td>
                    <td>
                      <span className="chips">
                        {t.outputs.map((o) => (
                          <button
                            key={o.collection}
                            type="button"
                            className="chip strong link-chip"
                            title={`See the rows of ${o.collection} in the Catalog`}
                            onClick={() => go({ tab: 'catalog', item: o.collection })}
                          >
                            {o.collection}
                          </button>
                        ))}
                      </span>
                    </td>
                    <td className="when-runs">{whenItRuns(t)}</td>
                    <td>
                      {t.lastRun ? (
                        <>
                          <StatusPill status={t.lastRun.status} />
                          <div className="muted-line">{timestamp(t.lastRun.createdAt)}</div>
                        </>
                      ) : (
                        <span className="muted-line">Never</span>
                      )}
                    </td>
                    <td>{t.lastRun ? rowsWritten(t.lastRun).toLocaleString() : '—'}</td>
                    <td>{fmtMs(t.lastRun?.durationMs)}</td>
                    <td className="row-actions">
                      {isAdmin && (
                        <IconButton title="Run now (last day)" onClick={() => void runNow(t)}>
                          <Play size={15} />
                        </IconButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {picking && (
        <Modal title="New transform" onClose={() => setPicking(false)} wide>
          <div className="template-grid">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                className="template-card"
                onClick={() => {
                  setPicking(false);
                  onNew(structuredClone(t.draft));
                }}
              >
                <strong>{t.label}</strong>
                <span>{t.text}</span>
                <small>
                  {t.draft.outputs.length} output{t.draft.outputs.length === 1 ? '' : 's'}:{' '}
                  {t.draft.outputs.map((o) => o.collection).join(', ')}
                </small>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}

function Chips({ items, strong }: { items: string[]; strong?: boolean }) {
  if (!items.length) return <span className="muted-line">—</span>;
  return (
    <span className="chips">
      {items.map((i) => (
        <code key={i} className={strong ? 'chip strong' : 'chip'}>
          {i}
        </code>
      ))}
    </span>
  );
}

const csv = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function TransformEditor({
  transform,
  initial,
  go,
  isAdmin,
  onSaved,
  flash,
  onFlash,
}: {
  transform?: Transform;
  initial: TransformDraft;
  go: Go;
  isAdmin: boolean;
  onSaved: () => Promise<void>;
  flash?: string;
  onFlash?: (m: string) => void;
}) {
  const [draft, setDraft] = useState<TransformDraft>(initial);
  const [saved, setSaved] = useState<TransformDraft>(initial);
  const [paramsText, setParamsText] = useState(JSON.stringify(initial.params, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState(flash ?? '');
  useEffect(() => onFlash?.(''), [onFlash]);
  const [running, setRunning] = useState(false);
  const [catalog, setCatalog] = useState<CatalogListItem[]>([]);
  const [runs, setRuns] = useState<TransformRun[]>([]);
  const [latest, setLatest] = useState<TransformRun | null>(null);
  const editorApi = useRef<{ insert: (text: string) => void } | null>(null);
  const isNew = !transform;
  const dirty = isNew || JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (patch: Partial<TransformDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setOutput = (i: number, patch: Partial<TemplateOutput>) =>
    set({ outputs: draft.outputs.map((o, j) => (j === i ? { ...o, ...patch } : o)) });

  useEffect(() => {
    fetchCatalog()
      .then(setCatalog)
      .catch(() => undefined);
  }, []);
  const loadRuns = useCallback(async () => {
    if (!transform) return;
    const r = await fetchTransformRuns(transform.id).catch(() => [] as TransformRun[]);
    setRuns(r);
    if (r[0]) setLatest(await fetchTransformRun(r[0].id).catch(() => r[0]));
  }, [transform]);
  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);
  const activeRun = runs.some((r) => ['queued', 'running'].includes(r.status));
  useEffect(() => {
    if (!activeRun) return;
    const t = setInterval(() => void loadRuns(), 3000);
    return () => clearInterval(t);
  }, [activeRun, loadRuns]);

  // Preview (#95): the current draft on a sample, nothing written. Its traceback matches the editor's code.
  const [bottom, setBottom] = useState<'latest' | 'runs' | 'versions'>('latest');
  // Pipelines this transform is part of (#157), with the latest node-run status.
  const [partOf, setPartOf] = useState<{ name: string; status?: string }[]>([]);
  useEffect(() => {
    if (!transform) return;
    void fetchPipelines().then(
      (ps) =>
        setPartOf(
          ps.flatMap((p) => {
            const n = p.nodes.find((x) => x.ref === `transform:${transform.name}`);
            return n ? [{ name: p.name, status: p.lastRun?.nodes[n.id]?.status }] : [];
          }),
        ),
      () => undefined,
    );
  }, [transform]);
  const [preview, setPreview] = useState<TransformPreview | null>(null);
  const [previewCode, setPreviewCode] = useState('');
  const previewing = preview?.status === 'running';
  useEffect(() => {
    if (!preview || preview.status !== 'running') return;
    const t = setInterval(
      () =>
        void fetchTransformPreview(preview.id)
          .then((p) => p.status !== 'running' && setPreview(p))
          .catch(() => undefined),
      2000,
    );
    return () => clearInterval(t);
  }, [preview]);
  async function runPreview() {
    setError('');
    try {
      const body = { ...draft, params: JSON.parse(paramsText || '{}') };
      setPreviewCode(draft.code);
      setPreview(await startTransformPreview(body, transform?.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const markers = useMemo(() => {
    if (preview?.status === 'failed' && previewCode === draft.code)
      return tracebackMarkers(preview.stderr ?? '');
    return latest?.status === 'failed' && latest.version === transform?.version && !dirty
      ? tracebackMarkers(latest.stderr ?? '')
      : [];
  }, [preview, previewCode, draft.code, latest, transform?.version, dirty]);
  const problems = draft.outputs
    .map((o) =>
      !o.collection
        ? 'Every output needs a collection name'
        : !o.key.length
          ? `${o.collection}: needs a key`
          : !o.static && !o.known_at_field
            ? `${o.collection}: needs a known_at field unless static`
            : '',
    )
    .filter(Boolean);
  let paramsError = '';
  try {
    const p = JSON.parse(paramsText || '{}');
    if (!p || typeof p !== 'object' || Array.isArray(p)) paramsError = 'Params must be a JSON object';
  } catch {
    paramsError = 'Params is not valid JSON';
  }

  async function save() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const body = { ...draft, params: JSON.parse(paramsText || '{}') };
      const t = await saveTransform(body, transform?.id);
      setSaved(toDraft(t));
      setDraft(toDraft(t));
      const done = isNew ? `Created ${t.name} v${t.version}` : `Saved v${t.version}`;
      setMessage(done);
      await onSaved();
      if (isNew || t.name !== transform?.name) {
        onFlash?.(done);
        go({ tab: 'transforms', item: t.name });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!transform || !confirm(`Delete ${transform.name}? Its output collections are kept.`)) return;
    try {
      await deleteTransform(transform.id);
      await onSaved();
      go({ tab: 'transforms' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const outputNames = new Set(draft.outputs.map((o) => o.collection));
  const available = catalog.filter(
    (c) => !draft.inputs.includes(c.collection) && !outputNames.has(c.collection),
  );

  return (
    <div className="transform-editor">
      <div className="transform-editor-head">
        <Button variant="ghost" onClick={() => go({ tab: 'transforms' })}>
          <ArrowLeft size={16} /> Transforms
        </Button>
        <h2>
          {draft.name || 'New transform'}
          {transform && <span className="muted-line"> v{transform.version}</span>}
        </h2>
        {dirty && !isNew && <StatusPill status="draft" label="unsaved changes" />}
        {partOf.length > 0 && (
          <span className="part-of">
            Part of pipelines:{' '}
            {partOf.map((p) => (
              <a
                key={p.name}
                href={`/datasets/pipelines/${p.name}`}
                onClick={(e) => {
                  e.preventDefault();
                  go({ tab: 'pipelines', item: p.name });
                }}
              >
                {p.name}
                {p.status ? ` (${p.status.replace('_', ' ')})` : ''}
              </a>
            ))}
          </span>
        )}
        <div className="transform-editor-actions">
          {transform && isAdmin && (
            <ObjectTransfer kinds={['Transform']} names={[transform.name]} onImported={onSaved} compact />
          )}
          {isAdmin && (
            <Button
              variant="secondary"
              onClick={() => void runPreview()}
              disabled={previewing || problems.length > 0 || !!paramsError}
              title="Run the current code on a sample (20 symbols, 1 year) without writing anything"
            >
              {previewing ? <LoaderCircle size={16} className="spin" /> : <Eye size={16} />} Preview
            </Button>
          )}
          {transform && isAdmin && (
            <Button
              variant="secondary"
              onClick={() => setRunning(true)}
              title={`Runs the saved version v${transform.version}`}
            >
              <Play size={16} /> Run now
            </Button>
          )}
          {isAdmin && (
            <Button
              onClick={() => void save()}
              disabled={busy || !dirty || problems.length > 0 || !!paramsError}
            >
              <Save size={16} /> {isNew ? 'Create' : 'Save version'}
            </Button>
          )}
          {transform && isAdmin && (
            <IconButton title="Delete transform" onClick={() => void remove()}>
              <Trash2 size={16} />
            </IconButton>
          )}
        </div>
      </div>
      {(error || message) && (
        <div className={`notice ${error ? 'error' : ''}`} role="status">
          {error || message}
        </div>
      )}
      <ValidationBar
        problems={[...problems, paramsError].filter(Boolean)}
        preview={preview}
        stale={!!preview && previewCode !== draft.code}
      />
      <div className="transform-panes">
        <aside className="transform-inputs">
          <h3>Inputs</h3>
          {draft.inputs.map((c) => (
            <InputCollection
              key={c}
              name={c}
              entry={catalog.find((e) => e.collection === c)}
              onInsert={(text) => editorApi.current?.insert(text)}
              onRemove={isAdmin ? () => set({ inputs: draft.inputs.filter((x) => x !== c) }) : undefined}
            />
          ))}
          {isAdmin && (
            <select
              className="transform-add-input"
              value=""
              aria-label="Add input collection"
              onChange={(e) => e.target.value && set({ inputs: [...draft.inputs, e.target.value] })}
            >
              <option value="">+ Add input…</option>
              {[1, 2, null].map((layer) => {
                const group = available.filter((c) => c.layer === layer);
                return group.length ? (
                  <optgroup key={String(layer)} label={layer ? `Layer ${layer}` : 'Other'}>
                    {group.map((c) => (
                      <option key={c.collection} value={c.collection}>
                        {c.collection} ({c.coverage.rows.toLocaleString()})
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          )}
          <p className="hint">
            Tick fields, then insert an <code>oh.read_df</code> with that projection.
          </p>
        </aside>
        <section className="transform-code">
          <CodeEditor
            value={draft.code}
            onChange={(code) => set({ code })}
            readOnly={!isAdmin}
            markers={markers}
            height="62vh"
            onReady={(api) => (editorApi.current = api)}
            toolbar={
              <>
                <Code2 size={14} /> main.py
                {markers[0] && (
                  <span className="code-error">
                    line {markers[0].line}: {markers[0].message}
                  </span>
                )}
              </>
            }
          />
        </section>
        <aside className="transform-config">
          <ConfigSection title="Basics" open>
            <Field label="Name" hint="Lowercase, digits and underscores">
              <input value={draft.name} disabled={!isAdmin} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Description">
              <textarea
                rows={2}
                value={draft.description}
                disabled={!isAdmin}
                onChange={(e) => set({ description: e.target.value })}
              />
            </Field>
            <label className="check-row">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={!isAdmin}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              Enabled (scheduled and triggered runs)
            </label>
          </ConfigSection>
          <ConfigSection title={`Outputs (${draft.outputs.length})`} open>
            {draft.outputs.map((o, i) => (
              <div key={i} className="output-card">
                <div className="output-card-head">
                  <Database size={14} />
                  <input
                    aria-label="Output collection"
                    placeholder="collection"
                    value={o.collection}
                    disabled={!isAdmin}
                    onChange={(e) => setOutput(i, { collection: e.target.value })}
                  />
                  {isAdmin && draft.outputs.length > 1 && (
                    <IconButton
                      title="Remove output"
                      onClick={() => set({ outputs: draft.outputs.filter((_, j) => j !== i) })}
                    >
                      <X size={14} />
                    </IconButton>
                  )}
                </div>
                <div className="two-columns">
                  <Field label="Key" hint="Comma-separated">
                    <input
                      value={o.key.join(', ')}
                      disabled={!isAdmin}
                      onChange={(e) => setOutput(i, { key: csv(e.target.value) })}
                    />
                  </Field>
                  <Field label="Write mode">
                    <select
                      value={o.write_mode ?? 'upsert'}
                      disabled={!isAdmin}
                      onChange={(e) =>
                        setOutput(i, { write_mode: e.target.value as TemplateOutput['write_mode'] })
                      }
                    >
                      <option value="upsert">upsert</option>
                      <option value="append">append</option>
                      <option value="replace">replace</option>
                    </select>
                  </Field>
                </div>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={!!o.static}
                    disabled={!isAdmin}
                    onChange={(e) => setOutput(i, { static: e.target.checked })}
                  />
                  Static reference data (no point-in-time fields)
                </label>
                {!o.static && (
                  <div className="two-columns">
                    <Field label="known_at field">
                      <input
                        value={o.known_at_field ?? ''}
                        disabled={!isAdmin}
                        onChange={(e) => setOutput(i, { known_at_field: e.target.value || undefined })}
                      />
                    </Field>
                    <Field label="as_of field">
                      <input
                        value={o.as_of_field ?? ''}
                        disabled={!isAdmin}
                        onChange={(e) => setOutput(i, { as_of_field: e.target.value || undefined })}
                      />
                    </Field>
                  </div>
                )}
                <Field label="Description">
                  <input
                    value={o.description ?? ''}
                    disabled={!isAdmin}
                    onChange={(e) => setOutput(i, { description: e.target.value || undefined })}
                  />
                </Field>
                <Field label="Grain" hint="e.g. symbol x trading day">
                  <input
                    value={o.grain ?? ''}
                    disabled={!isAdmin}
                    onChange={(e) => setOutput(i, { grain: e.target.value || undefined })}
                  />
                </Field>
                <FieldDocs
                  value={o.fields}
                  disabled={!isAdmin}
                  onChange={(fields) => setOutput(i, { fields })}
                />
              </div>
            ))}
            {isAdmin && (
              <Button
                variant="secondary"
                onClick={() =>
                  set({
                    outputs: [
                      ...draft.outputs,
                      { collection: '', key: ['symbol', 'date'], known_at_field: 'known_at' },
                    ],
                  })
                }
              >
                <Plus size={15} /> Add output
              </Button>
            )}
          </ConfigSection>
          <ConfigSection title={`Trigger: ${triggerText(draft)}`}>
            <ScheduleFields
              value={draft.trigger.schedule as Schedule | undefined}
              nextRunAt={transform?.nextRunAt}
              onChange={(schedule) => set({ trigger: { ...draft.trigger, schedule } })}
            />
            <Field label="Run after" hint="Comma-separated: dataset:<collection> or transform:<name>">
              <input
                value={draft.trigger.after.join(', ')}
                disabled={!isAdmin}
                onChange={(e) => set({ trigger: { ...draft.trigger, after: csv(e.target.value) } })}
              />
            </Field>
            {transform && transform.trigger.after.length > 0 && (
              <div className="trigger-status" aria-label="Upstreams completed since the last triggered run">
                <small>
                  Runs when all of these have completed (settled for a minute):
                  {transform.triggerState?.lastFiredAt
                    ? ` last triggered ${timestamp(transform.triggerState.lastFiredAt)}`
                    : ''}
                </small>
                {transform.trigger.after.map((a) => {
                  const p = transform.triggerState?.pending?.[a];
                  return (
                    <StatusPill
                      key={a}
                      status={p ? 'ok' : 'pending'}
                      label={`${a}${p ? ` · done ${timestamp(p.at)}` : ' · waiting'}`}
                    />
                  );
                })}
              </div>
            )}
          </ConfigSection>
          <ConfigSection title={`Incremental: ${draft.incremental.mode}`}>
            <div className="two-columns">
              <Field label="Mode" hint="date_range runs get oh.window">
                <select
                  value={draft.incremental.mode}
                  disabled={!isAdmin}
                  onChange={(e) =>
                    set({
                      incremental: { ...draft.incremental, mode: e.target.value as 'full' | 'date_range' },
                    })
                  }
                >
                  <option value="full">full</option>
                  <option value="date_range">date_range</option>
                </select>
              </Field>
              <Field label="Lookback (trading days)">
                <input
                  type="number"
                  min={0}
                  max={3650}
                  value={draft.incremental.lookback_days}
                  disabled={!isAdmin || draft.incremental.mode === 'full'}
                  onChange={(e) =>
                    set({ incremental: { ...draft.incremental, lookback_days: Number(e.target.value) || 0 } })
                  }
                />
              </Field>
            </div>
          </ConfigSection>
          <ConfigSection title="Params and secrets">
            <Field label="Params (JSON)" hint="Available to the code as oh.params">
              <textarea
                rows={4}
                className="mono"
                spellCheck={false}
                value={paramsText}
                disabled={!isAdmin}
                onChange={(e) => {
                  setParamsText(e.target.value);
                  try {
                    set({ params: JSON.parse(e.target.value || '{}') });
                  } catch {
                    /* shown as a problem until valid */
                  }
                }}
              />
            </Field>
            <Field
              label="Secrets"
              hint="Comma-separated Python secret names (Settings → Python secrets); values are never stored here"
            >
              <input
                value={draft.secrets.join(', ')}
                disabled={!isAdmin}
                onChange={(e) => set({ secrets: csv(e.target.value) })}
              />
            </Field>
          </ConfigSection>
        </aside>
      </div>
      {preview && <PreviewPanel preview={preview} onClose={() => setPreview(null)} />}
      {transform && (
        <section className="transform-bottom">
          <Tabs
            tabs={[
              { id: 'latest', label: 'Latest run' },
              { id: 'runs', label: `Run history (${runs.length})` },
              { id: 'versions', label: `Versions (${transform.version})` },
            ]}
            value={bottom}
            onChange={setBottom}
          />
          <BackfillProgress runs={runs} />
          {bottom === 'latest' ? (
            <LatestRun run={latest} runs={runs} reload={loadRuns} />
          ) : bottom === 'runs' ? (
            <RunHistory runs={runs} />
          ) : (
            <VersionsPanel
              transform={transform}
              isAdmin={isAdmin}
              onRestored={async (t, from) => {
                const d = toDraft(t);
                setSaved(d);
                setDraft(d);
                setParamsText(JSON.stringify(d.params, null, 2));
                setMessage(`Restored v${from} as v${t.version}`);
                await onSaved();
              }}
            />
          )}
        </section>
      )}
      {running && transform && (
        <RunDialog
          transform={transform}
          onClose={() => setRunning(false)}
          onQueued={async (n) => {
            setRunning(false);
            setMessage(`Queued ${n} run${n === 1 ? '' : 's'} of v${transform.version}`);
            await loadRuns();
          }}
        />
      )}
    </div>
  );
}

function ConfigSection({
  title,
  open,
  children,
}: {
  title: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="config-section" open={open}>
      <summary>{title}</summary>
      <div className="config-section-body">{children}</div>
    </details>
  );
}

function FieldDocs({
  value,
  disabled,
  onChange,
}: {
  value?: TemplateOutput['fields'];
  disabled: boolean;
  onChange: (v: TemplateOutput['fields']) => void;
}) {
  const [text, setText] = useState(value ? JSON.stringify(value, null, 2) : '');
  const [bad, setBad] = useState(false);
  return (
    <details>
      <summary>Field docs{value ? ` (${Object.keys(value).length})` : ''}</summary>
      <textarea
        rows={4}
        className="mono"
        spellCheck={false}
        disabled={disabled}
        placeholder={'{ "ret_1d": { "description": "1-day return", "unit": "ratio" } }'}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = e.target.value.trim() ? JSON.parse(e.target.value) : undefined;
            setBad(false);
            onChange(v);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad && <small className="code-error">Not valid JSON yet</small>}
    </details>
  );
}

function InputCollection({
  name,
  entry,
  onInsert,
  onRemove,
}: {
  name: string;
  entry?: CatalogListItem;
  onInsert: (text: string) => void;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<CatalogField[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open && !fields)
      fetchCatalogEntry(name)
        .then((e) => setFields(e.fields))
        .catch(() => setFields([]));
  }, [open, fields, name]);
  const toggle = (f: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(f)) n.delete(f);
      else n.add(f);
      return n;
    });
  return (
    <div className="input-collection">
      <div className="input-collection-head">
        <button className="link-button" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <code>{name}</code>
        </button>
        {entry ? (
          <small>
            L{entry.layer ?? '?'} · {entry.coverage.rows.toLocaleString()}
          </small>
        ) : (
          <small className="code-error" title="Not in the catalog yet">
            ?
          </small>
        )}
        {onRemove && (
          <IconButton title={`Remove ${name}`} onClick={onRemove}>
            <X size={13} />
          </IconButton>
        )}
      </div>
      {open && (
        <div className="input-collection-body">
          {!fields ? (
            <Skeleton rows={3} />
          ) : (
            <>
              <ul className="field-list">
                {fields.map((f) => (
                  <li key={f.name} title={f.description}>
                    <label>
                      <input type="checkbox" checked={picked.has(f.name)} onChange={() => toggle(f.name)} />
                      <span>{f.name}</span>
                      <small>{f.type}</small>
                    </label>
                  </li>
                ))}
              </ul>
              <Button
                variant="secondary"
                onClick={() =>
                  onInsert(
                    readSnippet(
                      name,
                      fields.filter((f) => picked.has(f.name)).map((f) => f.name),
                      entry?.coverage.dateField,
                    ),
                  )
                }
              >
                Insert oh.read_df
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LatestRun({
  run,
  runs,
  reload,
}: {
  run: TransformRun | null;
  runs: TransformRun[];
  reload: () => Promise<void>;
}) {
  const [tab, setTab] = useState<'summary' | 'stdout' | 'stderr'>('summary');
  if (!run)
    return (
      <section className="transform-run-panel">
        <h3>Latest run</h3>
        <p className="muted-line">No runs yet. Save, then Run now.</p>
      </section>
    );
  const queued = runs.filter((r) => r.status === 'queued').length;
  return (
    <section className="transform-run-panel">
      <div className="transform-run-head">
        <h3>Latest run</h3>
        <StatusPill status={run.status} />
        <span className="muted-line">
          v{run.version} · {run.trigger} · {timestamp(run.createdAt)}
          {run.window ? ` · ${run.window.start} → ${run.window.end}` : ''} · {fmtMs(run.durationMs)}
          {queued > 0 ? ` · ${queued} more queued` : ''}
        </span>
        <IconButton title="Refresh" onClick={() => void reload()}>
          <RefreshCw size={14} />
        </IconButton>
      </div>
      <div className="tabs compact" role="tablist">
        {(['summary', 'stdout', 'stderr'] as const).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'summary' ? 'Outputs' : t}
          </button>
        ))}
      </div>
      {tab === 'summary' ? (
        <>
          {run.error && <div className="notice error">{run.error}</div>}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Collection</th>
                  <th>Read</th>
                  <th>Written</th>
                  <th>Unchanged</th>
                  <th>DQ issues</th>
                </tr>
              </thead>
              <tbody>
                {[...new Set([...Object.keys(run.reads ?? {}), ...Object.keys(run.outputs ?? {})])].map(
                  (c) => (
                    <tr key={c}>
                      <td>
                        <code>{c}</code>
                      </td>
                      <td>{run.reads?.[c]?.toLocaleString() ?? '—'}</td>
                      <td>{run.outputs?.[c]?.written?.toLocaleString() ?? '—'}</td>
                      <td>{run.outputs?.[c]?.unchanged?.toLocaleString() ?? '—'}</td>
                      <td>{run.outputs?.[c]?.dq || '—'}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <pre className="run-log">{(tab === 'stdout' ? run.stdout : run.stderr) || '(empty)'}</pre>
      )}
    </section>
  );
}

function RunDialog({
  transform,
  onClose,
  onQueued,
}: {
  transform: Transform;
  onClose: () => void;
  onQueued: (n: number) => Promise<void>;
}) {
  const full = transform.incremental.mode === 'full';
  const [range, setRange] = useState<'last_day' | 'custom' | 'full'>('last_day');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    setError('');
    try {
      const runs = await runTransform(transform.id, {
        range,
        ...(start && range !== 'last_day' ? { start } : {}),
        ...(end && range !== 'last_day' ? { end } : {}),
      });
      await onQueued(runs.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Run ${transform.name} v${transform.version}`} onClose={onClose}>
      <div className="form-content">
        {full ? (
          <p>This is a full-mode transform: it recomputes all its outputs in one run.</p>
        ) : (
          <>
            <Field label="Range">
              <select value={range} onChange={(e) => setRange(e.target.value as typeof range)}>
                <option value="last_day">Last day</option>
                <option value="custom">Custom range (one run)</option>
                <option value="full">Full backfill (yearly chunks, in order)</option>
              </select>
            </Field>
            {range !== 'last_day' && (
              <div className="two-columns">
                <Field label="Start" hint={range === 'full' ? 'Default: 10 years ago' : undefined}>
                  <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
                </Field>
                <Field label="End" hint="Default: today">
                  <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
                </Field>
              </div>
            )}
          </>
        )}
        {error && <div className="notice error">{error}</div>}
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void go()} disabled={busy || (range === 'custom' && !start)}>
            <Play size={16} /> Queue run
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Validation bar (#95): blocking problems (red) and the latest preview's checks per output. */
function ValidationBar({
  problems,
  preview,
  stale,
}: {
  problems: string[];
  preview: TransformPreview | null;
  stale: boolean;
}) {
  if (problems.length)
    return (
      <div className="validation-bar" role="status">
        {problems.map((p) => (
          <StatusPill key={p} status="blocked" label={p} />
        ))}
      </div>
    );
  if (!preview)
    return (
      <div className="validation-bar muted" role="status">
        Preview runs the current code on 20 symbols × 1 year and checks every output. Nothing is written.
      </div>
    );
  if (preview.status === 'running')
    return (
      <div className="validation-bar" role="status">
        <StatusPill status="running" label={`Previewing on ${preview.symbols.length || 'all'} symbols…`} />
      </div>
    );
  return (
    <div className="validation-bar" role="status">
      {stale && <StatusPill status="stale" label="code changed since this preview" />}
      {preview.status === 'failed' && (
        <StatusPill status="failed" label={preview.error ?? 'Preview failed'} />
      )}
      {Object.entries(preview.outputs ?? {}).map(([c, o]) => (
        <span key={c} className="validation-output">
          <code>{c}</code>
          {o.checks.map((k) => (
            <StatusPill
              key={k.id}
              status={k.status === 'pass' ? 'ok' : k.status === 'warn' ? 'warn' : 'failed'}
              label={k.text}
            />
          ))}
        </span>
      ))}
    </div>
  );
}

/** Bottom panel for a preview: rows (with an output switcher), schema, DQ issues and logs. */
function PreviewPanel({ preview, onClose }: { preview: TransformPreview; onClose: () => void }) {
  const names = Object.keys(preview.outputs ?? {});
  const [output, setOutput] = useState(names[0] ?? '');
  const [tab, setTab] = useState<'rows' | 'schema' | 'dq' | 'logs'>('rows');
  const o = preview.outputs?.[output] ?? preview.outputs?.[names[0]];
  const columns = useMemo(() => {
    const seen: string[] = [];
    for (const r of o?.rows ?? []) for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
    return seen;
  }, [o]);
  return (
    <section className="transform-run-panel preview-panel">
      <div className="transform-run-head">
        <h3>Preview</h3>
        <StatusPill status={preview.status} />
        <span className="muted-line">
          {preview.symbols.length ? `${preview.symbols.length} symbols` : 'all rows'}
          {preview.window ? ` · ${preview.window.start} → ${preview.window.end}` : ''}
          {preview.durationMs !== undefined && preview.durationMs !== null
            ? ` · ${fmtMs(preview.durationMs)}`
            : ''}{' '}
          · nothing written
        </span>
        {names.length > 1 && (
          <select aria-label="Preview output" value={output} onChange={(e) => setOutput(e.target.value)}>
            {names.map((n) => (
              <option key={n} value={n}>
                {n} ({preview.outputs![n].count.toLocaleString()})
              </option>
            ))}
          </select>
        )}
        <IconButton title="Close preview" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="tabs compact" role="tablist">
        {(
          [
            ['rows', `Rows${o ? ` (${o.rows.length} of ${o.count.toLocaleString()})` : ''}`],
            ['schema', 'Schema'],
            ['dq', `DQ issues${o?.dq?.length ? ` (${o.dq.length})` : ''}`],
            ['logs', 'Logs'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {preview.status === 'running' ? (
        <Skeleton rows={4} />
      ) : tab === 'logs' ? (
        <pre className="run-log">
          {[preview.error, preview.stdout, preview.stderr].filter(Boolean).join('\n\n') || '(empty)'}
        </pre>
      ) : !o ? (
        <p className="muted-line">No output was captured.</p>
      ) : tab === 'rows' ? (
        o.rows.length ? (
          <div className="table-wrap data-grid-table">
            <table>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {o.rows.map((r, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c}>
                        {r[c] === null || r[c] === undefined ? (
                          <span className="data-grid-null">—</span>
                        ) : typeof r[c] === 'object' ? (
                          JSON.stringify(r[c])
                        ) : (
                          String(r[c])
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted-line">No rows on the sample.</p>
        )
      ) : tab === 'schema' ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Type</th>
                <th>Null %</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(o.fields).map(([f, v]) => (
                <tr key={f}>
                  <td>
                    <code>{f}</code>
                  </td>
                  <td>{v.type ?? '—'}</td>
                  <td>{v.null_pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : o.dq?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Issue</th>
                <th>Severity</th>
                <th>Symbol</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {o.dq.map((d, i) => (
                <tr key={i}>
                  <td>{d.issue_type}</td>
                  <td>
                    <StatusPill
                      status={d.severity === 'error' ? 'failed' : d.severity === 'warn' ? 'warn' : 'ok'}
                      label={d.severity}
                    />
                  </td>
                  <td>{d.security_id ?? '—'}</td>
                  <td>{d.date ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted-line">No data-quality issues on the sample.</p>
      )}
    </section>
  );
}
