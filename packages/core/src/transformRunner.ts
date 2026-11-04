// Transform runner (#90): runs a transform's current version in the Python executor with its window and
// declared outputs, records the run, applies oh.describe() docs to the catalog, refreshes every output's
// catalog entry and emits transform.completed / transform.failed. Runs are queued in the background.
import { randomUUID } from 'node:crypto';
import { collection } from './db.js';
import { HttpError, safeError } from './security.js';
import { nextScheduledAt } from './schedule.js';
import { runCodeJob, type CodeJobOutcome } from './codeJobs.js';
import { emitHarnessEvent } from './harnessEvents.js';
import { patchCatalogEntry, refreshCatalogEntry } from './schemaCatalog.js';
import { SyncWorkQueue } from './syncScheduler.js';
import { addDays, today } from './datasetSync.js';
import { transforms, type Transform } from './transforms.js';

export type TransformWindow = { start: string; end: string; lookback_start: string };
export type TransformRun = {
  _id: string;
  ownerId: string;
  transformId: string;
  transformName: string;
  version: number;
  trigger: 'manual' | 'schedule' | 'event';
  /** Groups the yearly chunks of one backfill request. */
  batchId?: string;
  window?: TransformWindow;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  codeJobId?: string;
  outputs?: Record<string, { written?: number; unchanged?: number; dq?: number }>;
  reads?: Record<string, number>;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs?: number;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  requestedBy?: string;
};
export const transformRuns = () => collection<TransformRun>('transform_runs');
export const transformQueue = new SyncWorkQueue(Math.max(1, Number(process.env.TRANSFORM_CONCURRENCY) || 2));
const TRANSFORM_TIMEOUT_SECONDS = Number(process.env.TRANSFORM_TIMEOUT_SECONDS) || 3600;

/**
 * lookback_days are trading days; the window loads ~1.5× calendar days so weekends and holidays are covered
 * (the code writes only rows in [start, end]).
 */
export function windowFor(t: Pick<Transform, 'incremental'>, start: string, end: string): TransformWindow {
  const lb = t.incremental.lookback_days;
  return { start, end, lookback_start: lb ? addDays(start, -Math.ceil(lb * 1.5) - 1) : start };
}

export type RunRange = { range?: 'last_day' | 'custom' | 'full'; start?: string; end?: string };
/** The windows a run request covers: one, or yearly chunks for a full backfill. Full-mode transforms get none. */
export function plannedWindows(
  t: Pick<Transform, 'incremental'>,
  r: RunRange = {},
): (TransformWindow | undefined)[] {
  if (t.incremental.mode === 'full') return [undefined];
  const end = r.end ?? today();
  if (r.range === 'custom') {
    if (!r.start) throw new HttpError(400, 'A custom range needs a start date');
    if (r.start > end) throw new HttpError(400, 'start must be on or before end');
    return [windowFor(t, r.start, end)];
  }
  if (r.range === 'full') {
    const start = r.start ?? addDays(end, -Math.round(10 * 365.25));
    const out: TransformWindow[] = [];
    for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) {
      const a = y === Number(start.slice(0, 4)) ? start : `${y}-01-01`;
      const b = y === Number(end.slice(0, 4)) ? end : `${y}-12-31`;
      out.push(windowFor(t, a, b));
    }
    return out;
  }
  return [windowFor(t, end, end)];
}

/** Queue runs of a transform (one per window). Chunks of a backfill run in order, one after another. */
export async function requestTransformRun(
  ownerId: string,
  transformId: string,
  opts: RunRange & { trigger?: TransformRun['trigger']; requestedBy?: string; autostart?: boolean } = {},
) {
  const t = await transforms().findOne({ _id: transformId, ownerId });
  if (!t) throw new HttpError(404, 'Transform not found');
  const windows = plannedWindows(t, opts);
  const batchId = windows.length > 1 ? randomUUID() : undefined;
  const now = new Date();
  const runs: TransformRun[] = windows.map((window, i) => ({
    _id: randomUUID(),
    ownerId,
    transformId,
    transformName: t.name,
    version: t.version,
    trigger: opts.trigger ?? 'manual',
    ...(batchId ? { batchId } : {}),
    ...(window ? { window } : {}),
    status: 'queued',
    createdAt: new Date(now.getTime() + i),
    ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
  }));
  await transformRuns().insertMany(runs);
  if (opts.autostart !== false)
    // One queue entry per request: the chunks run sequentially inside it.
    transformQueue.enqueue(batchId ?? runs[0]._id, 'P1', async () => {
      for (const r of runs) {
        const ok = await executeTransformRun(r._id);
        if (!ok) break; // a failed chunk stops the backfill; later chunks stay queued for a retry
      }
    });
  return runs;
}

/** Execute one queued run. Returns true when it succeeded. Exported for tests. */
export async function executeTransformRun(
  runId: string,
  execute: (
    ctx: Parameters<typeof runCodeJob>[0],
    spec: Parameters<typeof runCodeJob>[1],
  ) => Promise<CodeJobOutcome> = runCodeJob,
): Promise<boolean> {
  const claimed = await transformRuns().findOneAndUpdate(
    { _id: runId, status: 'queued' },
    { $set: { status: 'running', startedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!claimed) return false;
  const run = claimed;
  const t = await transforms().findOne({ _id: run.transformId, ownerId: run.ownerId });
  const fail = async (error: string, extra: Partial<TransformRun> = {}) => {
    await transformRuns().updateOne(
      { _id: run._id },
      { $set: { status: 'failed', error, finishedAt: new Date(), ...extra } },
    );
    await emitHarnessEvent(run.ownerId, 'transform.failed', {
      transform: run.transformName,
      transform_id: run.transformId,
      run_id: run._id,
      version: run.version,
      window: run.window,
      error,
    });
    return false;
  };
  if (!t) return fail('The transform was deleted');
  if (!t.enabled && run.trigger !== 'manual') return fail('The transform is disabled');
  let outcome: CodeJobOutcome;
  try {
    outcome = await execute(
      {
        ownerId: run.ownerId,
        runId: `transform-${run._id}`,
        key: '1',
        signal: AbortSignal.timeout((TRANSFORM_TIMEOUT_SECONDS + 600) * 1000),
      },
      {
        code: t.code,
        params: t.params,
        secrets: t.secrets,
        timeoutSeconds: TRANSFORM_TIMEOUT_SECONDS,
        purpose: `Transform ${t.name} v${t.version}${run.window ? ` ${run.window.start} → ${run.window.end}` : ''}`,
        context: {
          OH_OUTPUTS: JSON.stringify(t.outputs),
          OH_DQ_COLLECTION: t.outputs[0].collection,
          ...(run.window ? { OH_WINDOW: JSON.stringify(run.window) } : {}),
        },
      },
    );
  } catch (e) {
    return fail(safeError(e));
  }
  const stats = (outcome.meta?.stats ?? {}) as Record<
    string,
    { read?: number; written?: number; unchanged?: number; dq?: number }
  >;
  const outputNames = new Set(t.outputs.map((o) => o.collection));
  const outputs: TransformRun['outputs'] = {};
  const reads: Record<string, number> = {};
  for (const [c, s] of Object.entries(stats)) {
    if (s.read) reads[c] = s.read;
    if (outputNames.has(c) || s.written || s.dq)
      outputs[c] = { written: s.written ?? 0, unchanged: s.unchanged ?? 0, dq: s.dq ?? 0 };
  }
  const base = {
    codeJobId: outcome.id,
    outputs,
    reads,
    stdout: (outcome.stdout ?? '').slice(-20000),
    stderr: (outcome.stderr ?? '').slice(-20000),
    durationMs: outcome.durationMs,
  };
  if (outcome.status !== 'succeeded') return fail(outcome.error ?? `The code ${outcome.status}`, base);
  // oh.describe() docs become curated catalog docs; every output's entry is refreshed.
  for (const d of (Array.isArray(outcome.meta?.describe) ? outcome.meta!.describe : []) as {
    collection?: string;
    description?: string;
    grain?: string;
    fields?: Record<string, { description?: string; unit?: string }>;
  }[])
    if (d?.collection && outputNames.has(d.collection))
      await patchCatalogEntry(run.ownerId, d.collection, {
        description: d.description,
        grain: d.grain,
        fields: d.fields ?? {},
      }).catch(() => undefined);
  for (const c of outputNames) await refreshCatalogEntry(run.ownerId, c).catch(() => undefined);
  await transformRuns().updateOne(
    { _id: run._id },
    { $set: { status: 'succeeded', finishedAt: new Date(), ...base } },
  );
  await emitHarnessEvent(run.ownerId, 'transform.completed', {
    transform: t.name,
    transform_id: t._id,
    run_id: run._id,
    version: run.version,
    window: run.window,
    outputs,
    trigger: run.trigger,
  });
  return true;
}

/** After a restart: runs that were queued or running are failed (their executor job may be gone). */
export async function recoverTransformRuns() {
  const r = await transformRuns().updateMany(
    { status: { $in: ['queued', 'running'] } },
    { $set: { status: 'failed', error: 'Interrupted by a server restart', finishedAt: new Date() } },
  );
  return r.modifiedCount;
}

/** Fired every tick: run due scheduled transforms (window = the last day for date_range transforms). */
export async function dispatchTransforms() {
  const due = await transforms()
    .find({
      enabled: true,
      'trigger.schedule.enabled': true,
      $or: [{ nextRunAt: { $lte: new Date() } }, { nextRunAt: { $exists: false } }],
    } as Record<string, unknown>)
    .limit(10)
    .toArray();
  for (const t of due as (Transform & { nextRunAt?: Date })[]) {
    const schedule = t.trigger.schedule!;
    if (!t.nextRunAt && schedule.at && schedule.everyMinutes >= 1440) {
      await transforms().updateOne({ _id: t._id, nextRunAt: { $exists: false } } as Record<string, unknown>, {
        $set: { nextRunAt: nextScheduledAt(schedule) } as Record<string, unknown>,
      });
      continue;
    }
    const claimed = await transforms().updateOne(
      {
        _id: t._id,
        ...(t.nextRunAt ? { nextRunAt: t.nextRunAt } : { nextRunAt: { $exists: false } }),
      } as Record<string, unknown>,
      { $set: { nextRunAt: nextScheduledAt(schedule) } as Record<string, unknown> },
    );
    if (claimed.matchedCount)
      await requestTransformRun(t.ownerId, t._id, { trigger: 'schedule' }).catch((e) =>
        console.warn('Transform schedule failed:', safeError(e)),
      );
  }
}
