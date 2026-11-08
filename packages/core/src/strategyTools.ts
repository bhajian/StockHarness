// evaluate_strategy / get_evaluation (#109): research MCP tools that run the trusted evaluator on a saved
// StrategyPlugin version. Every call is a trial (#104/#106). The agent gets a compact summary; the full record is
// stored and rendered on the evaluation page. Exploration only: the holdout run is not an agent tool (#105).
import { randomUUID } from 'node:crypto';
import { HttpError } from './security.js';
import {
  evaluatorSettings,
  getEvaluation,
  latestPriceDate,
  startEvaluation,
  type Evaluation,
} from './evaluations.js';
import { runCodeJob } from './codeJobs.js';
import { pitPolicies } from './pitPolicy.js';
import {
  createStrategyPlugin,
  strategyPlugins,
  strategyPluginVersions,
  updateStrategyPlugin,
} from './strategyPlugins.js';

const WAIT_MAX_SECONDS = 50; // MCP clients time out a call after about a minute

const r4 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
const pick = (o: Record<string, unknown> | undefined, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, r4(o![k])]));

/** What the agent sees: numbers, never the series. */
const nameLines = (rows: Array<Record<string, any>>) =>
  rows.map((x) => ({
    name: x.ticker ?? x.security_id,
    contribution: r4(x.contribution),
    trades: x.trades,
    hit_rate: r4(x.hit_rate),
  }));
export function agentSummary(e: Evaluation) {
  const r = e.record;
  return {
    evaluation_id: e._id,
    status: e.status,
    plugin: e.pluginName,
    version: e.pluginVersion,
    code_hash: e.codeHash,
    trial: e.trial,
    page: `/evaluations/${e._id}`,
    ...(e.status === 'failed' ? { error: e.error } : {}),
    ...(r
      ? {
          period: r.period,
          summary: pick(r.summary, [
            'cagr',
            'sharpe',
            'sortino',
            'max_drawdown',
            'calmar',
            'hit_rate',
            'ann_vol',
            'annual_turnover',
            'trades',
            'rebalances',
            'costs_paid',
          ]),
          excess_vs_spx: pick(r.excess?.spx, ['excess_cagr', 'information_ratio', 'tracking_error']),
          excess_vs_sector: pick(r.excess?.sector ?? undefined, ['excess_cagr', 'information_ratio']),
          by_year: (r.folds ?? []).map((f: Record<string, unknown>) =>
            pick(f, ['fold', 'total_return', 'sharpe', 'max_drawdown', 'partial']),
          ),
          factors: {
            alpha_annual: r4(r.factors?.alpha_annual),
            alpha_t: r4(r.factors?.alpha_t),
            betas: Object.fromEntries(Object.entries(r.factors?.betas ?? {}).map(([k, v]) => [k, r4(v)])),
            t: Object.fromEntries(Object.entries(r.factors?.t ?? {}).map(([k, v]) => [k, r4(v)])),
          },
          deflated_sharpe: r4(r.trial_context?.dsr),
          ...(r.subset
            ? {
                subset: {
                  passed: r.subset.passed,
                  verdict: r.subset.verdict,
                  pick_period: r.subset.pick_period,
                  check_period: r.subset.check_period,
                  names: r.subset.chosen.map(
                    (c: { ticker?: string; security_id: string }) => c.ticker ?? c.security_id,
                  ),
                  check_sharpe: r4(r.subset.check?.sharpe),
                  whole_scope_sharpe: r4(r.subset.whole?.sharpe),
                  random_mean_sharpe: r4(r.subset.random?.mean_sharpe),
                  p_value: r4(r.subset.random?.p_value),
                },
              }
            : {}),
          // #324: which names carried it (contribution before costs).
          ...(r.by_name
            ? {
                by_name: {
                  names: r.by_name.names,
                  added: r.by_name.positive,
                  took_away: r.by_name.negative,
                  top_decile_share_of_gains: r4(r.by_name.top_decile_share_of_gains),
                  best: nameLines(r.by_name.rows.slice(0, 5)),
                  worst: nameLines(r.by_name.rows.slice(-5).reverse()),
                },
              }
            : {}),
          warnings: (r.warnings ?? []).map((w: { code: string; count?: number; hint?: string }) => ({
            code: w.code,
            count: w.count,
            hint: w.hint,
          })),
        }
      : {}),
  };
}

export const STRATEGY_TOOLS = [
  {
    name: 'evaluate_strategy',
    description:
      'Run the trusted evaluator on a saved strategy plugin version over [start, end] (before the locked holdout) and return its metrics: CAGR, Sharpe, Sortino, drawdown, by year, excess vs the S&P 500 and sector, factor exposures, the deflated Sharpe over all trials, and warnings. Every call counts as a trial, so evaluate deliberately. Waits up to 50 s; if still running, call get_evaluation with the id.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin: { type: 'string', description: 'StrategyPlugin name' },
        version: { type: 'integer', minimum: 1, description: 'Code version (default: the latest)' },
        theory_id: {
          type: 'string',
          maxLength: 200,
          description: 'For a theory in coding (T-<n>): evaluates its plugin and moves it to the Judge',
        },
        params: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'YYYY-MM-DD' },
            end: { type: 'string', description: 'YYYY-MM-DD, before the holdout' },
            symbols: { type: 'array', items: { type: 'string' }, maxItems: 2000 },
            side: { type: 'string', enum: ['long', 'short', 'long_short'] },
            top_n: { type: 'integer', minimum: 1 },
            rebalance: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
            plugin_params: { type: 'object' },
            universe: {
              type: 'object',
              properties: { top_by_market_cap: { type: 'integer', minimum: 1 } },
              description: 'Only the N largest names by market cap on each date',
            },
          },
          description:
            'For a theory (theory_id) the research scope (its names) is applied for you, and the research window when start or end is missing.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'test_strategy',
    description:
      "Dry-run strategy plugin code on about 20 symbols and a few dates before the holdout. Returns the error (type, message, your code's line numbers, and the real columns for a missing one) or a sanity summary (names scored per date, NaNs, warnings for an empty signal or a blocked lookahead). It never returns performance numbers and is not a trial. Pass plugin to save the code as that plugin's next version; the response says how many fix attempts are left.",
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The whole plugin: META, signal(ctx), optional universe(ctx)' },
        plugin: { type: 'string', description: 'Save as the next version of this plugin (created if new)' },
        note: { type: 'string', maxLength: 500 },
        symbols: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        dates: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        plugin_params: { type: 'object' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_evaluation',
    description: 'The status and metrics of an evaluation started with evaluate_strategy.',
    inputSchema: {
      type: 'object',
      properties: { evaluation_id: { type: 'string' } },
      required: ['evaluation_id'],
      additionalProperties: false,
    },
  },
] as const;

// --- test_strategy (#153) -----------------------------------------------------------------------------------
/** Fix attempts per plugin before the Coder hands it to the Judge (a failing gate is not a bug). */
export const MAX_FIX_ATTEMPTS = 5;
const JOB_CODE = 'from pipeline.strategy.job import main\n\nmain()\n';

type TestArgs = {
  code: string;
  plugin?: string;
  note?: string;
  symbols?: string[];
  dates?: string[];
  plugin_params?: Record<string, unknown>;
};
/**
 * Dry-run a plugin on ~20 symbols × a few dates before the holdout: the error with the plugin's line numbers, or
 * a sanity summary. Never metrics, and never a trial. With `plugin`, the code is saved as that plugin's next
 * version and the outcome recorded on it, so every attempt is in the version history.
 */
export async function testStrategy(ownerId: string, args: TestArgs, execute: typeof runCodeJob = runCodeJob) {
  if (typeof args?.code !== 'string' || !args.code.trim()) throw new HttpError(400, 'code is required');
  const readableEnd = (await evaluatorSettings(ownerId)).readableEnd ?? (await latestPriceDate(ownerId));
  if (!readableEnd) throw new HttpError(400, 'No price data yet');
  let saved: { id: string; name: string; version: number } | undefined;
  if (args.plugin) {
    const existing = await strategyPlugins().findOne({ ownerId, name: args.plugin });
    const body = {
      name: args.plugin,
      code: args.code,
      ...(existing?.description ? { description: existing.description } : {}),
    };
    const note = { note: args.note ?? 'test_strategy attempt' };
    try {
      const p = existing
        ? await updateStrategyPlugin(ownerId, existing._id, body, 'agent', note)
        : await createStrategyPlugin(ownerId, body, 'agent', note);
      saved = { id: p._id, name: p.name, version: p.version };
    } catch (e) {
      // A save-time contract problem (no signal, forbidden import): report it like a test failure.
      if (!(e instanceof HttpError) || e.status !== 400) throw e;
      return {
        passed: false,
        error: { type: 'PluginError', message: e.message, problems: e.message.split('; ') },
        next: 'Fix the code and call test_strategy again.',
      };
    }
  }
  const outcome = await execute(
    { ownerId, runId: `strategy-test-${randomUUID()}`, key: '1', signal: AbortSignal.timeout(300_000) },
    {
      code: JOB_CODE,
      params: {
        action: 'test',
        code: args.code,
        policies: await pitPolicies(ownerId),
        readable_end: readableEnd,
        params: {
          ...(args.symbols ? { symbols: args.symbols } : {}),
          ...(args.dates ? { dates: args.dates } : {}),
          ...(args.plugin_params ? { plugin_params: args.plugin_params } : {}),
        },
      },
      timeoutSeconds: 240,
      purpose: `Test strategy${saved ? ` ${saved.name} v${saved.version}` : ''}`,
    },
  );
  const result = outcome.result as { ok: boolean; test?: any; error?: any } | undefined;
  const error =
    outcome.status !== 'succeeded' || !result
      ? {
          type: 'ExecutorError',
          message: outcome.error ?? `The test ${outcome.status}`,
          stderr: outcome.stderr.slice(-3000),
        }
      : result.ok
        ? undefined
        : result.error;
  const passed = !error && Boolean(result?.test?.ok);
  let attempts: { used: number; left: number } | undefined;
  if (saved) {
    const problem = error
      ? `${error.type}: ${error.message}`.slice(0, 2000)
      : passed
        ? undefined
        : `warnings: ${(result!.test.warnings ?? []).map((w: { code: string }) => w.code).join(', ')}`;
    await strategyPluginVersions().updateOne(
      { _id: `${saved.id}:${saved.version}`, ownerId },
      problem ? { $set: { error: problem } } : { $set: { tested: 'passed' as const } },
    );
    // Consecutive failing attempts since the last passing (or untested) version.
    const recent = await strategyPluginVersions()
      .find({ ownerId, pluginId: saved.id }, { projection: { error: 1 } })
      .sort({ version: -1 })
      .limit(MAX_FIX_ATTEMPTS + 1)
      .toArray();
    let used = 0;
    for (const v of recent) {
      if (!v.error) break;
      used++;
    }
    attempts = { used, left: Math.max(0, MAX_FIX_ATTEMPTS - used) };
  }
  return {
    passed,
    ...(saved ? { plugin: saved.name, version: saved.version } : {}),
    ...(error ? { error } : { summary: result!.test }),
    ...(attempts ? { attempts } : {}),
    next: passed
      ? 'Passed: evaluate it with evaluate_strategy (each evaluation is a trial).'
      : attempts && attempts.left === 0
        ? `Stop: ${MAX_FIX_ATTEMPTS} attempts in a row failed. Hand it to the Judge with a one-line summary of the problem.`
        : 'Fix the code (see the error and its line numbers, or the warnings) and call test_strategy again.',
  };
}

export async function callStrategyTool(
  ownerId: string,
  name: string,
  args: Record<string, unknown>,
  opts: { waitSeconds?: number } = {},
) {
  if (name === 'get_evaluation')
    return agentSummary(await getEvaluation(ownerId, String(args.evaluation_id ?? '')));
  if (name === 'test_strategy') return testStrategy(ownerId, args as unknown as TestArgs);
  if (name !== 'evaluate_strategy') throw new HttpError(404, `Unknown tool ${name}`);
  if (!args.plugin) throw new HttpError(400, 'plugin is required (or theory_id, for a theory in coding)');
  const { evaluation, done } = await startEvaluation(ownerId, {
    plugin: args.plugin,
    ...(args.version ? { version: args.version } : {}),
    ...(args.theory_id ? { theoryId: args.theory_id } : {}),
    params: args.params,
  });
  const wait = Math.min(WAIT_MAX_SECONDS, opts.waitSeconds ?? WAIT_MAX_SECONDS) * 1000;
  const finished = await Promise.race([
    done.catch(() => undefined),
    new Promise<undefined>((r) => void setTimeout(r, wait)),
  ]);
  return agentSummary(finished ?? (await getEvaluation(ownerId, evaluation._id)));
}
export const isStrategyTool = (name: string) => STRATEGY_TOOLS.some((t) => t.name === name);
