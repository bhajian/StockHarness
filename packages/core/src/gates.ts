// Success gates (#113): success is mechanical. A theory's verdict comes from fixed thresholds applied to its
// exploration evaluation and its one-shot holdout. The Judge may downgrade a passing theory (with reasons) but can
// never upgrade a failing one. Gates are versioned: a version is locked once a verdict used it, and changing the
// thresholds makes a new version, so verdicts stay comparable within a version.
import { z } from 'zod';
import { collection } from './db.js';
import { HttpError } from './security.js';

export const gatesSchema = z.object({
  /** Exploration (out-of-sample, walk-forward) Sharpe. */
  minSharpe: z.number().default(0.5),
  /** Deflated Sharpe probability over all trials (#106). */
  minDeflatedSharpe: z.number().min(0).max(1).default(0.95),
  /** Share of calendar years with positive excess over the S&P 500. */
  minPositiveExcessYears: z.number().min(0).max(1).default(0.6),
  /** The one-shot holdout (#105): excess over the S&P 500 above this, and Sharpe at least minHoldoutSharpe. */
  minHoldoutExcess: z.number().default(0),
  minHoldoutSharpe: z.number().default(0.3),
  minTrades: z.number().int().min(0).default(100),
  /** Average names held per rebalance. */
  minHoldings: z.number().min(0).default(10),
  /** Alpha t-statistic after the factor regression (Newey-West). */
  minAlphaT: z.number().default(2),
  /** Evaluation warnings that fail the theory outright. */
  blockingWarnings: z.array(z.string()).default(['empty_book', 'extreme_returns']),
});
export type Gates = z.infer<typeof gatesSchema>;
export const DEFAULT_GATES: Gates = gatesSchema.parse({});

export type GatesVersion = {
  _id: string; // `${ownerId}:${version}`
  ownerId: string;
  version: number;
  gates: Gates;
  note?: string;
  createdAt: Date;
  createdBy?: string;
  /** Set when a verdict first used this version; a locked version never changes. */
  lockedAt?: Date;
};
export const gatesVersions = () => collection<GatesVersion>('research_gates');
const settings = () => collection<{ _id: string; gatesVersion?: number }>('research_settings');

/** The active gates version (v1 with the defaults on first use). */
export async function activeGates(ownerId: string): Promise<GatesVersion> {
  const s = await settings().findOne({ _id: ownerId });
  if (s?.gatesVersion) {
    const g = await gatesVersions().findOne({ ownerId, version: s.gatesVersion });
    if (g) return g;
  }
  const latest = await gatesVersions().find({ ownerId }).sort({ version: -1 }).limit(1).next();
  if (latest) return latest;
  const v1: GatesVersion = {
    _id: `${ownerId}:1`,
    ownerId,
    version: 1,
    gates: DEFAULT_GATES,
    note: 'Defaults',
    createdAt: new Date(),
  };
  await gatesVersions()
    .insertOne(v1)
    .catch(() => undefined); // a concurrent first use created it
  return (await gatesVersions().findOne({ _id: v1._id }))!;
}
/** New thresholds are always a new version; it becomes the active one. */
export async function createGatesVersion(ownerId: string, input: unknown, userId?: string, note?: string) {
  const current = await activeGates(ownerId);
  const gates = gatesSchema.parse({ ...current.gates, ...(input as object) });
  const latest = await gatesVersions().find({ ownerId }).sort({ version: -1 }).limit(1).next();
  const version = (latest?.version ?? 0) + 1;
  const doc: GatesVersion = {
    _id: `${ownerId}:${version}`,
    ownerId,
    version,
    gates,
    ...(note ? { note } : {}),
    createdAt: new Date(),
    ...(userId ? { createdBy: userId } : {}),
  };
  await gatesVersions().insertOne(doc);
  await settings().updateOne({ _id: ownerId }, { $set: { gatesVersion: version } }, { upsert: true });
  return doc;
}
export const lockGates = (g: GatesVersion) =>
  gatesVersions().updateOne({ _id: g._id, lockedAt: { $exists: false } }, { $set: { lockedAt: new Date() } });

// --- evaluating the gates (pure) -----------------------------------------------------------------------------
type Rec = Record<string, any>;
export type GateResult = {
  gate: string;
  passed: boolean;
  value: number | string | null;
  threshold: number | string;
  detail?: string;
};

/** Excess over the S&P 500 per calendar year, from the record's daily series. */
export function yearlyExcess(record: Rec): { year: string; excess: number }[] {
  const dates: string[] = record?.series?.dates ?? [];
  const r: (number | null)[] = record?.series?.series?.returns ?? [];
  const b: (number | null)[] = record?.series?.series?.spx_returns ?? [];
  const by = new Map<string, { s: number; m: number }>();
  dates.forEach((d, i) => {
    const y = d.slice(0, 4);
    const cur = by.get(y) ?? { s: 1, m: 1 };
    cur.s *= 1 + (r[i] ?? 0);
    cur.m *= 1 + (b[i] ?? 0);
    by.set(y, cur);
  });
  return [...by].map(([year, v]) => ({ year, excess: v.s - v.m }));
}
const avgHoldings = (record: Rec) => {
  const rb: Rec[] = record?.rebalances ?? [];
  return rb.length ? rb.reduce((n, x) => n + (x.long ?? 0) + (x.short ?? 0), 0) / rb.length : 0;
};

/** Every gate against an exploration record and (when it exists) the holdout record. */
export function evaluateGates(gates: Gates, explore: Rec | undefined, holdout?: Rec): GateResult[] {
  const out: GateResult[] = [];
  const add = (gate: string, value: number | null, threshold: number, passed: boolean, detail?: string) =>
    out.push({
      gate,
      value: value === null ? null : Math.round(value * 1e4) / 1e4,
      threshold,
      passed,
      ...(detail ? { detail } : {}),
    });
  if (!explore) {
    out.push({
      gate: 'evaluation',
      passed: false,
      value: null,
      threshold: 'a succeeded evaluation',
      detail: 'no evaluation yet',
    });
    return out;
  }
  const sharpe = explore.summary?.sharpe ?? null;
  add('sharpe', sharpe, gates.minSharpe, sharpe !== null && sharpe >= gates.minSharpe);
  const dsr = explore.trial_context?.dsr ?? null;
  add(
    'deflated_sharpe',
    dsr,
    gates.minDeflatedSharpe,
    dsr !== null && dsr >= gates.minDeflatedSharpe,
    `over ${explore.trial_context?.trials ?? '?'} trials`,
  );
  const years = yearlyExcess(explore);
  const share = years.length ? years.filter((y) => y.excess > 0).length / years.length : null;
  add(
    'positive_excess_years',
    share,
    gates.minPositiveExcessYears,
    share !== null && share >= gates.minPositiveExcessYears,
    years.map((y) => `${y.year} ${y.excess >= 0 ? '+' : ''}${(y.excess * 100).toFixed(1)}%`).join(', '),
  );
  const trades = explore.summary?.trades ?? null;
  add('trades', trades, gates.minTrades, trades !== null && trades >= gates.minTrades);
  const holdings = avgHoldings(explore);
  add('holdings', holdings, gates.minHoldings, holdings >= gates.minHoldings, 'average names per rebalance');
  const alphaT = explore.factors?.alpha_t ?? null;
  add('alpha_t', alphaT, gates.minAlphaT, alphaT !== null && alphaT >= gates.minAlphaT);
  const blocking = (explore.warnings ?? [])
    .map((w: Rec) => w.code)
    .filter((c: string) => gates.blockingWarnings.includes(c));
  out.push({
    gate: 'no_blocking_warnings',
    passed: !blocking.length,
    value: blocking.join(', ') || 'none',
    threshold: gates.blockingWarnings.join(', '),
  });
  if (!holdout)
    out.push({
      gate: 'holdout',
      passed: false,
      value: null,
      threshold: `excess > ${gates.minHoldoutExcess}, Sharpe ≥ ${gates.minHoldoutSharpe}`,
      detail: 'pending: no holdout run yet',
    });
  else {
    const ex = holdout.excess?.spx?.excess_cagr ?? null;
    const hs = holdout.summary?.sharpe ?? null;
    add('holdout_excess', ex, gates.minHoldoutExcess, ex !== null && ex > gates.minHoldoutExcess);
    add('holdout_sharpe', hs, gates.minHoldoutSharpe, hs !== null && hs >= gates.minHoldoutSharpe);
  }
  return out;
}
/** Every exploration gate passes (everything but the holdout). */
export const exploreGatesPass = (results: GateResult[]) =>
  results.filter((r) => !r.gate.startsWith('holdout')).every((r) => r.passed);
export const allGatesPass = (results: GateResult[]) => results.every((r) => r.passed);

/** The Judge's verdict against the mechanical one: a downgrade needs reasons, an upgrade is refused. */
export function verdictProblem(
  requested: 'successful' | 'failed',
  mechanical: 'successful' | 'failed',
  reasoning: string,
) {
  if (requested === 'successful' && mechanical === 'failed')
    return 'The gates failed, so the verdict is failed: the Judge can downgrade a passing theory but never upgrade a failing one';
  if (requested === 'failed' && mechanical === 'successful' && reasoning.trim().length < 20)
    return 'Downgrading a theory that passed every gate needs the reasons (at least a sentence)';
  return undefined;
}

// --- forward_only (#113) --------------------------------------------------------------------------------------
/** Collections that hold weekly snapshots with history only from their first snapshot (2026-10). */
export const SNAPSHOT_ONLY = [
  'analyst_estimates',
  'price_target_consensus',
  'grades_consensus',
  'financial_scores',
];
/** A theory that needs estimate or consensus snapshots cannot be backtested: it goes to paper tracking (Layer 5). */
export const isForwardOnly = (dataNeeded: string[]) =>
  dataNeeded.some((d) => SNAPSHOT_ONLY.includes(d.split('.')[0].trim()));

export function assertNotLocked(g: GatesVersion) {
  if (g.lockedAt) throw new HttpError(409, `Gates v${g.version} is locked; create a new version instead`);
}
