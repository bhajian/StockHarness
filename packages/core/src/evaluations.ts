// Evaluations (#104): the trusted evaluator (pipeline/strategy/engine.py) run in the Python executor against a
// pinned plugin version. Each run is one `evaluations` record: the plugin hash, params, costs, data snapshot,
// evaluator version and the numbers + series it produced; never free text. Every evaluation is a trial: the
// workspace's global `trials` counter feeds the deflated Sharpe ratio (#106).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collection } from './db.js';
import { runCodeJob, type CodeJobOutcome } from './codeJobs.js';
import { HttpError, safeError } from './security.js';
import { pitPolicies } from './pitPolicy.js';
import { resolveStrategyPlugin } from './strategyPlugins.js';

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const evaluationParams = z
  .object({
    start: ISO,
    end: ISO,
    /** Tickers or security_ids (the small-scale scope); omitted = the whole universe. */
    symbols: z.array(z.string().min(1).max(20)).max(2000).optional(),
    side: z.enum(['long', 'short', 'long_short']).optional(),
    top_n: z.number().int().min(1).max(1000).optional(),
    rebalance: z.enum(['daily', 'weekly', 'monthly']).optional(),
    /** Values the plugin reads as ctx.params (over META.params). */
    plugin_params: z.record(z.unknown()).optional(),
  })
  .refine((p) => p.start <= p.end, 'start must be on or before end');
export const evaluationInput = z.object({
  plugin: z.string().min(1),
  version: z.number().int().min(1).optional(),
  params: evaluationParams,
  theoryId: z.string().max(200).optional(),
});
export type EvaluationInput = z.infer<typeof evaluationInput>;

export type EvaluationStatus = 'running' | 'succeeded' | 'failed';
export type Evaluation = {
  _id: string;
  ownerId: string;
  pluginId: string;
  pluginName: string;
  pluginVersion: number;
  codeHash: string;
  theoryId?: string;
  mode: 'explore' | 'holdout';
  params: z.infer<typeof evaluationParams>;
  /** This evaluation's number in the workspace's global trial count. */
  trial: number;
  status: EvaluationStatus;
  error?: { type?: string; message: string; frames?: unknown[]; problems?: string[] };
  /** The evaluator's record (engine.py): summary, series, rebalances, holdings, provenance. */
  record?: Record<string, any>;
  codeJobId?: string;
  durationMs?: number;
  createdAt: Date;
  finishedAt?: Date;
  createdBy?: string;
};
export const evaluations = () => collection<Evaluation>('evaluations');
const trials = () => collection<{ _id: string; count: number }>('evaluation_trials');
export const EVALUATION_TIMEOUT_SECONDS = 3600;
const JOB_CODE = 'from pipeline.strategy.job import main\n\nmain()\n';

/** The next trial number (atomic, per workspace). */
async function nextTrial(ownerId: string) {
  const r = await trials().findOneAndUpdate(
    { _id: ownerId },
    { $inc: { count: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return r!.count;
}
export async function trialCount(ownerId: string) {
  return (await trials().findOne({ _id: ownerId }))?.count ?? 0;
}

type Execute = typeof runCodeJob;
/**
 * Create the evaluation record and start the job. Returns the record at once and a promise for the finished one.
 */
export async function startEvaluation(
  ownerId: string,
  input: unknown,
  opts: { userId?: string; execute?: Execute; mode?: Evaluation['mode']; readableEnd?: string } = {},
) {
  const body = evaluationInput.parse(input);
  const { plugin, code, hash, version } = await resolveStrategyPlugin(ownerId, body.plugin, body.version);
  const now = new Date();
  const doc: Evaluation = {
    _id: randomUUID(),
    ownerId,
    pluginId: plugin._id,
    pluginName: plugin.name,
    pluginVersion: version,
    codeHash: hash,
    ...(body.theoryId ? { theoryId: body.theoryId } : {}),
    mode: opts.mode ?? 'explore',
    params: body.params,
    trial: await nextTrial(ownerId),
    status: 'running',
    createdAt: now,
    ...(opts.userId ? { createdBy: opts.userId } : {}),
  };
  await evaluations().insertOne(doc);
  const done = finish(doc, code, opts.execute ?? runCodeJob, opts.readableEnd);
  return { evaluation: doc, done };
}

async function finish(doc: Evaluation, code: string, execute: Execute, readableEnd?: string) {
  let outcome: CodeJobOutcome;
  const set = async (patch: Partial<Evaluation>) => {
    await evaluations().updateOne({ _id: doc._id }, { $set: { ...patch, finishedAt: new Date() } });
    return (await evaluations().findOne({ _id: doc._id }))!;
  };
  try {
    const policies = await pitPolicies(doc.ownerId);
    outcome = await execute(
      {
        ownerId: doc.ownerId,
        runId: `evaluation-${doc._id}`,
        key: '1',
        signal: AbortSignal.timeout((EVALUATION_TIMEOUT_SECONDS + 600) * 1000),
      },
      {
        code: JOB_CODE,
        params: {
          action: 'evaluate',
          code,
          params: doc.params,
          policies,
          ...(readableEnd ? { readable_end: readableEnd } : {}),
          // No trial number here: the record must be identical for identical inputs.
          plugin_ref: { name: doc.pluginName, version: doc.pluginVersion },
        },
        timeoutSeconds: EVALUATION_TIMEOUT_SECONDS,
        purpose: `Evaluate ${doc.pluginName} v${doc.pluginVersion} ${doc.params.start} → ${doc.params.end}`,
      },
    );
  } catch (e) {
    return set({ status: 'failed', error: { message: safeError(e) } });
  }
  const result = outcome.result as
    { ok: true; record: Record<string, any> } | { ok: false; error: Evaluation['error'] } | undefined;
  const base = { codeJobId: outcome.id, durationMs: outcome.durationMs };
  if (outcome.status !== 'succeeded' || !result)
    return set({
      ...base,
      status: 'failed',
      error: {
        message: outcome.error ?? `The evaluator ${outcome.status}`,
        ...(outcome.stderr ? { frames: [{ stderr: outcome.stderr.slice(-4000) }] } : {}),
      },
    });
  if (!result.ok) return set({ ...base, status: 'failed', error: result.error });
  return set({ ...base, status: 'succeeded', record: result.record });
}

export async function getEvaluation(ownerId: string, id: string) {
  const e = await evaluations().findOne({ _id: id, ownerId });
  if (!e) throw new HttpError(404, 'Evaluation not found');
  return e;
}

/** Newest first, without the series (the list view). */
export async function listEvaluations(ownerId: string, filter: { plugin?: string; theoryId?: string } = {}) {
  return evaluations()
    .find(
      {
        ownerId,
        ...(filter.plugin ? { pluginName: filter.plugin } : {}),
        ...(filter.theoryId ? { theoryId: filter.theoryId } : {}),
      },
      { projection: { 'record.series': 0, 'record.rebalances': 0, 'record.holdings': 0 } },
    )
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();
}
