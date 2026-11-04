// Pipelines UI (#157): list with KPIs; detail with the DAG in layer swimlanes (live status per node, critical
// path, upstream/downstream highlight), a run strip, a Gantt timeline and a node drawer (gates, logs links,
// retry / re-run from here / skip); an editor (nodes, edges drawn on the canvas, gates, Generate from
// dependencies, inline validation) and a backfill dialog. Export / Import YAML (#152).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Edge,
  type Node,
  type NodeProps,
  type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Ban,
  GitBranch,
  History,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  SkipForward,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import {
  type Data,
  type Pipeline,
  type PipelineDraft,
  type PipelineNodeRun,
  type PipelineNodeSpec,
  type PipelineRun,
  type Transform,
  backfillPipeline,
  cancelPipelineRun,
  deletePipeline,
  fetchPipelineRun,
  fetchPipelineRuns,
  fetchPipelines,
  fetchTransforms,
  pipelineNodeAction,
  runPipeline,
  savePipeline,
  suggestPipeline,
  timestamp,
  validatePipeline,
} from '../api';
import { describeSchedule } from '../../../../packages/core/src/schedule.js';
import type { Schedule } from '../../../../packages/core/src/schema.js';
import type { DatasetsRoute } from '../datasetsRoute';
import { LANES, LANE_HEAD, NODE_H, NODE_W, criticalPath, ganttBars, layoutPipeline } from '../pipelineLayout';
import { Button, Empty, Field, IconButton, Modal } from './ui';
import { Drawer, GateChecklist, KpiCard, Skeleton, StatusPill, Tabs } from './kit';
import { ScheduleFields } from './agentFields';
import { ObjectTransfer } from './ObjectTransfer';

type Go = (r: DatasetsRoute) => void;
const PILL_STATUS: Record<string, string> = {
  pending: 'queued',
  waiting: 'pending',
  gate_failed: 'failed',
  blocked: 'blocked',
};
const pillOf = (s: string) => PILL_STATUS[s] ?? s;
const LABEL: Record<string, string> = { waiting: 'waiting on upstream', gate_failed: 'gate failed' };
const fmtMs = (ms?: number) =>
  ms === undefined || Number.isNaN(ms)
    ? '—'
    : ms < 1000
      ? `${ms} ms`
      : ms < 120000
        ? `${(ms / 1000).toFixed(1)} s`
        : ms < 7200000
          ? `${Math.round(ms / 60000)} min`
          : `${(ms / 3600000).toFixed(1)} h`;
const dur = (a?: string, b?: string) => (a ? (b ? Date.parse(b) : Date.now()) - Date.parse(a) : undefined);
const passed = (r?: PipelineRun | null) =>
  r ? Object.values(r.nodes).filter((n) => n.status === 'succeeded' || n.status === 'skipped').length : 0;
const scheduleText = (p: Pick<PipelineDraft, 'schedule'>) =>
  p.schedule?.enabled ? describeSchedule(p.schedule as Schedule) : 'Manual';
const blank = (): PipelineDraft => ({
  name: '',
  description: '',
  period: 'day',
  nodes: [],
  enabled: true,
});
const newNode = (id: string, ref = 'transform:'): PipelineNodeSpec => ({
  id,
  ref,
  after: [],
  gate: {},
  on_upstream_failure: 'block',
  params: {},
  retries: 1,
  timeout_minutes: 360,
});
export const toPipelineDraft = (p: Pipeline): PipelineDraft => ({
  name: p.name,
  description: p.description ?? '',
  ...(p.schedule ? { schedule: p.schedule } : {}),
  period: p.period,
  ...(p.deadline_hours ? { deadline_hours: p.deadline_hours } : {}),
  nodes: p.nodes,
  enabled: p.enabled,
});

export function PipelinesTab({
  item,
  go,
  isAdmin,
  data,
}: {
  item?: string;
  go: Go;
  isAdmin: boolean;
  data: Data;
}) {
  const [list, setList] = useState<Pipeline[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setList(await fetchPipelines());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, item]);
  if (item === 'new') return <PipelineEditor initial={blank()} go={go} data={data} onSaved={load} />;
  if (item) {
    if (!list) return <Skeleton rows={6} />;
    const p = list.find((x) => x.name === item);
    if (!p)
      return (
        <Empty
          icon={<GitBranch size={28} />}
          title={`No pipeline named ${item}`}
          text="It may have been renamed or deleted."
          action={<Button onClick={() => go({ tab: 'pipelines' })}>Back to pipelines</Button>}
        />
      );
    return <PipelineDetail key={p.id} pipeline={p} go={go} isAdmin={isAdmin} data={data} reload={load} />;
  }
  return <PipelinesList list={list} error={error} reload={load} go={go} isAdmin={isAdmin} />;
}

function PipelinesList({
  list,
  error,
  reload,
  go,
  isAdmin,
}: {
  list: Pipeline[] | null;
  error: string;
  reload: () => Promise<void>;
  go: Go;
  isAdmin: boolean;
}) {
  const active = (list ?? []).some((p) => p.lastRun?.status === 'running' || p.lastRun?.status === 'queued');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void reload(), 4000);
    return () => clearInterval(t);
  }, [active, reload]);
  if (!list) return error ? <div className="notice error">{error}</div> : <Skeleton rows={6} />;
  const today = new Date().toDateString();
  const runsToday = list.filter(
    (p) => p.lastRun && new Date(p.lastRun.createdAt).toDateString() === today,
  ).length;
  const blocked = list.filter((p) =>
    Object.values(p.lastRun?.nodes ?? {}).some((n) => n.status === 'blocked'),
  ).length;
  const failed = list.filter((p) => p.lastRun?.status === 'failed').length;
  const newBtn = isAdmin && (
    <Button onClick={() => go({ tab: 'pipelines', item: 'new' })}>
      <Plus size={16} /> New pipeline
    </Button>
  );
  return (
    <>
      <div className="tab-head">
        <p>
          Pipelines run the layers as one DAG per period: a step starts only when its upstream steps finished
          and passed their completeness gates.
        </p>
        <div className="tab-head-actions">
          {isAdmin && <ObjectTransfer kinds={['Pipeline']} onImported={reload} compact />}
          {newBtn}
        </div>
      </div>
      {!list.length ? (
        <Empty
          icon={<GitBranch size={28} />}
          title="No pipelines yet"
          text="Create one, or generate it from your transforms' dependencies."
          action={newBtn}
        />
      ) : (
        <>
          <div className="kpi-row">
            <KpiCard
              icon={<GitBranch size={18} />}
              label="Pipelines"
              value={list.length}
              footnote={`${list.filter((p) => p.enabled).length} enabled`}
            />
            <KpiCard icon={<Activity size={18} />} label="Runs today" value={runsToday} />
            <KpiCard icon={<Ban size={18} />} label="Blocked" value={blocked} />
            <KpiCard icon={<AlertTriangle size={18} />} label="Failed" value={failed} />
          </div>
          <div className="table-wrap pipelines-table">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Schedule</th>
                  <th>Period</th>
                  <th>Last run</th>
                  <th>Duration</th>
                  <th>Nodes passed</th>
                  <th>Next run</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <a
                        href={`/datasets/pipelines/${p.name}`}
                        onClick={(e) => {
                          e.preventDefault();
                          go({ tab: 'pipelines', item: p.name });
                        }}
                      >
                        <strong>{p.name}</strong>
                      </a>
                      <div className="muted-line">
                        v{p.version} · {p.nodes.length} nodes{!p.enabled && ' · disabled'}
                      </div>
                    </td>
                    <td>{scheduleText(p)}</td>
                    <td>{p.period}</td>
                    <td>
                      {p.lastRun ? (
                        <>
                          <StatusPill status={pillOf(p.lastRun.status)} label={p.lastRun.status} />
                          <div className="muted-line">{p.lastRun.period.id}</div>
                        </>
                      ) : (
                        <span className="muted-line">Never</span>
                      )}
                    </td>
                    <td>{fmtMs(dur(p.lastRun?.startedAt, p.lastRun?.finishedAt))}</td>
                    <td>
                      {p.lastRun ? `${passed(p.lastRun)} / ${Object.keys(p.lastRun.nodes).length}` : '—'}
                    </td>
                    <td>{p.nextRunAt ? timestamp(p.nextRunAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

// --- Graph -------------------------------------------------------------------------------------------
type PNodeData = {
  spec: PipelineNodeSpec;
  run?: PipelineNodeRun;
  dim?: boolean;
  critical?: boolean;
  selected?: boolean;
};
function PipelineNodeCard({ data }: NodeProps<Node<PNodeData>>) {
  const { spec, run } = data;
  const status = run?.status ?? 'pending';
  const gate = run?.gate?.[0];
  const rows = run?.stats?.rows ?? run?.stats?.written;
  return (
    <div
      className={`pnode pnode-${status}${data.dim ? ' dim' : ''}${data.critical ? ' critical' : ''}${data.selected ? ' selected' : ''}`}
      style={{ width: NODE_W, minHeight: NODE_H - 10 }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="pnode-head">
        <strong>{spec.id}</strong>
        <StatusPill status={pillOf(status)} label={LABEL[status] ?? status} />
      </div>
      <div className="pnode-ref" title={spec.ref}>
        {spec.ref}
      </div>
      <div className="pnode-meta">
        {run?.startedAt && <span>{fmtMs(dur(run.startedAt, run.finishedAt))}</span>}
        {rows !== undefined && <span>{rows.toLocaleString()} rows</span>}
        {gate && (
          <span
            className={gate.pass ? 'gate-ok' : 'gate-bad'}
            title={run?.gate?.map((g) => `${g.name}: ${g.value} (${g.threshold})`).join('\n')}
          >
            {gate.name} {gate.value ?? '—'}
            {typeof gate.value === 'number' && gate.name.includes('coverage') ? '%' : ''}{' '}
            {gate.pass ? '✓' : '✗'}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
function LaneNode({ data }: NodeProps<Node<{ label: string; width: number; height: number }>>) {
  return (
    <div className="plane" style={{ width: data.width, height: data.height }}>
      <span>{data.label}</span>
    </div>
  );
}
const nodeTypes = { pnode: PipelineNodeCard, lane: LaneNode };

function PipelineGraph({
  nodes,
  run,
  selected,
  onSelect,
  onConnect,
  onDeleteEdge,
  height = 460,
}: {
  nodes: PipelineNodeSpec[];
  run?: PipelineRun | null;
  selected?: string;
  onSelect?: (id: string | undefined) => void;
  onConnect?: (from: string, to: string) => void;
  onDeleteEdge?: (from: string, to: string) => void;
  height?: number;
}) {
  const layout = useMemo(() => layoutPipeline(nodes), [nodes]);
  const critical = useMemo(
    () =>
      new Set(
        run
          ? criticalPath(
              nodes.map((n) => ({
                id: n.id,
                after: n.after,
                startedAt: run.nodes[n.id]?.startedAt,
                finishedAt: run.nodes[n.id]?.finishedAt,
              })),
            )
          : [],
      ),
    [nodes, run],
  );
  const related = useMemo(() => {
    if (!selected) return undefined;
    const up = new Set<string>([selected]);
    const walkUp = (id: string) =>
      nodes.find((n) => n.id === id)?.after.forEach((u) => !up.has(u) && (up.add(u), walkUp(u)));
    walkUp(selected);
    const down = new Set<string>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of nodes)
        if (!down.has(n.id) && n.after.some((u) => u === selected || down.has(u)))
          (down.add(n.id), (grew = true));
    }
    return new Set([...up, ...down]);
  }, [selected, nodes]);
  const flowNodes: Node[] = useMemo(() => {
    const at = new Map(layout.placed.map((p) => [p.id, p]));
    return [
      ...layout.lanes.map((l) => ({
        id: `lane:${l.id}`,
        type: 'lane',
        position: { x: l.x, y: 0 },
        data: { label: l.label, width: l.width, height: Math.max(layout.height, LANE_HEAD + NODE_H + 48) },
        draggable: false,
        selectable: false,
        zIndex: -1,
      })),
      ...nodes.map((n) => ({
        id: n.id,
        type: 'pnode',
        position: { x: at.get(n.id)?.x ?? 0, y: at.get(n.id)?.y ?? 0 },
        data: {
          spec: n,
          run: run?.nodes[n.id],
          dim: related ? !related.has(n.id) : false,
          critical: critical.has(n.id) && critical.size > 1,
          selected: selected === n.id,
        },
        draggable: false,
      })),
    ];
  }, [layout, nodes, run, related, critical, selected]);
  const flowEdges: Edge[] = useMemo(
    () =>
      nodes.flatMap((n) =>
        n.after.map((u) => {
          const from = run?.nodes[u]?.status;
          const to = run?.nodes[n.id]?.status;
          const flowing = from === 'succeeded' && to === 'running';
          const crit = critical.has(u) && critical.has(n.id) && critical.size > 1;
          return {
            id: `${u}->${n.id}`,
            source: u,
            target: n.id,
            animated: flowing,
            className: `pedge${flowing ? ' flowing' : ''}${crit ? ' critical' : ''}${related && !(related.has(u) && related.has(n.id)) ? ' dim' : ''}`,
          };
        }),
      ),
    [nodes, run, critical, related],
  );
  return (
    <div className="pipeline-graph" style={{ height: Math.min(height, Math.max(240, layout.height + 90)) }}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ maxZoom: 1, minZoom: 0.55, padding: 0.08 }}
        minZoom={0.2}
        nodesConnectable={!!onConnect}
        elementsSelectable
        onNodeClick={(_, n) => n.type === 'pnode' && onSelect?.(n.id === selected ? undefined : n.id)}
        onPaneClick={() => onSelect?.(undefined)}
        onConnect={(c: Connection) =>
          c.source && c.target && c.source !== c.target && onConnect?.(c.source, c.target)
        }
        onEdgesDelete={(es) => es.forEach((e) => onDeleteEdge?.(e.source, e.target))}
        deleteKeyCode={onDeleteEdge ? ['Backspace', 'Delete'] : null}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function Timeline({ run, nodes }: { run: PipelineRun; nodes: PipelineNodeSpec[] }) {
  const order = useMemo(() => {
    const layout = layoutPipeline(nodes);
    const at = new Map(layout.placed.map((p) => [p.id, p]));
    return [...nodes].sort((a, b) => at.get(a.id)!.x - at.get(b.id)!.x || at.get(a.id)!.y - at.get(b.id)!.y);
  }, [nodes]);
  const { bars, spanMs } = ganttBars(
    run.startedAt ?? run.createdAt,
    run.finishedAt,
    order.map((n) => ({
      id: n.id,
      after: n.after,
      startedAt: run.nodes[n.id]?.startedAt,
      finishedAt: run.nodes[n.id]?.finishedAt,
    })),
  );
  const by = new Map(bars.map((b) => [b.id, b]));
  return (
    <div className="gantt" role="table" aria-label="Run timeline">
      <div className="gantt-scale">
        <span>start</span>
        <span>{fmtMs(spanMs / 2)}</span>
        <span>{fmtMs(spanMs)}</span>
      </div>
      {order.map((n) => {
        const b = by.get(n.id)!;
        const st = run.nodes[n.id]?.status ?? 'pending';
        return (
          <div key={n.id} className="gantt-row" role="row">
            <span className="gantt-label" title={n.ref}>
              {n.id}
            </span>
            <div className="gantt-track">
              <span className="gantt-wait" style={{ width: `${b.waitPct}%` }} />
              {b.runLeftPct !== undefined && b.runWidthPct !== undefined && (
                <span
                  className={`gantt-run gantt-${st}`}
                  style={{ left: `${b.runLeftPct}%`, width: `${b.runWidthPct}%` }}
                />
              )}
            </div>
            <StatusPill status={pillOf(st)} label={LABEL[st] ?? st} />
          </div>
        );
      })}
    </div>
  );
}

// --- Detail --------------------------------------------------------------------------------------------
function PipelineDetail({
  pipeline,
  go,
  isAdmin,
  data,
  reload,
}: {
  pipeline: Pipeline;
  go: Go;
  isAdmin: boolean;
  data: Data;
  reload: () => Promise<void>;
}) {
  const [view, setView] = useState<'graph' | 'timeline' | 'edit'>('graph');
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [runId, setRunId] = useState<string | undefined>();
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [selected, setSelected] = useState<string | undefined>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [backfill, setBackfill] = useState(false);
  const loadRuns = useCallback(async () => {
    const r = await fetchPipelineRuns(pipeline.id).catch(() => [] as PipelineRun[]);
    setRuns(r);
    setRunId((cur) => cur ?? r[0]?.id);
  }, [pipeline.id]);
  useEffect(() => {
    void loadRuns();
    const t = setInterval(() => void loadRuns(), 10000);
    return () => clearInterval(t);
  }, [loadRuns]);
  const loadRun = useCallback(async () => {
    if (runId) setRun(await fetchPipelineRun(runId).catch(() => null));
  }, [runId]);
  useEffect(() => {
    void loadRun();
  }, [loadRun]);
  // Live status: poll the selected run while it is in progress.
  useEffect(() => {
    if (!run || !['running', 'queued'].includes(run.status)) return;
    const t = setInterval(() => void loadRun(), 3000);
    return () => clearInterval(t);
  }, [run, loadRun]);
  const graph = run?.graph ?? pipeline.nodes;
  async function act(fn: () => Promise<unknown>, done: string) {
    setError('');
    try {
      await fn();
      setMessage(done);
      await loadRuns();
      await loadRun();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function runNow() {
    setError('');
    try {
      const r = await runPipeline(pipeline.id);
      setMessage(r.created ? `Started ${r.period.id}` : `${r.period.id} already has a run`);
      setRunId(r.id);
      await loadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function remove() {
    if (!confirm(`Delete pipeline ${pipeline.name}? Its run history is kept.`)) return;
    await act(() => deletePipeline(pipeline.id), 'Deleted');
    await reload();
    go({ tab: 'pipelines' });
  }
  const sel = selected ? graph.find((n) => n.id === selected) : undefined;
  return (
    <div className="pipeline-detail">
      <div className="transform-editor-head">
        <Button variant="ghost" onClick={() => go({ tab: 'pipelines' })}>
          <ArrowLeft size={16} /> Pipelines
        </Button>
        <h2>
          {pipeline.name} <span className="muted-line">v{pipeline.version}</span>
        </h2>
        <span className="muted-line">
          {scheduleText(pipeline)} · per {pipeline.period}
          {pipeline.nextRunAt ? ` · next ${timestamp(pipeline.nextRunAt)}` : ''}
        </span>
        <div className="transform-editor-actions">
          {isAdmin && (
            <ObjectTransfer kinds={['Pipeline']} names={[pipeline.name]} onImported={reload} compact />
          )}
          {isAdmin && (
            <Button
              variant="secondary"
              onClick={() => setBackfill(true)}
              disabled={pipeline.period === 'event'}
            >
              <History size={16} /> Backfill
            </Button>
          )}
          {isAdmin && (
            <Button onClick={() => void runNow()}>
              <Play size={16} /> Run now
            </Button>
          )}
          {isAdmin && (
            <IconButton title="Delete pipeline" onClick={() => void remove()}>
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
      <div className="run-strip" aria-label="Recent runs">
        {runs.slice(0, 30).map((r) => (
          <button
            key={r.id}
            className={`run-cell run-${r.status}${r.id === runId ? ' active' : ''}`}
            title={`${r.period.id} · ${r.status}${r.trigger === 'backfill' ? ' · backfill' : ''}`}
            onClick={() => setRunId(r.id)}
          >
            {r.period.id}
          </button>
        ))}
        {!runs.length && <span className="muted-line">No runs yet. Run now, or wait for the schedule.</span>}
        {run && (
          <span className="run-strip-summary">
            <StatusPill status={pillOf(run.status)} label={run.status} /> {run.period.start} →{' '}
            {run.period.end} · {passed(run)} / {Object.keys(run.nodes).length} passed ·{' '}
            {fmtMs(dur(run.startedAt, run.finishedAt))}
            {run.deadlineMissed && <StatusPill status="stale" label="deadline missed" />}
            {isAdmin && ['running', 'queued'].includes(run.status) && (
              <Button variant="ghost" onClick={() => void act(() => cancelPipelineRun(run.id), 'Cancelled')}>
                <X size={14} /> Cancel run
              </Button>
            )}
          </span>
        )}
      </div>
      <Tabs
        tabs={[
          { id: 'graph', label: 'Graph' },
          { id: 'timeline', label: 'Timeline' },
          ...(isAdmin ? [{ id: 'edit' as const, label: 'Edit' }] : []),
        ]}
        value={view}
        onChange={setView}
      />
      {view === 'graph' ? (
        <PipelineGraph nodes={graph} run={run} selected={selected} onSelect={setSelected} />
      ) : view === 'timeline' ? (
        run ? (
          <Timeline run={run} nodes={graph} />
        ) : (
          <p className="muted-line">No run selected.</p>
        )
      ) : (
        <PipelineEditor
          embedded
          pipeline={pipeline}
          initial={toPipelineDraft(pipeline)}
          go={go}
          data={data}
          onSaved={async () => {
            await reload();
            setView('graph');
          }}
        />
      )}
      {sel && view !== 'edit' && (
        <NodeDrawer
          spec={sel}
          run={run}
          isAdmin={isAdmin}
          go={go}
          onClose={() => setSelected(undefined)}
          onAction={(action, reason) =>
            run &&
            act(
              () => pipelineNodeAction(run.id, sel.id, action, reason),
              action === 'retry'
                ? `Retrying ${sel.id}`
                : action === 'rerun'
                  ? `Re-running from ${sel.id}`
                  : `Skipped ${sel.id}`,
            )
          }
        />
      )}
      {backfill && (
        <BackfillDialog
          pipeline={pipeline}
          onClose={() => setBackfill(false)}
          onQueued={async (n) => {
            setBackfill(false);
            setMessage(`Queued ${n} period${n === 1 ? '' : 's'}`);
            await loadRuns();
          }}
        />
      )}
    </div>
  );
}

function NodeDrawer({
  spec,
  run,
  isAdmin,
  go,
  onClose,
  onAction,
}: {
  spec: PipelineNodeSpec;
  run: PipelineRun | null;
  isAdmin: boolean;
  go: Go;
  onClose: () => void;
  onAction: (action: 'retry' | 'rerun' | 'skip', reason?: string) => void;
}) {
  const n = run?.nodes[spec.id];
  const [type, name] = [spec.ref.slice(0, spec.ref.indexOf(':')), spec.ref.slice(spec.ref.indexOf(':') + 1)];
  const open =
    type === 'transform'
      ? () => go({ tab: 'transforms', item: name })
      : type === 'sync'
        ? () => go({ tab: 'syncs' })
        : undefined;
  const retryable = n && ['failed', 'gate_failed', 'blocked', 'cancelled'].includes(n.status);
  return (
    <Drawer
      title={
        <>
          {spec.id} <small className="muted-line">{spec.ref}</small>
        </>
      }
      onClose={onClose}
      {...(open
        ? {
            fullPage: {
              href: type === 'transform' ? `/datasets/transforms/${name}` : '/datasets/syncs',
              onOpen: open,
            },
          }
        : {})}
    >
      <div className="run-drawer">
        {!n ? (
          <p className="muted-line">Not part of the selected run.</p>
        ) : (
          <>
            <p>
              <StatusPill status={pillOf(n.status)} label={LABEL[n.status] ?? n.status} /> attempts{' '}
              {n.attempts ?? 0}
              {n.generation ? ` · re-run ${n.generation}×` : ''}
            </p>
            <p className="muted-line">
              {n.startedAt ? `started ${timestamp(n.startedAt)}` : 'not started'}
              {n.finishedAt
                ? ` · finished ${timestamp(n.finishedAt)} · ${fmtMs(dur(n.startedAt, n.finishedAt))}`
                : ''}
            </p>
            {n.error && <div className="notice error">{n.error}</div>}
            {n.reason && <div className="notice">{n.reason}</div>}
            {n.warning && <div className="notice">{n.warning}</div>}
            <h4>Gate</h4>
            {n.gate?.length ? (
              <GateChecklist
                gates={n.gate.map((g) => ({
                  name: g.name,
                  value: g.value ?? '—',
                  threshold: g.threshold,
                  pass: g.pass,
                }))}
              />
            ) : (
              <p className="muted-line">
                {Object.keys(spec.gate).length
                  ? 'Checked when the node succeeds.'
                  : 'No gate: succeeding is enough.'}
              </p>
            )}
            {n.stats && (
              <>
                <h4>Stats</h4>
                <table>
                  <tbody>
                    {Object.entries(n.stats).map(([k, v]) => (
                      <tr key={k}>
                        <td>{k.replaceAll('_', ' ')}</td>
                        <td>{Number(v).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            {n.external && (
              <>
                <h4>Underlying {n.external.type.replaceAll('_', ' ')}</h4>
                <ul className="plain-list">
                  {n.external.ids.map((id) => (
                    <li key={id}>
                      <code>{id}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {isAdmin && (
              <div className="drawer-actions">
                {retryable && (
                  <Button onClick={() => onAction('retry')}>
                    <RotateCcw size={15} /> Retry
                  </Button>
                )}
                <Button variant="secondary" onClick={() => onAction('rerun')}>
                  <Play size={15} /> Re-run from here
                </Button>
                {n.status !== 'succeeded' && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const reason = prompt('Why skip this node? Downstream nodes treat it as done.');
                      if (reason) onAction('skip', reason);
                    }}
                  >
                    <SkipForward size={15} /> Mark skipped…
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}

function BackfillDialog({
  pipeline,
  onClose,
  onQueued,
}: {
  pipeline: Pipeline;
  onClose: () => void;
  onQueued: (n: number) => Promise<void>;
}) {
  const hint = { day: '2026-10-01', week: '2026-W40', month: '2026-06', event: '' }[pipeline.period];
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [parallelism, setParallelism] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Backfill ${pipeline.name}`} onClose={onClose}>
      <div className="form-content">
        <p className="muted-line">
          Runs past {pipeline.period}s oldest first, without touching the schedule. Periods that already have
          a run are skipped.
        </p>
        <div className="two-columns">
          <Field label="From period" hint={`e.g. ${hint}`}>
            <input value={from} onChange={(e) => setFrom(e.target.value.trim())} placeholder={hint} />
          </Field>
          <Field label="To period">
            <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder={hint} />
          </Field>
        </div>
        <Field label="Parallelism" hint="Periods run at the same time (1–4)">
          <input
            type="number"
            min={1}
            max={4}
            value={parallelism}
            onChange={(e) => setParallelism(Number(e.target.value) || 1)}
          />
        </Field>
        {error && <div className="notice error">{error}</div>}
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !from || !to}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const r = await backfillPipeline(pipeline.id, { from, to, parallelism });
                await onQueued(r.queued.length);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <History size={16} /> Queue backfill
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// --- Editor --------------------------------------------------------------------------------------------
const NODE_KINDS = ['sync', 'transform', 'check', 'harness', 'research', 'live'] as const;
function PipelineEditor({
  pipeline,
  initial,
  go,
  data,
  onSaved,
  embedded,
}: {
  pipeline?: Pipeline;
  initial: PipelineDraft;
  go: Go;
  data: Data;
  onSaved: () => Promise<void>;
  embedded?: boolean;
}) {
  const [draft, setDraft] = useState<PipelineDraft>(initial);
  const [transforms, setTransforms] = useState<Transform[]>([]);
  const [problems, setProblems] = useState<{ errors: string[]; warnings: string[] }>({
    errors: [],
    warnings: [],
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | undefined>();
  useEffect(() => {
    void fetchTransforms().then(setTransforms, () => undefined);
  }, []);
  // Inline validation (debounced).
  useEffect(() => {
    if (!draft.name || !draft.nodes.length) return setProblems({ errors: [], warnings: [] });
    const t = setTimeout(
      () => void validatePipeline(draft, pipeline?.id).then(setProblems, () => undefined),
      400,
    );
    return () => clearTimeout(t);
  }, [draft, pipeline?.id]);
  const set = (patch: Partial<PipelineDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setNode = (id: string, patch: Partial<PipelineNodeSpec>) =>
    set({ nodes: draft.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
  const names: Record<string, string[]> = {
    sync: (data.datasetSyncs ?? []).map((s) => s.name),
    transform: transforms.map((t) => t.name),
    harness: data.workflows.map((w) => w.name),
    check: ['collection_rows'],
    research: [],
    live: [],
  };
  const addNode = () => {
    let i = draft.nodes.length + 1;
    while (draft.nodes.some((n) => n.id === `node_${i}`)) i++;
    const id = `node_${i}`;
    set({ nodes: [...draft.nodes, newNode(id)] });
    setSelected(id);
  };
  async function generate() {
    if (
      draft.nodes.length &&
      !confirm('Replace the nodes with ones generated from your transforms’ dependencies?')
    )
      return;
    try {
      set({ nodes: (await suggestPipeline()).nodes });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      const p = await savePipeline(draft, pipeline?.id);
      await onSaved();
      go({ tab: 'pipelines', item: p.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const node = selected ? draft.nodes.find((n) => n.id === selected) : undefined;
  const nodeType = node ? node.ref.slice(0, node.ref.indexOf(':')) : '';
  const nodeName = node ? node.ref.slice(node.ref.indexOf(':') + 1) : '';
  return (
    <div className="pipeline-editor">
      {!embedded && (
        <div className="transform-editor-head">
          <Button variant="ghost" onClick={() => go({ tab: 'pipelines' })}>
            <ArrowLeft size={16} /> Pipelines
          </Button>
          <h2>{draft.name || 'New pipeline'}</h2>
        </div>
      )}
      <div className="pipeline-editor-bar">
        <Button variant="secondary" onClick={addNode}>
          <Plus size={15} /> Add node
        </Button>
        <Button
          variant="secondary"
          onClick={() => void generate()}
          title="Nodes and edges from the transforms' inputs and run-after triggers"
        >
          <Wand2 size={15} /> Generate from dependencies
        </Button>
        <span className="muted-line">
          Drag from a node's right edge to another node to add an edge; select an edge and press Delete to
          remove it.
        </span>
        <Button
          onClick={() => void save()}
          disabled={busy || !draft.name || !draft.nodes.length || problems.errors.length > 0}
        >
          <Save size={16} /> {pipeline ? 'Save version' : 'Create'}
        </Button>
      </div>
      {(error || problems.errors.length > 0 || problems.warnings.length > 0) && (
        <div className="validation-bar" role="status">
          {error && <StatusPill status="failed" label={error} />}
          {problems.errors.map((e) => (
            <StatusPill key={e} status="blocked" label={e} />
          ))}
          {problems.warnings.map((w) => (
            <StatusPill key={w} status="warn" label={w} />
          ))}
        </div>
      )}
      <div className="pipeline-editor-panes">
        <div>
          <PipelineGraph
            nodes={draft.nodes}
            selected={selected}
            onSelect={setSelected}
            height={420}
            onConnect={(from, to) =>
              setNode(to, {
                after: [...new Set([...(draft.nodes.find((n) => n.id === to)?.after ?? []), from])],
              })
            }
            onDeleteEdge={(from, to) =>
              setNode(to, {
                after: (draft.nodes.find((n) => n.id === to)?.after ?? []).filter((u) => u !== from),
              })
            }
          />
          <details className="config-section" open={!pipeline}>
            <summary>Pipeline settings</summary>
            <div className="config-section-body">
              <div className="two-columns">
                <Field label="Name" hint="Lowercase, digits, dashes, underscores">
                  <input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
                </Field>
                <Field label="Period" hint="A run covers the period containing the day before it starts">
                  <select
                    value={draft.period}
                    onChange={(e) => set({ period: e.target.value as PipelineDraft['period'] })}
                  >
                    <option value="day">day</option>
                    <option value="week">week (ISO)</option>
                    <option value="month">month</option>
                    <option value="event">event (manual)</option>
                  </select>
                </Field>
              </div>
              <Field label="Description">
                <input value={draft.description} onChange={(e) => set({ description: e.target.value })} />
              </Field>
              <ScheduleFields
                value={draft.schedule as Schedule | undefined}
                onChange={(schedule) => set({ schedule: schedule as unknown as Record<string, unknown> })}
              />
              <div className="two-columns">
                <Field label="Deadline (hours)" hint="Alert when a run is not done by then">
                  <input
                    type="number"
                    min={1}
                    value={draft.deadline_hours ?? ''}
                    onChange={(e) =>
                      set({ deadline_hours: e.target.value ? Number(e.target.value) : undefined })
                    }
                  />
                </Field>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => set({ enabled: e.target.checked })}
                  />
                  Enabled (scheduled runs)
                </label>
              </div>
            </div>
          </details>
        </div>
        <aside className="transform-config">
          {!node ? (
            <p className="muted-line">Select a node to edit it, or add one.</p>
          ) : (
            <div className="config-section-body">
              <div className="output-card-head">
                <strong>Node</strong>
                <IconButton
                  title="Remove node"
                  onClick={() => {
                    set({
                      nodes: draft.nodes
                        .filter((n) => n.id !== node.id)
                        .map((n) => ({ ...n, after: n.after.filter((u) => u !== node.id) })),
                    });
                    setSelected(undefined);
                  }}
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
              <Field label="Id">
                <input
                  aria-label="Node id"
                  value={node.id}
                  onChange={(e) => {
                    const id = e.target.value;
                    set({
                      nodes: draft.nodes.map((n) =>
                        n.id === node.id
                          ? { ...n, id }
                          : { ...n, after: n.after.map((u) => (u === node.id ? id : u)) },
                      ),
                    });
                    setSelected(id);
                  }}
                />
              </Field>
              <div className="two-columns">
                <Field label="Type">
                  <select
                    aria-label="Node type"
                    value={nodeType}
                    onChange={(e) => setNode(node.id, { ref: `${e.target.value}:` })}
                  >
                    {NODE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Object">
                  {names[nodeType]?.length ? (
                    <select
                      aria-label="Node object"
                      value={nodeName}
                      onChange={(e) => setNode(node.id, { ref: `${nodeType}:${e.target.value}` })}
                    >
                      <option value="">Choose…</option>
                      {names[nodeType].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label="Node object"
                      value={nodeName}
                      placeholder="name"
                      onChange={(e) => setNode(node.id, { ref: `${nodeType}:${e.target.value}` })}
                    />
                  )}
                </Field>
              </div>
              {nodeType === 'check' && (
                <div className="two-columns">
                  <Field label="Collection">
                    <input
                      value={String(node.params.collection ?? '')}
                      onChange={(e) =>
                        setNode(node.id, { params: { ...node.params, collection: e.target.value } })
                      }
                    />
                  </Field>
                  <Field label="Date field">
                    <input
                      value={String(node.params.date_field ?? 'date')}
                      onChange={(e) =>
                        setNode(node.id, { params: { ...node.params, date_field: e.target.value } })
                      }
                    />
                  </Field>
                </div>
              )}
              <Field label="After">
                <div className="after-list">
                  {draft.nodes
                    .filter((n) => n.id !== node.id)
                    .map((n) => (
                      <label key={n.id} className="check-row">
                        <input
                          type="checkbox"
                          checked={node.after.includes(n.id)}
                          onChange={(e) =>
                            setNode(node.id, {
                              after: e.target.checked
                                ? [...node.after, n.id]
                                : node.after.filter((u) => u !== n.id),
                            })
                          }
                        />
                        {n.id}
                      </label>
                    ))}
                </div>
              </Field>
              <h4>Gate</h4>
              <div className="two-columns">
                {nodeType === 'sync' && (
                  <Field label="Min symbol coverage %">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={
                        node.gate.min_symbol_coverage !== undefined ? node.gate.min_symbol_coverage * 100 : ''
                      }
                      onChange={(e) =>
                        setNode(node.id, {
                          gate: {
                            ...node.gate,
                            min_symbol_coverage: e.target.value ? Number(e.target.value) / 100 : undefined,
                          },
                        })
                      }
                    />
                  </Field>
                )}
                <Field label="Min rows">
                  <input
                    type="number"
                    min={0}
                    value={node.gate.min_rows ?? ''}
                    onChange={(e) =>
                      setNode(node.id, {
                        gate: { ...node.gate, min_rows: e.target.value ? Number(e.target.value) : undefined },
                      })
                    }
                  />
                </Field>
                <Field label="Max row drop %">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={node.gate.max_row_drop_pct ?? ''}
                    onChange={(e) =>
                      setNode(node.id, {
                        gate: {
                          ...node.gate,
                          max_row_drop_pct: e.target.value ? Number(e.target.value) : undefined,
                        },
                      })
                    }
                  />
                </Field>
                {nodeType === 'transform' && (
                  <Field label="Max DQ issues per row">
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.001}
                      value={node.gate.max_dq_error_rate ?? ''}
                      onChange={(e) =>
                        setNode(node.id, {
                          gate: {
                            ...node.gate,
                            max_dq_error_rate: e.target.value ? Number(e.target.value) : undefined,
                          },
                        })
                      }
                    />
                  </Field>
                )}
              </div>
              <div className="two-columns">
                <Field label="If an upstream fails">
                  <select
                    value={node.on_upstream_failure}
                    onChange={(e) =>
                      setNode(node.id, {
                        on_upstream_failure: e.target.value as PipelineNodeSpec['on_upstream_failure'],
                      })
                    }
                  >
                    <option value="block">block</option>
                    <option value="skip">skip</option>
                    <option value="continue_with_warning">continue with a warning</option>
                  </select>
                </Field>
                <Field label="Retries">
                  <input
                    type="number"
                    min={0}
                    max={5}
                    value={node.retries}
                    onChange={(e) => setNode(node.id, { retries: Number(e.target.value) || 0 })}
                  />
                </Field>
              </div>
              <Field label="Timeout (minutes)">
                <input
                  type="number"
                  min={1}
                  value={node.timeout_minutes}
                  onChange={(e) => setNode(node.id, { timeout_minutes: Number(e.target.value) || 360 })}
                />
              </Field>
            </div>
          )}
          {pipeline && (
            <p className="muted-line">
              <Pencil size={12} /> Saving creates v{pipeline.version + 1}. Runs in progress keep the graph
              they started with.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
