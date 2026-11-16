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
/** The suite's parts, as `pipeline/strategy/placebo.py` `parts` lists them. */
export const placeboParts = (seeds: number, names: string[] = []) => [
  ...Array.from({ length: seeds }, (_, k) => `random:${k}`),
  ...names.map((s) => `hold:${s}`),
  'benchmark',
  'future_peek',
  'costs',
];
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
    // #514: one job per part (each random seed, each buy-and-hold name, the benchmark, future peek, costs), so no
    // job holds more than one check; then a small job turns the parts into the suite's result.
    const signal = AbortSignal.timeout(6 * 3600 * 1000);
    const policies = await pitPolicies(ownerId);
    const common = { params: doc.params, policies, ...(readableEnd ? { readable_end: readableEnd } : {}) };
    const job = (key: string, params: Record<string, unknown>, purpose: string) =>
      runCodeJob(
        { ownerId, runId: `placebo-${doc._id}`, key, signal },
        {
          code: JOB_CODE,
          params: { ...common, ...params },
          timeoutSeconds: 3600,
          memory: config.EXECUTOR_EVALUATION_MEMORY,
          purpose,
        },
      );
    const errorOf = (outcome: Awaited<ReturnType<typeof runCodeJob>>, result?: { error?: any }) =>
      result?.error?.message ?? outcome.error ?? `the job ${outcome.status}`;
    try {
      const parts = placeboParts(doc.params.seeds, doc.params.names);
      const entries: any[] = [];
      for (const [k, part] of parts.entries()) {
        const outcome = await job(String(k + 1), { action: 'placebo_part', part }, `Placebo check ${part}`);
        const result = outcome.result as { ok: boolean; entries?: any[]; error?: any } | undefined;
        if (outcome.status === 'succeeded' && result?.ok) entries.push(...(result.entries ?? []));
        else entries.push({ check: part, passed: false, error: errorOf(outcome, result) });
        await placeboRuns().updateOne(
          { _id: doc._id },
          { $set: { progress: { done: k + 1, of: parts.length, part } } },
        );
      }
      const outcome = await job('summary', { action: 'placebo_summary', entries }, 'Placebo summary');
      const result = outcome.result as { ok: boolean; placebo?: any; error?: any } | undefined;
      const ok = outcome.status === 'succeeded' && !!result?.ok;
      await placeboRuns().updateOne(
        { _id: doc._id },
        {
          $set: {
            status: ok ? 'succeeded' : 'failed',
            ...(result?.placebo ? { result: result.placebo, passed: result.placebo.passed } : {}),
            ...(!ok ? { error: { message: errorOf(outcome, result) } } : {}),
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
