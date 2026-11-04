// Pipeline engine (#156): one run per period; a node starts only when all its upstream nodes of the same run
// succeeded (or were skipped) and passed their gates. State lives in MongoDB (pipeline_runs and
// pipeline_node_executions), so a restart resumes where it was: completed nodes are never re-run.
// Executions are shared: two pipelines needing the same node (ref) for the same period run it once.
import { randomUUID } from 'node:crypto';
import { collection, mongo } from './db.js';
import { HttpError, safeError } from './security.js';
import { nextScheduledAt } from './schedule.js';
import { emitHarnessEvent } from './harnessEvents.js';
import { workspaceDatabase } from './mongoMcp.js';
import {
  datasetSyncRuns,
  datasetSyncs,
  effectivePriority,
  runDatasetSync,
  syncQueue,
} from './datasetSync.js';
import { transforms } from './transforms.js';
import { requestTransformRun, transformRuns } from './transformRunner.js';
import { createRun } from './runs.js';
import {
  downstreamOf,
  extraNodeTypes,
  parsePeriod,
  periodForRun,
  periodRange,
  pipelines,
  refName,
  refType,
  type Gate,
  type NodeType,
  type Period,
  type Pipeline,
  type PipelineNode,
} from './pipelines.js';

export type NodeStats = {
  rows?: number;
  written?: number;
  dq?: number;
  symbols_attempted?: number;
  symbols_covered?: number;
};
export type GateResult = {
  name: string;
  value: number | string | null;
  threshold: number | string;
  pass: boolean;
};
export type NodeStatus =
  | 'pending'
  | 'waiting'
  | 'running'
  | 'succeeded'
  | 'gate_failed'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'cancelled';
const TERMINAL: NodeStatus[] = ['succeeded', 'gate_failed', 'failed', 'blocked', 'skipped', 'cancelled'];
const OK: NodeStatus[] = ['succeeded', 'skipped'];
export type NodeRun = {
  status: NodeStatus;
  ref: string;
  /** Bumped by retry / re-run-from-here, so a fresh execution is started (and not shared with the old). */
  generation: number;
  execId?: string;
  attempts?: number;
  startedAt?: Date;
  finishedAt?: Date;
  stats?: NodeStats;
  gate?: GateResult[];
  error?: string;
  /** Why it was blocked or skipped. */
  reason?: string;
  warning?: string;
  /** The underlying record: a sync run, transform runs, a harness run. */
  external?: { type: string; ids: string[] };
};
export type PipelineRun = {
  _id: string;
  ownerId: string;
  pipelineId: string;
  pipelineName: string;
  version: number;
  period: Period;
  trigger: 'schedule' | 'manual' | 'backfill';
  backfillId?: string;
  parallelism?: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  nodes: Record<string, NodeRun>;
  /** The pipeline's nodes as of the run (a later edit does not change a running run). */
  graph: PipelineNode[];
  deadlineAt?: Date;
  deadlineMissed?: boolean;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  requestedBy?: string;
};
type Execution = {
  _id: string; // ownerId|ref|period|generation
  ownerId: string;
  ref: string;
  periodId: string;
  status: 'running' | 'succeeded' | 'failed';
  attempts: number;
  handle?: Record<string, unknown>;
  stats?: NodeStats;
  error?: string;
  external?: NodeRun['external'];
  nextAttemptAt?: Date;
  startedAt: Date;
  finishedAt?: Date;
  runId: string;
};
export const pipelineRuns = () => collection<PipelineRun>('pipeline_runs');
const executions = () => collection<Execution>('pipeline_node_executions');
let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  // One run per pipeline per period.
  await pipelineRuns().createIndex({ ownerId: 1, pipelineId: 1, 'period.id': 1 }, { unique: true });
  await pipelineRuns().createIndex({ status: 1, createdAt: 1 });
  indexed = true;
}

// --- Executors -------------------------------------------------------------------------------------
export type NodeContext = {
  ownerId: string;
  run: PipelineRun;
  nodeId: string;
  node: PipelineNode;
  execId: string;
  attempt: number;
};
export type NodeProgress =
  | { status: 'running'; handle?: Record<string, unknown> }
  | { status: 'succeeded'; stats?: NodeStats; external?: NodeRun['external'] }
  | { status: 'failed'; error: string; external?: NodeRun['external'] };
export type NodeExecutor = {
  start: (ctx: NodeContext) => Promise<Record<string, unknown>>;
  poll: (ctx: NodeContext, handle: Record<string, unknown>) => Promise<NodeProgress>;
};
const executorRegistry = new Map<NodeType, NodeExecutor>();
/** Register (or replace) the executor for a node type. Research and live register here when they exist. */
export const nodeExecutor = (type: NodeType) => executorRegistry.get(type);
export function registerNodeExecutor(type: NodeType, executor: NodeExecutor) {
  executorRegistry.set(type, executor);
  if (type === 'research' || type === 'live') extraNodeTypes.add(type);
}

registerNodeExecutor('sync', {
  async start(ctx) {
    const sync = await datasetSyncs().findOne({ ownerId: ctx.ownerId, name: refName(ctx.node.ref) });
    if (!sync) throw new Error(`No dataset sync named "${refName(ctx.node.ref)}"`);
    return { syncId: sync._id, key: `pipeline:${ctx.execId}:${ctx.attempt}` };
  },
  async poll(ctx, h) {
    const run = await datasetSyncRuns().findOne({ ownerId: ctx.ownerId, scheduleKey: String(h.key) });
    if (!run) {
      // Not started yet (queue busy, or the queue was lost in a restart): (re-)enqueue; the key keeps it once.
      const sync = await datasetSyncs().findOne({ _id: String(h.syncId), ownerId: ctx.ownerId });
      if (!sync) return { status: 'failed', error: 'The dataset sync was deleted' };
      if (!syncQueue.has(sync._id))
        syncQueue.enqueue(sync._id, effectivePriority(sync), async () => {
          await runDatasetSync(sync, { trigger: 'pipeline', scheduleKey: String(h.key) }).catch(
            () => undefined,
          );
        });
      return { status: 'running' };
    }
    const external = { type: 'dataset_sync_run', ids: [run._id] };
    if (run.status === 'running') return { status: 'running' };
    if (run.status === 'failed') return { status: 'failed', error: run.error ?? 'The sync failed', external };
    return {
      status: 'succeeded',
      external,
      stats: {
        rows: run.rows ?? 0,
        ...(run.symbolsAttempted !== undefined
          ? { symbols_attempted: run.symbolsAttempted, symbols_covered: run.symbolsCovered ?? 0 }
          : {}),
      },
    };
  },
});

registerNodeExecutor('transform', {
  async start(ctx) {
    const t = await transforms().findOne({ ownerId: ctx.ownerId, name: refName(ctx.node.ref) });
    if (!t) throw new Error(`No transform named ${refName(ctx.node.ref)}`);
    const p = ctx.run.period;
    // The run's data epoch is the transform's window.
    const runs = await requestTransformRun(ctx.ownerId, t._id, {
      trigger: 'pipeline',
      ...(p.kind === 'event' ? {} : { range: 'custom' as const, start: p.start, end: p.end }),
    });
    return { runIds: runs.map((r) => r._id) };
  },
  async poll(ctx, h) {
    const ids = h.runIds as string[];
    const runs = await transformRuns()
      .find({ _id: { $in: ids }, ownerId: ctx.ownerId }, { projection: { stdout: 0, stderr: 0 } })
      .toArray();
    const external = { type: 'transform_run', ids };
    if (runs.length < ids.length) return { status: 'failed', error: 'A transform run is missing', external };
    if (runs.some((r) => r.status === 'queued' || r.status === 'running')) return { status: 'running' };
    const failed = runs.find((r) => r.status === 'failed');
    if (failed) return { status: 'failed', error: failed.error ?? 'The transform failed', external };
    // rows = what the transform produced for the period (written + unchanged), so an idempotent re-run
    // that writes nothing new still passes a min_rows gate.
    let written = 0;
    let rows = 0;
    let dq = 0;
    for (const r of runs)
      for (const o of Object.values(r.outputs ?? {})) {
        written += o.written ?? 0;
        rows += (o.written ?? 0) + (o.unchanged ?? 0);
        dq += o.dq ?? 0;
      }
    return { status: 'succeeded', external, stats: { written, rows, dq } };
  },
});

registerNodeExecutor('harness', {
  async start(ctx) {
    const w = await collection<{ _id: string; name: string }>('workflows').findOne({
      ownerId: ctx.ownerId,
      name: refName(ctx.node.ref),
    });
    if (!w) throw new Error(`No harness named "${refName(ctx.node.ref)}"`);
    const p = ctx.run.period;
    const run = await createRun(
      ctx.ownerId,
      {
        workflowId: w._id,
        input:
          typeof ctx.node.params.input === 'string'
            ? ctx.node.params.input
            : `Pipeline ${ctx.run.pipelineName}, period ${p.id} (${p.start} → ${p.end}).`,
        payload: { pipeline: ctx.run.pipelineName, period: p.id, period_start: p.start, period_end: p.end },
        history: [],
      } as never,
      { scheduleKey: `pipeline:${ctx.execId}:${ctx.attempt}`, trigger: 'schedule' },
    );
    return { runId: run._id };
  },
  async poll(ctx, h) {
    const r = await collection<{ _id: string; status: string; error?: string }>('runs').findOne(
      { _id: String(h.runId), ownerId: ctx.ownerId },
      { projection: { status: 1, error: 1 } },
    );
    const external = { type: 'run', ids: [String(h.runId)] };
    if (!r) return { status: 'failed', error: 'The harness run is missing', external };
    if (r.status === 'succeeded') return { status: 'succeeded', external };
    if (['failed', 'cancelled', 'interrupted'].includes(r.status))
      return { status: 'failed', error: r.error ?? `The harness run ${r.status}`, external };
    return { status: 'running' };
  },
});

// check:collection_rows: rows of params.collection in the period (params.date_field, default `date`).
registerNodeExecutor('check', {
  async start() {
    return {};
  },
  async poll(ctx) {
    const c = String(ctx.node.params.collection);
    const field = typeof ctx.node.params.date_field === 'string' ? ctx.node.params.date_field : 'date';
    const p = ctx.run.period;
    const rows = await mongo
      .db(workspaceDatabase(ctx.ownerId))
      .collection(c)
      .countDocuments(p.kind === 'event' ? {} : { [field]: { $gte: p.start, $lte: `${p.end}￿` } });
    return { status: 'succeeded', stats: { rows } };
  },
});

// Research (Layer 3) and live (Layer 5) arrive later; tests (and the test stack) use stubs.
if (process.env.PIPELINE_STUB_EXECUTORS === '1')
  for (const type of ['research', 'live'] as const)
    registerNodeExecutor(type, {
      start: async () => ({ at: Date.now() }),
      poll: async (ctx) => ({ status: 'succeeded', stats: { rows: Number(ctx.node.params.rows ?? 1) } }),
    });

// --- Gates -----------------------------------------------------------------------------------------
/** Gate checks for a succeeded node. `previous` is the same node's stats in the previous period. */
export function evaluateGate(gate: Gate, stats: NodeStats = {}, previous?: NodeStats): GateResult[] {
  const out: GateResult[] = [];
  const rows = stats.rows ?? stats.written;
  if (gate.min_symbol_coverage !== undefined) {
    const cov =
      stats.symbols_attempted && stats.symbols_covered !== undefined
        ? stats.symbols_covered / stats.symbols_attempted
        : null;
    out.push({
      name: 'symbol coverage',
      value: cov === null ? null : Math.round(cov * 1000) / 10,
      threshold: `≥ ${gate.min_symbol_coverage * 100}%`,
      pass: cov !== null && cov >= gate.min_symbol_coverage,
    });
  }
  if (gate.min_rows !== undefined)
    out.push({
      name: 'rows',
      value: rows ?? null,
      threshold: `≥ ${gate.min_rows}`,
      pass: (rows ?? 0) >= gate.min_rows,
    });
  if (gate.max_row_drop_pct !== undefined) {
    const prev = previous?.rows ?? previous?.written;
    const drop = prev && rows !== undefined ? Math.max(0, ((prev - rows) / prev) * 100) : 0;
    out.push({
      name: 'row drop vs previous period',
      value: prev ? Math.round(drop * 10) / 10 : 'no previous period',
      threshold: `≤ ${gate.max_row_drop_pct}%`,
      pass: drop <= gate.max_row_drop_pct,
    });
  }
  if (gate.max_dq_error_rate !== undefined) {
    const rate = (stats.dq ?? 0) / Math.max(1, stats.written ?? stats.rows ?? 0);
    out.push({
      name: 'DQ issues per row',
      value: Math.round(rate * 10000) / 10000,
      threshold: `≤ ${gate.max_dq_error_rate}`,
      pass: rate <= gate.max_dq_error_rate,
    });
  }
  return out;
}

// --- Runs ------------------------------------------------------------------------------------------
const backoffMs = (attempt: number) => [60_000, 300_000, 900_000][Math.min(attempt - 1, 2)];
const freshNodes = (p: Pick<Pipeline, 'nodes'>): Record<string, NodeRun> =>
  Object.fromEntries(p.nodes.map((n) => [n.id, { status: 'pending' as const, ref: n.ref, generation: 0 }]));

/** Start a run for one period (returns the existing run for that period, if any). */
export async function startPipelineRun(
  ownerId: string,
  pipelineId: string,
  opts: { period?: string; trigger?: PipelineRun['trigger']; requestedBy?: string; now?: Date } = {},
) {
  await ensureIndexes();
  const p = await pipelines().findOne({ _id: pipelineId, ownerId });
  if (!p) throw new HttpError(404, 'Pipeline not found');
  const period = opts.period ? parsePeriod(p.period, opts.period) : periodForRun(p.period, opts.now);
  const existing = await pipelineRuns().findOne({ ownerId, pipelineId, 'period.id': period.id });
  if (existing) return { run: existing, created: false };
  const now = opts.now ?? new Date();
  const run: PipelineRun = {
    _id: randomUUID(),
    ownerId,
    pipelineId,
    pipelineName: p.name,
    version: p.version,
    period,
    trigger: opts.trigger ?? 'manual',
    status: 'running',
    nodes: freshNodes(p),
    graph: p.nodes,
    ...(p.deadline_hours ? { deadlineAt: new Date(now.getTime() + p.deadline_hours * 3600_000) } : {}),
    createdAt: now,
    startedAt: now,
    ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
  };
  try {
    await pipelineRuns().insertOne(run);
  } catch (e) {
    if ((e as { code?: number }).code === 11000)
      return {
        run: (await pipelineRuns().findOne({ ownerId, pipelineId, 'period.id': period.id }))!,
        created: false,
      };
    throw e;
  }
  return { run, created: true };
}

/** Queue runs for a range of past periods; they start in order, `parallelism` at a time. */
export async function backfillPipeline(
  ownerId: string,
  pipelineId: string,
  opts: { from: string; to: string; parallelism?: number; requestedBy?: string },
) {
  await ensureIndexes();
  const p = await pipelines().findOne({ _id: pipelineId, ownerId });
  if (!p) throw new HttpError(404, 'Pipeline not found');
  const backfillId = randomUUID();
  const parallelism = Math.min(4, Math.max(1, opts.parallelism ?? 1));
  const queued: PipelineRun[] = [];
  const skipped: string[] = [];
  const base = Date.now();
  for (const [i, period] of periodRange(p.period, opts.from, opts.to).entries()) {
    const run: PipelineRun = {
      _id: randomUUID(),
      ownerId,
      pipelineId,
      pipelineName: p.name,
      version: p.version,
      period,
      trigger: 'backfill',
      backfillId,
      parallelism,
      status: 'queued',
      nodes: freshNodes(p),
      graph: p.nodes,
      createdAt: new Date(base + i),
      ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
    };
    try {
      await pipelineRuns().insertOne(run);
      queued.push(run);
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      skipped.push(period.id); // that period already has a run
    }
  }
  return { backfillId, queued, skipped };
}

async function nodeCompleted(run: PipelineRun, id: string, n: NodeRun) {
  await emitHarnessEvent(run.ownerId, 'pipeline.node.completed', {
    pipeline: run.pipelineName,
    pipeline_id: run.pipelineId,
    run_id: run._id,
    period: run.period.id,
    node: id,
    ref: n.ref,
    status: n.status,
    ...(n.stats ? { stats: n.stats } : {}),
    ...(n.gate?.length ? { gate: n.gate } : {}),
    ...(n.error ? { error: n.error } : {}),
  });
}

async function previousStats(run: PipelineRun, id: string) {
  const prev = await pipelineRuns()
    .find(
      { ownerId: run.ownerId, pipelineId: run.pipelineId, 'period.start': { $lt: run.period.start } },
      { projection: { [`nodes.${id}`]: 1 } },
    )
    .sort({ 'period.start': -1 })
    .limit(1)
    .toArray();
  return prev[0]?.nodes?.[id]?.stats;
}

/** Advance one run as far as it can go now. Returns the run's status. */
export async function advanceRun(runId: string, now = new Date()): Promise<PipelineRun['status']> {
  const run = await pipelineRuns().findOne({ _id: runId });
  if (!run || run.status !== 'running') return run?.status ?? 'cancelled';
  const nodes = run.graph;
  const set: Record<string, unknown> = {};
  const completed: [string, NodeRun][] = [];
  // Several passes: a node that completes (e.g. a check) lets its downstream start in the same tick.
  for (let pass = 0; pass < nodes.length + 1; pass++) {
    let changed = false;
    for (const node of nodes) {
      const n = run.nodes[node.id];
      if (TERMINAL.includes(n.status)) continue;
      const ups = node.after.map((u) => run.nodes[u]);
      if (n.status === 'pending' || n.status === 'waiting') {
        if (ups.some((u) => !TERMINAL.includes(u.status))) {
          if (n.status !== 'waiting') ((n.status = 'waiting'), (changed = true));
          continue;
        }
        const bad = node.after.filter((u) => !OK.includes(run.nodes[u].status));
        if (bad.length) {
          if (node.on_upstream_failure === 'block' || node.on_upstream_failure === 'skip') {
            n.status = node.on_upstream_failure === 'block' ? 'blocked' : 'skipped';
            n.reason = `Upstream ${bad.join(', ')} did not succeed`;
            n.finishedAt = now;
            completed.push([node.id, n]);
            changed = true;
            continue;
          }
          n.warning = `Running although upstream ${bad.join(', ')} did not succeed`;
        }
        // Start, or attach to an execution of the same ref for the same period (shared nodes run once).
        const execId = `${run.ownerId}|${node.ref}|${run.period.id}|${n.generation}`;
        const exec = await executions().findOne({ _id: execId });
        if (!exec) {
          const executor = executorRegistry.get(refType(node.ref));
          if (!executor) {
            Object.assign(n, {
              status: 'failed',
              error: `No executor for ${refType(node.ref)} nodes`,
              finishedAt: now,
            });
            completed.push([node.id, n]);
            changed = true;
            continue;
          }
          try {
            await executions().insertOne({
              _id: execId,
              ownerId: run.ownerId,
              ref: node.ref,
              periodId: run.period.id,
              status: 'running',
              attempts: 1,
              startedAt: now,
              runId: run._id,
            });
            const handle = await executor.start({
              ownerId: run.ownerId,
              run,
              nodeId: node.id,
              node,
              execId,
              attempt: 1,
            });
            await executions().updateOne({ _id: execId }, { $set: { handle } });
          } catch (e) {
            // A start error is a failed attempt: the poll below reports it and the retry policy applies.
            if ((e as { code?: number }).code !== 11000)
              await executions().updateOne(
                { _id: execId },
                { $set: { handle: { startError: safeError(e) } } },
              );
          }
        }
        Object.assign(n, { status: 'running', execId, startedAt: n.startedAt ?? now });
        changed = true;
      }
      if (n.status !== 'running') continue;
      let exec = await executions().findOne({ _id: n.execId! });
      if (!exec) continue;
      // The run that created the execution drives it; others just mirror its result.
      if (exec.status === 'running' && exec.handle && (!exec.nextAttemptAt || exec.nextAttemptAt <= now)) {
        const executor = executorRegistry.get(refType(node.ref))!;
        const ctx = {
          ownerId: run.ownerId,
          run,
          nodeId: node.id,
          node,
          execId: exec._id,
          attempt: exec.attempts,
        };
        let progress: NodeProgress;
        try {
          progress = exec.handle.startError
            ? { status: 'failed', error: String(exec.handle.startError) }
            : now.getTime() - exec.startedAt.getTime() > node.timeout_minutes * 60_000
              ? { status: 'failed', error: `Timed out after ${node.timeout_minutes} min` }
              : await executor.poll(ctx, exec.handle);
        } catch (e) {
          progress = { status: 'failed', error: safeError(e) };
        }
        if (progress.status === 'running') {
          if (progress.handle)
            await executions().updateOne({ _id: exec._id }, { $set: { handle: progress.handle } });
        } else if (progress.status === 'failed' && exec.attempts <= node.retries) {
          // Retry with backoff: a new attempt (a new sync key / transform run / harness run).
          const attempt = exec.attempts + 1;
          const handle = await executor
            .start({ ...ctx, attempt })
            .catch((e) => ({ startError: safeError(e) }) as Record<string, unknown>);
          await executions().updateOne(
            { _id: exec._id },
            {
              $set: {
                attempts: attempt,
                handle,
                error: progress.error,
                nextAttemptAt: new Date(now.getTime() + backoffMs(exec.attempts)),
                startedAt: now,
              },
            },
          );
        } else
          await executions().updateOne(
            { _id: exec._id },
            {
              $set: {
                status: progress.status,
                finishedAt: now,
                ...(progress.status === 'succeeded'
                  ? { stats: progress.stats ?? {} }
                  : { error: progress.error }),
                ...(progress.external ? { external: progress.external } : {}),
              },
            },
          );
        exec = (await executions().findOne({ _id: exec._id }))!;
      }
      n.attempts = exec.attempts;
      if (exec.status === 'running') continue;
      n.finishedAt = exec.finishedAt ?? now;
      if (exec.external) n.external = exec.external;
      if (exec.status === 'failed') {
        n.status = 'failed';
        n.error = exec.error;
      } else {
        n.stats = exec.stats ?? {};
        n.gate = evaluateGate(
          node.gate,
          n.stats,
          node.gate.max_row_drop_pct !== undefined ? await previousStats(run, node.id) : undefined,
        );
        n.status = n.gate.every((g) => g.pass) ? 'succeeded' : 'gate_failed';
      }
      completed.push([node.id, n]);
      changed = true;
    }
    if (!changed) break;
  }
  for (const node of nodes) set[`nodes.${node.id}`] = run.nodes[node.id];
  const all = Object.values(run.nodes);
  let status: PipelineRun['status'] = 'running';
  if (all.every((n) => TERMINAL.includes(n.status)))
    status = all.every((n) => OK.includes(n.status)) ? 'succeeded' : 'failed';
  if (status !== 'running') {
    set.status = status;
    set.finishedAt = now;
  }
  if (run.deadlineAt && !run.deadlineMissed && status === 'running' && now > run.deadlineAt) {
    set.deadlineMissed = true;
    await emitHarnessEvent(run.ownerId, 'pipeline.run.deadline_missed', {
      pipeline: run.pipelineName,
      run_id: run._id,
      period: run.period.id,
      waiting: Object.entries(run.nodes)
        .filter(([, n]) => !TERMINAL.includes(n.status))
        .map(([id]) => id),
    });
  }
  // Guard against a concurrent control (cancel, retry) changing the run meanwhile.
  const w = await pipelineRuns().updateOne({ _id: run._id, status: 'running' }, { $set: set });
  if (!w.modifiedCount && !w.matchedCount) return 'cancelled';
  for (const [id, n] of completed) await nodeCompleted(run, id, n);
  if (status !== 'running')
    await emitHarnessEvent(run.ownerId, 'pipeline.run.completed', {
      pipeline: run.pipelineName,
      pipeline_id: run.pipelineId,
      run_id: run._id,
      period: run.period.id,
      status,
      nodes: Object.fromEntries(Object.entries(run.nodes).map(([id, n]) => [id, n.status])),
    });
  return status;
}

// --- Controls --------------------------------------------------------------------------------------
async function loadRun(ownerId: string, runId: string) {
  const run = await pipelineRuns().findOne({ _id: runId, ownerId });
  if (!run) throw new HttpError(404, 'Pipeline run not found');
  return run;
}
const reset = (n: NodeRun): NodeRun => ({ status: 'pending', ref: n.ref, generation: n.generation + 1 });

/** Retry a node (failed, gate failed, blocked): a fresh execution; blocked/skipped downstream wait again. */
export async function retryNode(ownerId: string, runId: string, nodeId: string) {
  const run = await loadRun(ownerId, runId);
  const n = run.nodes[nodeId];
  if (!n) throw new HttpError(404, 'No such node');
  if (!['failed', 'gate_failed', 'blocked', 'cancelled'].includes(n.status))
    throw new HttpError(409, `Only failed or blocked nodes can be retried (this one is ${n.status})`);
  const set: Record<string, unknown> = { [`nodes.${nodeId}`]: reset(n), status: 'running' };
  for (const d of downstreamOf(run.graph, nodeId))
    if (['blocked', 'skipped', 'cancelled'].includes(run.nodes[d].status))
      set[`nodes.${d}`] = reset(run.nodes[d]);
  await pipelineRuns().updateOne({ _id: runId }, { $set: set, $unset: { finishedAt: '' } });
  return loadRun(ownerId, runId);
}
/** Re-run from here: this node and everything downstream run again; upstream results are kept. */
export async function rerunFrom(ownerId: string, runId: string, nodeId: string) {
  const run = await loadRun(ownerId, runId);
  if (!run.nodes[nodeId]) throw new HttpError(404, 'No such node');
  const set: Record<string, unknown> = { status: 'running' };
  for (const id of [nodeId, ...downstreamOf(run.graph, nodeId)]) set[`nodes.${id}`] = reset(run.nodes[id]);
  await pipelineRuns().updateOne({ _id: runId }, { $set: set, $unset: { finishedAt: '' } });
  return loadRun(ownerId, runId);
}
/** Mark a node skipped (with a reason); downstream treats it as done. */
export async function skipNode(ownerId: string, runId: string, nodeId: string, reason: string) {
  const run = await loadRun(ownerId, runId);
  const n = run.nodes[nodeId];
  if (!n) throw new HttpError(404, 'No such node');
  if (n.status === 'succeeded') throw new HttpError(409, 'This node already succeeded');
  const set: Record<string, unknown> = {
    [`nodes.${nodeId}`]: {
      ...n,
      status: 'skipped',
      reason: reason || 'Skipped by a user',
      finishedAt: new Date(),
    },
    status: 'running',
  };
  for (const d of downstreamOf(run.graph, nodeId))
    if (['blocked', 'skipped'].includes(run.nodes[d].status)) set[`nodes.${d}`] = reset(run.nodes[d]);
  await pipelineRuns().updateOne({ _id: runId }, { $set: set, $unset: { finishedAt: '' } });
  return loadRun(ownerId, runId);
}
/** Cancel a run: nodes not yet done are cancelled (work already started underneath is left to finish). */
export async function cancelPipelineRun(ownerId: string, runId: string) {
  const run = await loadRun(ownerId, runId);
  if (!['running', 'queued'].includes(run.status)) throw new HttpError(409, `The run is ${run.status}`);
  const set: Record<string, unknown> = { status: 'cancelled', finishedAt: new Date() };
  for (const [id, n] of Object.entries(run.nodes))
    if (!TERMINAL.includes(n.status))
      set[`nodes.${id}`] = { ...n, status: 'cancelled', finishedAt: new Date() };
  await pipelineRuns().updateOne({ _id: runId }, { $set: set });
  return loadRun(ownerId, runId);
}

// --- Dispatcher ------------------------------------------------------------------------------------
/** Fired every tick: start scheduled runs, promote queued backfill runs, advance running runs. */
export async function dispatchPipelines(now = new Date(), opts: { ownerId?: string } = {}) {
  await ensureIndexes();
  const owner = opts.ownerId ? { ownerId: opts.ownerId } : {};
  const due = await pipelines()
    .find({
      ...owner,
      enabled: true,
      'schedule.enabled': true,
      $or: [{ nextRunAt: { $lte: now } }, { nextRunAt: { $exists: false } }],
    } as Record<string, unknown>)
    .limit(10)
    .toArray();
  for (const p of due) {
    if (!p.nextRunAt) {
      // Wait for the first slot instead of firing the moment a schedule is saved.
      await pipelines().updateOne({ _id: p._id, nextRunAt: { $exists: false } } as Record<string, unknown>, {
        $set: { nextRunAt: nextScheduledAt(p.schedule!, now) },
      });
      continue;
    }
    const claimed = await pipelines().updateOne(
      { _id: p._id, nextRunAt: p.nextRunAt } as Record<string, unknown>,
      { $set: { nextRunAt: nextScheduledAt(p.schedule!, now) } },
    );
    if (claimed.modifiedCount)
      await startPipelineRun(p.ownerId, p._id, { trigger: 'schedule', now }).catch((e) =>
        console.warn(`Pipeline ${p.name} could not start:`, safeError(e)),
      );
  }
  // Backfills: start queued runs in period order, `parallelism` at a time per backfill.
  const queued = await pipelineRuns()
    .find({ ...owner, status: 'queued' })
    .sort({ 'period.start': 1 })
    .limit(200)
    .toArray();
  for (const r of queued) {
    const active = await pipelineRuns().countDocuments({ backfillId: r.backfillId, status: 'running' });
    if (active >= (r.parallelism ?? 1)) continue;
    const first = await pipelineRuns()
      .find({ backfillId: r.backfillId, status: 'queued' })
      .sort({ 'period.start': 1 })
      .limit(1)
      .next();
    if (first?._id !== r._id) continue;
    await pipelineRuns().updateOne(
      { _id: r._id, status: 'queued' },
      { $set: { status: 'running', startedAt: now } },
    );
  }
  const running = await pipelineRuns()
    .find({ ...owner, status: 'running' }, { projection: { _id: 1 } })
    .limit(100)
    .toArray();
  for (const r of running)
    await advanceRun(r._id, now).catch((e) => console.warn('Pipeline run will retry:', safeError(e)));
}
