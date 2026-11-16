// The placebo and known-answer suite (#468, pipeline/strategy/placebo.py): strategies whose right answer is known, run
// by the executor on the workspace's data over the research window. A failing check means the evaluator can show
// profit from nothing; the result is stored in placebo_runs and shown on Health.
import { randomUUID } from 'node:crypto';
import { collection } from './db.js';
import { config } from './config.js';
import { runCodeJob } from './codeJobs.js';
import { JOB_CODE, evaluatorSettings } from './evaluations.js';
import { pitPolicies } from './pitPolicy.js';
import { safeError } from './security.js';
import { evaluationParams } from './researchLoop.js';

export const placeboRuns = () => collection<any>('placebo_runs');

/** Run the suite in the background; returns the run record at once. */
export const PLACEBO_TOP = 100;
export const PLACEBO_SEEDS = 5;
export async function startPlacebo(
  ownerId: string,
  opts: { seeds?: number; names?: string[]; top?: number; userId?: string } = {},
) {
  const window = await evaluationParams(ownerId);
  if (!window) throw new Error('No price data yet');
  // #514: the checks test the evaluator's math, not a strategy: the research window on at most the 100 largest
  // names (the full live scope ran out of memory at 4 GiB). A symbol scope keeps its symbols.
  const top = Math.max(10, Math.min(500, opts.top ?? PLACEBO_TOP));
  const { readableEnd } = await evaluatorSettings(ownerId);
  const doc = {
    _id: randomUUID(),
    ownerId,
    status: 'running',
    params: {
      start: window.start,
      end: window.end,
      ...('symbols' in window && window.symbols?.length
        ? { symbols: window.symbols }
        : { universe: { top_by_market_cap: top } }),
      seeds: opts.seeds ?? PLACEBO_SEEDS,
      names: opts.names ?? [],
    },
    createdAt: new Date(),
    ...(opts.userId ? { createdBy: opts.userId } : {}),
  };
  await placeboRuns().insertOne(doc);
  void (async () => {
    try {
      const outcome = await runCodeJob(
        { ownerId, runId: `placebo-${doc._id}`, key: '1', signal: AbortSignal.timeout(6 * 3600 * 1000) },
        {
          code: JOB_CODE,
          params: {
            action: 'placebo',
            params: doc.params,
            policies: await pitPolicies(ownerId),
            ...(readableEnd ? { readable_end: readableEnd } : {}),
          },
          timeoutSeconds: 6 * 3600,
          memory: config.EXECUTOR_EVALUATION_MEMORY,
          purpose: `Placebo and known-answer checks ${doc.params.start} → ${doc.params.end}`,
        },
      );
      const result = outcome.result as { ok: boolean; placebo?: any; error?: any } | undefined;
      await placeboRuns().updateOne(
        { _id: doc._id },
        {
          $set: {
            status: outcome.status === 'succeeded' && result?.ok ? 'succeeded' : 'failed',
            ...(result?.placebo ? { result: result.placebo, passed: result.placebo.passed } : {}),
            ...(result?.error ? { error: result.error } : {}),
            // #514: a job that died (out of memory, timeout) has no result: keep its own error.
            ...(!result?.error && outcome.status !== 'succeeded'
              ? { error: { message: outcome.error ?? `the job ${outcome.status}` } }
              : {}),
            finishedAt: new Date(),
          },
        },
      );
    } catch (e) {
      await placeboRuns().updateOne(
        { _id: doc._id },
        { $set: { status: 'failed', error: { message: safeError(e) }, finishedAt: new Date() } },
      );
    }
  })();
  return doc;
}

export const latestPlacebo = (ownerId: string) =>
  placeboRuns().find({ ownerId }).sort({ createdAt: -1 }).limit(1).next();
