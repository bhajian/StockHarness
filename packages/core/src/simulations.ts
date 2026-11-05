// Simulations (#125): one or more ideas run as one book through the paper broker (#124), from a saved, named
// SimulationConfig. A run freezes the config (each idea's plugin version pinned), estimates its runtime, starts the
// executor job and stores the summary, series and attribution; the ledger (orders, trades, the daily portfolio and
// positions) lives in the workspace database, keyed by the simulation id.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collection, mongo } from './db.js';
import { HttpError, safeError } from './security.js';
import { runCodeJob, type CodeJobOutcome } from './codeJobs.js';
import { evaluations, evaluatorSettings, JOB_CODE } from './evaluations.js';
import { workspaceDatabase } from './mongoMcp.js';
import { pitPolicies } from './pitPolicy.js';
import { resolveStrategyPlugin, strategyPluginVersions, strategyPlugins } from './strategyPlugins.js';
import { getTheory } from './theories.js';

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const ratio = (max = 1) => z.number().positive().max(max).nullable().default(null);
export const simulationConfigSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[\w .,:()&+-]+$/, 'letters, digits, spaces and . , : ( ) & + - _'),
  description: z.string().max(2000).default(''),
  /** The ideas, by reference (T-n). plugin and version pin the code; filled in when the config is saved. */
  ideas: z
    .array(
      z.object({
        idea: z.string().trim().min(1).max(200),
        plugin: z.string().min(1).max(200).optional(),
        version: z.number().int().min(1).optional(),
        /** For allocation "custom": the share of capital. */
        weight: z.number().min(0).max(1).optional(),
      }),
    )
    .min(1)
    .max(8),
  period: z
    .object({ start: ISO, end: ISO, allowHoldout: z.boolean().default(false) })
    .refine((p) => p.start <= p.end, 'start must be on or before end'),
  /** Tickers or security ids; omitted = the research settings' evaluation symbols at save time. */
  symbols: z.array(z.string().min(1).max(20)).max(2000).optional(),
  capital: z.number().positive().max(1e12).default(1_000_000),
  benchmark: z.enum(['spx']).default('spx'),
  allocation: z.enum(['equal', 'risk_parity', 'custom']).default('equal'),
  sizing: z
    .object({
      mode: z.enum(['equal', 'quarter_kelly']).default('equal'),
      kellyFraction: z.number().positive().max(1).default(0.25),
    })
    .default({}),
  constraints: z
    .object({
      positionCap: ratio(),
      sectorCap: ratio(),
      gross: z.number().positive().max(3).default(1),
      net: z.number().min(0).max(3).nullable().default(null),
    })
    .default({}),
  exits: z
    .object({
      stop: ratio(),
      takeProfit: z
        .union([z.number().positive().max(10), z.literal('p90')])
        .nullable()
        .default(null),
      horizon: z.boolean().default(false),
      review: z.boolean().default(true),
    })
    .default({}),
  costs: z
    .object({
      commissionBps: z.number().min(0).max(1000),
      slippageBps: z.number().min(0).max(1000),
      borrowBps: z.number().min(0).max(10000),
      executionLagDays: z.number().int().min(1).max(5),
    })
    .partial()
    .default({}),
  hardToBorrow: z.array(z.string().min(1).max(40)).max(2000).default([]),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31)
    .default(0),
});
export type SimulationConfig = z.infer<typeof simulationConfigSchema>;

export type SimulationStatus = 'running' | 'succeeded' | 'failed';
export type Simulation = {
  _id: string;
  ownerId: string;
  name: string;
  config: SimulationConfig;
  status: SimulationStatus;
  estimateSeconds: number;
  usesHoldout: boolean;
  createdAt: Date;
  createdBy?: string;
  finishedAt?: Date;
  durationMs?: number;
  codeJobId?: string;
  result?: Record<string, any>;
  error?: { message: string; type?: string; idea_id?: string; frames?: unknown[]; problems?: string[] };
  sourceId?: string;
  importedAt?: Date;
};
type SavedConfig = {
  _id: string;
  ownerId: string;
  name: string;
  config: SimulationConfig;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
};
export const simulations = () => collection<Simulation>('simulations');
export const simulationConfigs = () => collection<SavedConfig>('simulation_configs');
const ledger = (ownerId: string, c: 'sim_orders' | 'sim_trades' | 'sim_portfolio_daily' | 'sim_positions') =>
  mongo.db(workspaceDatabase(ownerId)).collection<Record<string, any>>(c);
export const SIMULATION_TIMEOUT_SECONDS = 3600;

/** Pin each idea's plugin version (its latest version that passed its test) and the symbols. */
export async function resolveSimulationConfig(ownerId: string, input: unknown): Promise<SimulationConfig> {
  const c = simulationConfigSchema.parse(input);
  const ideas = [];
  for (const i of c.ideas) {
    const t = await getTheory(ownerId, i.idea);
    const ref = `T-${t.number}`;
    const plugin = i.plugin ?? t.plugin?.name;
    if (!plugin)
      throw new HttpError(400, `${ref} has no code yet; the Coder writes it after the Judge approves`);
    let version = i.version;
    if (!version) {
      const p = await strategyPlugins().findOne({ ownerId, name: plugin });
      if (!p) throw new HttpError(404, `No strategy plugin named ${plugin}`);
      const passed = await strategyPluginVersions()
        .find({ ownerId, pluginId: p._id, tested: 'passed' } as Record<string, unknown>)
        .sort({ version: -1 })
        .limit(1)
        .next();
      version = passed?.version ?? p.version;
    }
    await resolveStrategyPlugin(ownerId, plugin, version); // 404 when the version is gone
    ideas.push({ ...i, idea: ref, plugin, version });
  }
  if (c.allocation === 'custom' && ideas.some((i) => i.weight === undefined))
    throw new HttpError(400, 'allocation "custom" needs a weight for every idea');
  if (new Set(ideas.map((i) => i.idea)).size !== ideas.length)
    throw new HttpError(400, 'an idea appears twice in the simulation');
  const symbols =
    c.symbols ??
    ((await collection<any>('research_settings').findOne({ _id: ownerId }))?.evaluationSymbols as
      string[] | undefined);
  return { ...c, ideas, ...(symbols?.length ? { symbols } : {}) };
}

/** Save (or replace) a named config. */
export async function saveSimulationConfig(ownerId: string, input: unknown, userId?: string) {
  const config = await resolveSimulationConfig(ownerId, input);
  const now = new Date();
  const current = await simulationConfigs().findOne({ ownerId, name: config.name });
  if (current) {
    await simulationConfigs().updateOne({ _id: current._id }, { $set: { config, updatedAt: now } });
    return { ...current, config, updatedAt: now };
  }
  const doc: SavedConfig = {
    _id: randomUUID(),
    ownerId,
    name: config.name,
    config,
    createdAt: now,
    updatedAt: now,
    ...(userId ? { createdBy: userId } : {}),
  };
  await simulationConfigs().insertOne(doc);
  return doc;
}

const weekdaysBetween = (a: string, b: string) => {
  let n = 0;
  for (let t = Date.parse(a); t <= Date.parse(b); t += 86400000)
    if (![0, 6].includes(new Date(t).getUTCDay())) n++;
  return n;
};
/** Seconds the run should take: each plugin's measured evaluation speed (ms per session) times the sessions. */
export async function estimateSimulation(ownerId: string, config: SimulationConfig) {
  const days = weekdaysBetween(config.period.start, config.period.end);
  let ms = 0;
  const perIdea = [];
  for (const i of config.ideas) {
    const runs = await evaluations()
      .find(
        { ownerId, pluginName: i.plugin, status: 'succeeded', durationMs: { $gt: 0 } },
        { projection: { durationMs: 1, 'record.period.days': 1, 'params.symbols': 1 } },
      )
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();
    const rates = runs
      .map((e) => (e.durationMs ?? 0) / Math.max(1, (e.record as any)?.period?.days ?? 0))
      .filter((r) => Number.isFinite(r) && r > 0)
      .sort((a, b) => a - b);
    const rate = rates.length ? rates[Math.floor(rates.length / 2)]! : 40;
    perIdea.push({ idea: i.idea, msPerDay: Math.round(rate), measured: rates.length > 0 });
    ms += rate * days;
  }
  // The broker's own pass and the ledger writes, plus starting the job.
  const seconds = Math.ceil((ms * 1.2 + days * 2) / 1000 + 15);
  return { seconds, days, ideas: perIdea };
}

type Execute = typeof runCodeJob;
/** Save the config, create the run and start the job. Returns the run at once and a promise for the finished one. */
export async function startSimulation(
  ownerId: string,
  input: unknown,
  opts: { userId?: string; execute?: Execute } = {},
) {
  const saved = await saveSimulationConfig(ownerId, input, opts.userId);
  const config = saved.config;
  const { readableEnd } = await evaluatorSettings(ownerId);
  const usesHoldout = !!readableEnd && config.period.end > readableEnd;
  if (usesHoldout && !config.period.allowHoldout)
    throw new HttpError(
      400,
      `end ${config.period.end} is inside the locked holdout (after ${readableEnd}); end the simulation by ${readableEnd}, or allow the holdout`,
    );
  const estimate = await estimateSimulation(ownerId, config);
  const doc: Simulation = {
    _id: randomUUID(),
    ownerId,
    name: config.name,
    config,
    status: 'running',
    estimateSeconds: estimate.seconds,
    usesHoldout,
    createdAt: new Date(),
    ...(opts.userId ? { createdBy: opts.userId } : {}),
  };
  await simulations().insertOne(doc);
  const done = finishSimulation(doc, opts.execute ?? runCodeJob, usesHoldout ? undefined : readableEnd);
  return { simulation: doc, estimate, done };
}

/** The Python job's params from a frozen config. */
export async function simulationJobParams(ownerId: string, sim: Simulation, readableEnd?: string) {
  const c = sim.config;
  const ideas = [];
  for (const i of c.ideas) {
    const { code, version } = await resolveStrategyPlugin(ownerId, i.plugin!, i.version);
    ideas.push({ id: i.idea, ref: i.idea, code, plugin_ref: { name: i.plugin, version } });
  }
  const cost = c.costs;
  return {
    action: 'simulate',
    simulation_id: sim._id,
    ideas,
    policies: await pitPolicies(ownerId),
    ...(readableEnd ? { readable_end: readableEnd } : {}),
    params: {
      start: c.period.start,
      end: c.period.end,
      ...(c.symbols?.length ? { symbols: c.symbols } : {}),
      capital: c.capital,
      allocation: {
        mode: c.allocation,
        ...(c.allocation === 'custom'
          ? { weights: Object.fromEntries(c.ideas.map((i) => [i.idea, i.weight ?? 0])) }
          : {}),
      },
      sizing: { mode: c.sizing.mode, kelly_fraction: c.sizing.kellyFraction },
      constraints: {
        position_cap: c.constraints.positionCap,
        sector_cap: c.constraints.sectorCap,
        gross: c.constraints.gross,
        net: c.constraints.net,
      },
      exits: {
        stop: c.exits.stop,
        take_profit: c.exits.takeProfit,
        horizon: c.exits.horizon,
        review: c.exits.review,
      },
      costs: {
        ...(cost.commissionBps !== undefined ? { commission_bps: cost.commissionBps } : {}),
        ...(cost.slippageBps !== undefined ? { slippage_bps: cost.slippageBps } : {}),
        ...(cost.borrowBps !== undefined ? { borrow_cost_bps_default: cost.borrowBps } : {}),
        ...(cost.executionLagDays !== undefined ? { execution_lag_days: cost.executionLagDays } : {}),
      },
      hard_to_borrow: c.hardToBorrow,
      seed: c.seed,
    },
  };
}

async function finishSimulation(doc: Simulation, execute: Execute, readableEnd?: string) {
  const set = async (patch: Partial<Simulation>) => {
    await simulations().updateOne({ _id: doc._id }, { $set: { ...patch, finishedAt: new Date() } });
    return (await simulations().findOne({ _id: doc._id }))!;
  };
  let outcome: CodeJobOutcome;
  try {
    outcome = await execute(
      {
        ownerId: doc.ownerId,
        runId: `simulation-${doc._id}`,
        key: '1',
        signal: AbortSignal.timeout((SIMULATION_TIMEOUT_SECONDS + 600) * 1000),
      },
      {
        code: JOB_CODE,
        params: await simulationJobParams(doc.ownerId, doc, readableEnd),
        timeoutSeconds: SIMULATION_TIMEOUT_SECONDS,
        purpose: `Simulate ${doc.name} ${doc.config.period.start} → ${doc.config.period.end}`,
      },
    );
  } catch (e) {
    return set({ status: 'failed', error: { message: safeError(e) } });
  }
  const result = outcome.result as
    { ok: true; simulation: Record<string, any> } | { ok: false; error: Simulation['error'] } | undefined;
  const base = { codeJobId: outcome.id, durationMs: outcome.durationMs };
  if (outcome.status !== 'succeeded' || !result)
    return set({
      ...base,
      status: 'failed',
      error: {
        message: outcome.error ?? `The simulation ${outcome.status}`,
        ...(outcome.stderr ? { frames: [{ stderr: outcome.stderr.slice(-4000) }] } : {}),
      },
    });
  if (!result.ok) return set({ ...base, status: 'failed', error: result.error });
  return set({ ...base, status: 'succeeded', result: result.simulation });
}

/** A run that outlived its timeout (the API restarted under it) is failed, not running forever. */
async function settleStale(s: Simulation) {
  if (s.status !== 'running') return s;
  if (Date.now() - new Date(s.createdAt).getTime() < (SIMULATION_TIMEOUT_SECONDS + 900) * 1000) return s;
  await simulations().updateOne(
    { _id: s._id, status: 'running' },
    {
      $set: {
        status: 'failed',
        error: { message: 'The simulation did not finish in time' },
        finishedAt: new Date(),
      },
    },
  );
  return (await simulations().findOne({ _id: s._id }))!;
}

export async function getSimulation(ownerId: string, id: string) {
  const s = await simulations().findOne({ ownerId, $or: [{ _id: id }, { sourceId: id }] } as Record<
    string,
    unknown
  >);
  if (!s) throw new HttpError(404, 'Simulation not found');
  return settleStale(s);
}
/** The list: config summary and headline numbers, newest first. */
export async function listSimulations(ownerId: string) {
  const docs = await simulations()
    .find(
      { ownerId },
      { projection: { 'result.series': 0, 'result.attribution': 0, 'result.monthly_returns': 0 } },
    )
    .sort({ createdAt: -1 })
    .limit(500)
    .toArray();
  return Promise.all(
    docs.map(async (d) => {
      const s = await settleStale(d);
      const sum = s.result?.summary ?? {};
      return {
        id: s._id,
        name: s.name,
        ideas: s.config.ideas.map((i) => i.idea),
        period: { start: s.config.period.start, end: s.config.period.end },
        status: s.status,
        usesHoldout: s.usesHoldout,
        cagr: sum.cagr ?? null,
        sharpe: sum.sharpe ?? null,
        maxDrawdown: sum.max_drawdown ?? null,
        finalNav: sum.final_nav ?? null,
        capital: s.config.capital,
        trades: sum.trades ?? null,
        estimateSeconds: s.estimateSeconds,
        durationMs: s.durationMs ?? null,
        createdAt: s.createdAt,
        createdBy: s.createdBy ?? null,
        ...(s.error ? { error: s.error.message } : {}),
      };
    }),
  );
}
export async function listSimulationConfigs(ownerId: string) {
  return simulationConfigs().find({ ownerId }).sort({ updatedAt: -1 }).limit(500).toArray();
}

/** One series (or all of them) of a finished run. */
export async function simulationSeries(ownerId: string, id: string, metric?: string) {
  const s = await getSimulation(ownerId, id);
  const series = s.result?.series;
  if (!series) throw new HttpError(409, `The simulation is ${s.status}`);
  if (!metric) return series;
  if (!(metric in series.series))
    throw new HttpError(400, `metric must be one of ${Object.keys(series.series).join(', ')}`);
  return { dates: series.dates, metric, values: series.series[metric] };
}

const TRADE_SORT: Record<string, Record<string, 1 | -1>> = {
  recent: { exit_date: -1, n: -1 },
  oldest: { entry_date: 1, n: 1 },
  pnl: { pnl: -1 },
  worst: { pnl: 1 },
  return: { return: -1 },
};
export async function simulationTrades(
  ownerId: string,
  id: string,
  q: {
    idea?: string;
    reason?: string;
    side?: string;
    security?: string;
    sort?: string;
    limit?: number;
    offset?: number;
  },
) {
  const s = await getSimulation(ownerId, id);
  const filter: Record<string, unknown> = {
    simulation_id: s._id,
    ...(q.idea ? { idea_id: q.idea } : {}),
    ...(q.reason ? { exit_reason: q.reason } : {}),
    ...(q.side ? { side: q.side } : {}),
    ...(q.security ? { $or: [{ security_id: q.security }, { ticker: q.security.toUpperCase() }] } : {}),
  };
  const col = ledger(ownerId, 'sim_trades');
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 5000);
  const [total, items] = await Promise.all([
    col.countDocuments(filter),
    col
      .find(filter, { projection: { _id: 0, simulation_id: 0 } })
      .sort(TRADE_SORT[q.sort ?? 'recent'] ?? TRADE_SORT.recent!)
      .skip(Math.max(0, q.offset ?? 0))
      .limit(limit)
      .toArray(),
  ]);
  return { total, items };
}
/** One trade with its fills and the prices around it (entry and exit marked), for the trade drawer. */
export async function simulationTrade(ownerId: string, id: string, n: number) {
  const s = await getSimulation(ownerId, id);
  const t = await ledger(ownerId, 'sim_trades').findOne(
    { simulation_id: s._id, n },
    { projection: { _id: 0 } },
  );
  if (!t) throw new HttpError(404, `No trade ${n} in this simulation`);
  const orders = await ledger(ownerId, 'sim_orders')
    .find(
      {
        simulation_id: s._id,
        idea_id: t.idea_id,
        security_id: t.security_id,
        fill_date: { $gte: t.entry_date, ...(t.exit_date ? { $lte: t.exit_date } : {}) },
      },
      { projection: { _id: 0, simulation_id: 0 } },
    )
    .sort({ n: 1 })
    .toArray();
  const pad = (d: string, days: number) =>
    new Date(Date.parse(d) + days * 86400000).toISOString().slice(0, 10);
  const end = t.exit_date ?? s.config.period.end;
  const prices = await mongo
    .db(workspaceDatabase(ownerId))
    .collection<Record<string, any>>('prices_daily')
    .find(
      { security_id: t.security_id, date: { $gte: pad(t.entry_date, -45), $lte: pad(end, 20) } },
      { projection: { _id: 0, date: 1, close: 1 } },
    )
    .sort({ date: 1 })
    .toArray();
  return { trade: t, orders, prices };
}
export async function simulationOrders(
  ownerId: string,
  id: string,
  q: { idea?: string; security?: string; date?: string; limit?: number; offset?: number },
) {
  const s = await getSimulation(ownerId, id);
  const filter: Record<string, unknown> = {
    simulation_id: s._id,
    ...(q.idea ? { idea_id: q.idea } : {}),
    ...(q.date ? { fill_date: q.date } : {}),
    ...(q.security ? { $or: [{ security_id: q.security }, { ticker: q.security.toUpperCase() }] } : {}),
  };
  const col = ledger(ownerId, 'sim_orders');
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 5000);
  const [total, items] = await Promise.all([
    col.countDocuments(filter),
    col
      .find(filter, { projection: { _id: 0, simulation_id: 0 } })
      .sort({ n: 1 })
      .skip(Math.max(0, q.offset ?? 0))
      .limit(limit)
      .toArray(),
  ]);
  return { total, items };
}
/** The book at the close of `date` (the last session on or before it). */
export async function simulationPositions(ownerId: string, id: string, date?: string) {
  const s = await getSimulation(ownerId, id);
  const day = await ledger(ownerId, 'sim_portfolio_daily').findOne(
    { simulation_id: s._id, ...(date ? { date: { $lte: date } } : {}) },
    { sort: { date: -1 }, projection: { _id: 0, simulation_id: 0 } },
  );
  if (!day) return { date: null, portfolio: null, positions: [] };
  const positions = await ledger(ownerId, 'sim_positions')
    .find({ simulation_id: s._id, date: day.date }, { projection: { _id: 0, simulation_id: 0 } })
    .sort({ value: -1 })
    .toArray();
  return { date: day.date, portfolio: day, positions };
}

export async function deleteSimulation(ownerId: string, id: string) {
  const s = await getSimulation(ownerId, id);
  if (s.status === 'running') throw new HttpError(409, 'The simulation is still running');
  for (const c of ['sim_orders', 'sim_trades', 'sim_portfolio_daily', 'sim_positions'] as const)
    await ledger(ownerId, c).deleteMany({ simulation_id: s._id });
  await simulations().deleteOne({ _id: s._id });
}

// --- YAML (kinds SimulationConfig and SimulationRun) ----------------------------------------------------------
/** A config's spec: the frozen definition, references by name (ideas as T-n, plugins by name and version). */
export function simulationConfigSpec(c: SimulationConfig) {
  const { name: _n, ...spec } = simulationConfigSchema.parse(c);
  return spec;
}
/** A run's spec: its config (by value), outcome and the record (summary, series, attribution), verbatim. */
export function simulationRunSpec(s: Simulation) {
  return {
    config: simulationConfigSpec(s.config),
    configName: s.config.name,
    status: s.status,
    usesHoldout: s.usesHoldout,
    estimateSeconds: s.estimateSeconds,
    ...(s.result ? { result: s.result } : {}),
    ...(s.error ? { error: s.error } : {}),
    ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
    createdAt: new Date(s.createdAt).toISOString(),
    ...(s.finishedAt ? { finishedAt: new Date(s.finishedAt).toISOString() } : {}),
  };
}
export const simulationRunSpecSchema = z.object({
  config: z.record(z.unknown()),
  configName: z.string().min(1),
  status: z.enum(['succeeded', 'failed']),
  usesHoldout: z.boolean().default(false),
  estimateSeconds: z.number().default(0),
  result: z.record(z.unknown()).optional(),
  error: z.record(z.unknown()).optional(),
  durationMs: z.number().optional(),
  createdAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'a date'),
  finishedAt: z.string().optional(),
});
/** Restore a saved config from YAML as it is (no resolution: the ideas may arrive in the same import). */
export async function restoreSimulationConfig(ownerId: string, name: string, spec: Record<string, unknown>) {
  const config = simulationConfigSchema.parse({ ...spec, name });
  const now = new Date();
  const current = await simulationConfigs().findOne({ ownerId, name });
  if (current)
    await simulationConfigs().updateOne({ _id: current._id }, { $set: { config, updatedAt: now } });
  else
    await simulationConfigs().insertOne({
      _id: randomUUID(),
      ownerId,
      name,
      config,
      createdAt: now,
      updatedAt: now,
    });
}
export async function restoreSimulationRun(
  ownerId: string,
  name: string,
  spec: z.infer<typeof simulationRunSpecSchema>,
) {
  const taken = await simulations().findOne({ _id: name }, { projection: { _id: 1 } });
  const config = simulationConfigSchema.parse({ ...spec.config, name: spec.configName });
  await simulations().insertOne({
    _id: taken ? randomUUID() : name,
    ...(taken ? { sourceId: name } : {}),
    ownerId,
    name: spec.configName,
    config,
    status: spec.status,
    usesHoldout: spec.usesHoldout,
    estimateSeconds: spec.estimateSeconds,
    ...(spec.result ? { result: spec.result } : {}),
    ...(spec.error ? { error: spec.error as Simulation['error'] } : {}),
    ...(spec.durationMs !== undefined ? { durationMs: spec.durationMs } : {}),
    createdAt: new Date(spec.createdAt),
    ...(spec.finishedAt ? { finishedAt: new Date(spec.finishedAt) } : {}),
    importedAt: new Date(),
  });
}
