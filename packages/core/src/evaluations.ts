// Evaluations (#104): the trusted evaluator (pipeline/strategy/engine.py) run in the Python executor against a
// pinned plugin version. Each run is one `evaluations` record: the plugin hash, params, costs, data snapshot,
// evaluator version and the numbers + series it produced; never free text. Every evaluation is a trial: the
// workspace's global `trials` counter feeds the deflated Sharpe ratio (#106).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collection, mongo } from './db.js';
import { workspaceDatabase } from './mongoMcp.js';
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
  /** A re-run of another evaluation (#118): not a new trial; `match` is set when it finishes. */
  reproduces?: { of: string; match?: boolean; originalHash?: string; hash?: string };
};
export const evaluations = () => collection<Evaluation>('evaluations');
const trials = () => collection<{ _id: string; count: number }>('evaluation_trials');
export const EVALUATION_TIMEOUT_SECONDS = 3600;
export const JOB_CODE = 'from pipeline.strategy.job import main\n\nmain()\n';

/** The next trial number (atomic, per workspace). */
async function nextTrial(ownerId: string) {
  const r = await trials().findOneAndUpdate(
    { _id: ownerId },
    { $inc: { count: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return r!.count;
}
/**
 * Variance of the per-period (daily) Sharpe ratios of every finished evaluation in the workspace: the spread of
 * the swarm's trials, for the deflated Sharpe ratio (#106). Undefined until two exist.
 */
export async function sharpeVariance(ownerId: string) {
  const rows = await evaluations()
    .find(
      { ownerId, status: 'succeeded', 'record.summary.sharpe': { $type: 'number' } },
      { projection: { 'record.summary.sharpe': 1 } },
    )
    .toArray();
  const xs = rows.map((r) => (r.record!.summary.sharpe as number) / Math.sqrt(252));
  if (xs.length < 2) return undefined;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
}
export async function trialCount(ownerId: string) {
  return (await trials().findOne({ _id: ownerId }))?.count ?? 0;
}

// --- Holdout (#105) ------------------------------------------------------------------------------------
/** The last N months of price history are locked; pipeline/config/backtest.yaml holdout_months. */
export const DEFAULT_HOLDOUT_MONTHS = 18;
type EvaluatorSettings = {
  _id: string; // ownerId
  holdoutMonths: number;
  /** First locked date. Fixed once set, so data never moves out of the holdout as new days arrive. */
  holdoutStart?: string;
  latestAtSet?: string;
  setAt?: Date;
};
const settingsCol = () => collection<EvaluatorSettings>('evaluator_settings');
export type HoldoutRun = {
  _id: string; // `${ownerId}:${theoryKey}:${codeHash}`
  ownerId: string;
  theoryKey: string;
  codeHash: string;
  evaluationId: string;
  createdAt: Date;
};
export const holdoutRuns = () => collection<HoldoutRun>('holdout_runs');

const addDaysIso = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** The same day-of-month N months earlier (clamped to the month's last day). */
export function monthsBefore(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) - n;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
/** The latest prices_daily as_of_date in the workspace (the data's "today"). */
export async function latestPriceDate(ownerId: string) {
  const row = await mongo
    .db(workspaceDatabase(ownerId))
    .collection('prices_daily')
    .find({ as_of_date: { $type: 'string' } }, { projection: { as_of_date: 1 } })
    .sort({ as_of_date: -1 })
    .limit(1)
    .next();
  return (row?.as_of_date as string | undefined) ?? undefined;
}
/**
 * The holdout boundary (set on first use from the latest price date) and the last date exploration may read.
 * Without price data there is nothing to lock yet.
 */
export async function evaluatorSettings(ownerId: string) {
  let s = await settingsCol().findOne({ _id: ownerId });
  if (!s?.holdoutStart) {
    const latest = await latestPriceDate(ownerId);
    const months = s?.holdoutMonths ?? DEFAULT_HOLDOUT_MONTHS;
    if (latest) {
      const holdoutStart = monthsBefore(latest, months);
      await settingsCol()
        .updateOne(
          { _id: ownerId, holdoutStart: { $exists: false } } as Record<string, unknown>,
          { $set: { holdoutMonths: months, holdoutStart, latestAtSet: latest, setAt: new Date() } },
          { upsert: true },
        )
        .catch(() => undefined); // a concurrent first use set it already
      s = await settingsCol().findOne({ _id: ownerId });
    }
  }
  const holdoutStart = s?.holdoutStart;
  return {
    holdoutMonths: s?.holdoutMonths ?? DEFAULT_HOLDOUT_MONTHS,
    holdoutStart,
    readableEnd: holdoutStart ? addDaysIso(holdoutStart, -1) : undefined,
    latestAtSet: s?.latestAtSet,
    setAt: s?.setAt,
    holdoutRuns: await holdoutRuns().countDocuments({ ownerId }),
  };
}
/** Change the holdout length; refused once a holdout run used the current boundary. */
export async function setHoldoutMonths(ownerId: string, months: number) {
  if (!Number.isInteger(months) || months < 1 || months > 120)
    throw new HttpError(400, 'holdoutMonths must be a whole number of months between 1 and 120');
  if (await holdoutRuns().countDocuments({ ownerId }))
    throw new HttpError(409, 'Holdout runs exist: the holdout boundary is locked');
  await settingsCol().updateOne(
    { _id: ownerId },
    { $set: { holdoutMonths: months }, $unset: { holdoutStart: '', latestAtSet: '', setAt: '' } },
    { upsert: true },
  );
  return evaluatorSettings(ownerId);
}

type Execute = typeof runCodeJob;
/**
 * Create the evaluation record and start the job. Returns the record at once and a promise for the finished one.
 */
export async function startEvaluation(
  ownerId: string,
  input: unknown,
  opts: {
    userId?: string;
    execute?: Execute;
    mode?: Evaluation['mode'];
    readableEnd?: string;
    /** Re-run this evaluation (same plugin version and params): it keeps the original's trial number. */
    reproduces?: Evaluation;
  } = {},
) {
  const body = evaluationInput.parse(input);
  const mode = opts.mode ?? 'explore';
  let readableEnd = opts.readableEnd;
  if (mode === 'explore') {
    // Exploration never reaches the locked holdout (#105): neither the dates scored nor the data read.
    readableEnd = (await evaluatorSettings(ownerId)).readableEnd;
    if (readableEnd && body.params.end > readableEnd)
      throw new HttpError(
        400,
        `end ${body.params.end} is inside the locked holdout (from ${addDaysIso(readableEnd, 1)}); evaluate up to ${readableEnd}, or use the one-shot holdout run`,
      );
  }
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
    mode,
    params: body.params,
    trial: opts.reproduces ? opts.reproduces.trial : await nextTrial(ownerId),
    ...(opts.reproduces
      ? { reproduces: { of: opts.reproduces._id, originalHash: opts.reproduces.record?.record_hash } }
      : {}),
    status: 'running',
    createdAt: now,
    ...(opts.userId ? { createdBy: opts.userId } : {}),
  };
  await evaluations().insertOne(doc);
  const done = finish(doc, code, opts.execute ?? runCodeJob, readableEnd);
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
    const trials = { count: doc.trial, sharpe_variance: await sharpeVariance(doc.ownerId) };
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
          params: { ...doc.params, trials },
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
  return set({
    ...base,
    status: 'succeeded',
    record: result.record,
    ...(doc.reproduces
      ? {
          reproduces: {
            ...doc.reproduces,
            hash: result.record.record_hash,
            match: result.record.record_hash === doc.reproduces.originalHash,
          },
        }
      : {}),
  });
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

export const holdoutInput = z.object({
  plugin: z.string().min(1),
  version: z.number().int().min(1).optional(),
  theoryId: z.string().max(200).optional(),
  params: z
    .object({
      symbols: z.array(z.string().min(1).max(20)).max(2000).optional(),
      side: z.enum(['long', 'short', 'long_short']).optional(),
      top_n: z.number().int().min(1).max(1000).optional(),
      rebalance: z.enum(['daily', 'weekly', 'monthly']).optional(),
      plugin_params: z.record(z.unknown()).optional(),
    })
    .default({}),
});
/**
 * The one-shot holdout run (#105): the holdout period, once per theory (or plugin) and code version. The
 * claim is recorded before anything runs, so a second attempt is refused even if the first one fails.
 */
export async function startHoldoutEvaluation(
  ownerId: string,
  input: unknown,
  opts: { userId?: string; execute?: Execute } = {},
) {
  const body = holdoutInput.parse(input);
  const settings = await evaluatorSettings(ownerId);
  const latest = await latestPriceDate(ownerId);
  if (!settings.holdoutStart || !latest) throw new HttpError(400, 'No price data yet: there is no holdout');
  const { plugin, hash } = await resolveStrategyPlugin(ownerId, body.plugin, body.version);
  const theoryKey = body.theoryId ? `theory:${body.theoryId}` : `plugin:${plugin._id}`;
  const _id = `${ownerId}:${theoryKey}:${hash}`;
  const placeholder = `pending-${randomUUID()}`;
  try {
    await holdoutRuns().insertOne({
      _id,
      ownerId,
      theoryKey,
      codeHash: hash,
      evaluationId: placeholder,
      createdAt: new Date(),
    });
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
    const prior = await holdoutRuns().findOne({ _id });
    throw new HttpError(
      409,
      `The holdout was already used for this ${body.theoryId ? 'theory' : 'plugin'} and code version (evaluation ${prior?.evaluationId}); it is one shot`,
    );
  }
  const started = await startEvaluation(
    ownerId,
    {
      plugin: body.plugin,
      version: body.version,
      theoryId: body.theoryId,
      params: { ...body.params, start: settings.holdoutStart, end: latest },
    },
    { ...opts, mode: 'holdout', readableEnd: latest },
  );
  await holdoutRuns().updateOne({ _id }, { $set: { evaluationId: started.evaluation._id } });
  return started;
}
