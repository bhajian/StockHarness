// evaluate_strategy / get_evaluation (#109): research MCP tools that run the trusted evaluator on a saved
// StrategyPlugin version. Every call is a trial (#104/#106). The agent gets a compact summary; the full record is
// stored and rendered on the evaluation page. Exploration only: the holdout run is not an agent tool (#105).
import { HttpError } from './security.js';
import { getEvaluation, startEvaluation, type Evaluation } from './evaluations.js';

const WAIT_MAX_SECONDS = 50; // MCP clients time out a call after about a minute

const r4 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
const pick = (o: Record<string, unknown> | undefined, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, r4(o![k])]));

/** What the agent sees: numbers, never the series. */
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
        theory_id: { type: 'string', maxLength: 200 },
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
          },
          required: ['start', 'end'],
        },
      },
      required: ['plugin', 'params'],
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

export async function callStrategyTool(
  ownerId: string,
  name: string,
  args: Record<string, unknown>,
  opts: { waitSeconds?: number } = {},
) {
  if (name === 'get_evaluation')
    return agentSummary(await getEvaluation(ownerId, String(args.evaluation_id ?? '')));
  if (name !== 'evaluate_strategy') throw new HttpError(404, `Unknown tool ${name}`);
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
