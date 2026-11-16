// #528 P1: agents improve from their record. Pure rules (unit-tested) for why an idea failed and which ideas came
// close, plus the lineage guards for refining them; the DB helpers feed the Theorist's brief and refine_theory.
import { HttpError } from './security.js';
import { theories, type Theory } from './theories.js';
import type { GateResult } from './gates.js';

/** At most this many generations in a lineage (the root is 1). */
export const MAX_GENERATIONS = 3;
/** Holdout runs a whole lineage may spend (each theory still has one). */
export const MAX_LINEAGE_HOLDOUTS = 2;
/** A failing gate counts as "close" when its value reaches this share of the threshold. */
export const NEAR_RATIO = 0.8;

export type Cause =
  'costs' | 'no_excess' | 'concentration' | 'regime' | 'data' | 'few_trades' | 'proof' | 'other';
export const CAUSE_TEXT: Record<Cause, string> = {
  costs: 'Costs: the strategy earned before costs and lost it to trading costs and turnover.',
  no_excess: 'No excess: it did not beat the S&P 500 total return (returns were mostly market exposure).',
  concentration: 'Concentration: too few names, or one name or sector carried the result.',
  regime: 'Regime: one market regime carried the result; the others lost.',
  data: 'Data: the evaluation raised a blocking warning (empty books, extreme moves or a reconciliation breach).',
  few_trades: 'Too few trades to judge.',
  proof: 'Not proven: it beat the market but the deflated Sharpe or alpha t-statistic fell short.',
  other: 'Several gates failed without one clear cause.',
};

type Rec = Record<string, any>;
const total = (xs: unknown): number | null => {
  if (!Array.isArray(xs) || !xs.length) return null;
  let g = 1;
  for (const x of xs) if (typeof x === 'number' && Number.isFinite(x)) g *= 1 + x;
  return g - 1;
};

/** The main reason a verdict failed, from its gate results and the exploration record. */
export function causeOf(results: GateResult[], record?: Rec): { cause: Cause; text: string } {
  const failing = new Set(
    results.filter((r) => !r.passed && !r.gate.startsWith('holdout')).map((r) => r.gate),
  );
  const pick = (cause: Cause) => ({ cause, text: CAUSE_TEXT[cause] });
  if (failing.has('no_blocking_warnings')) return pick('data');
  if (failing.has('trades')) return pick('few_trades');
  if (failing.has('holdings')) return pick('concentration');
  const before = total(record?.series?.series?.returns_before_costs);
  const after = record?.summary?.total_return ?? total(record?.series?.series?.returns);
  if (
    failing.has('sharpe') &&
    typeof before === 'number' &&
    before > 0 &&
    typeof after === 'number' &&
    after <= 0
  )
    return pick('costs');
  const excess = record?.excess?.spx?.excess_cagr;
  if (typeof excess === 'number' && excess <= 0) return pick('no_excess');
  const regimes = Object.values((record?.by_regime ?? {}) as Record<string, Record<string, Rec>>).flatMap(
    (g) => Object.values(g),
  );
  const rets = regimes.map((r) => r?.total_return).filter((x): x is number => typeof x === 'number');
  if (rets.length >= 2 && rets.filter((x) => x > 0).length === 1) return pick('regime');
  if (failing.size && [...failing].every((g) => g === 'deflated_sharpe' || g === 'alpha_t'))
    return pick('proof');
  return pick('other');
}

/** How close a failing gate came: value ÷ threshold for "at least" gates (1 or more passes). */
function closeness(r: GateResult): number | null {
  if (typeof r.value !== 'number' || typeof r.threshold !== 'number') return null;
  if (r.threshold <= 0) return r.value >= r.threshold ? 1 : r.value >= r.threshold - 0.1 ? NEAR_RATIO : 0;
  return r.value / r.threshold;
}

/**
 * A near miss (#528): promising (only the proof gates failed), or failed with at most two exploration gates short,
 * each within NEAR_RATIO of its threshold, and no blocking warning.
 */
export function isNearMiss(status: string, results: GateResult[]): boolean {
  if (status === 'promising') return true;
  if (status !== 'failed') return false;
  const failing = results.filter((r) => !r.passed && !r.gate.startsWith('holdout'));
  if (!failing.length || failing.length > 2) return false;
  if (failing.some((r) => r.gate === 'no_blocking_warnings')) return false;
  return failing.every((r) => (closeness(r) ?? 0) >= NEAR_RATIO);
}

/** The latest verdict of a theory: its gates, cause and evaluation (from the history). */
export function lastVerdict(t: Pick<Theory, 'history'>) {
  for (let i = t.history.length - 1; i >= 0; i--) {
    const h = t.history[i]!;
    const gates = (h.data as Rec | undefined)?.gates as GateResult[] | undefined;
    if (h.type === 'transition' && Array.isArray(gates)) return { at: h.at, gates, data: h.data as Rec };
  }
  return undefined;
}

const ref = (t: Pick<Theory, 'number'>) => `T-${t.number}`;

/** The near misses to refine, best first (the excess over the S&P 500, then the Sharpe). */
export async function nearMisses(ownerId: string, limit = 5) {
  const rows = await theories()
    .find(
      { ownerId, status: { $in: ['promising', 'failed'] } },
      { projection: { number: 1, title: 1, family: 1, status: 1, history: 1, generation: 1, parent: 1 } },
    )
    .sort({ number: -1 })
    .limit(400)
    .toArray();
  const out = [];
  for (const t of rows) {
    const v = lastVerdict(t);
    if (!v || !isNearMiss(t.status, v.gates)) continue;
    if (((t as Rec).generation ?? 1) >= MAX_GENERATIONS) continue;
    const val = (g: string) => v.gates.find((r) => r.gate === g)?.value;
    out.push({
      theory_id: ref(t),
      title: t.title,
      family: t.family,
      status: t.status,
      generation: (t as Rec).generation ?? 1,
      failing_gates: v.gates
        .filter((r) => !r.passed && !r.gate.startsWith('holdout'))
        .map((r) => ({ gate: r.gate, value: r.value, threshold: r.threshold })),
      cause: (v.data.cause as Rec | undefined)?.cause ?? causeOf(v.gates).cause,
      sharpe: val('sharpe'),
      excess: (v.data.excess as number | undefined) ?? null,
    });
  }
  out.sort(
    (a, b) =>
      Number(b.excess ?? -1) - Number(a.excess ?? -1) || Number(b.sharpe ?? 0) - Number(a.sharpe ?? 0),
  );
  return out.slice(0, limit);
}

/** A Theorist's own last failures with their cause (#528 §4). */
export async function ownFailures(
  ownerId: string,
  agentKey: { agentId?: string; nodeId?: string },
  limit = 3,
) {
  const who = agentKey.agentId ?? agentKey.nodeId;
  if (!who) return [];
  const rows = await theories()
    .find(
      { ownerId, status: { $in: ['failed', 'promising'] } },
      { projection: { number: 1, title: 1, history: 1 } },
    )
    .sort({ number: -1 })
    .limit(200)
    .toArray();
  const mine = rows.filter((t) => {
    const c = t.history.find((h) => h.type === 'create');
    return c && (c.actor.agentId === who || c.actor.nodeId === who);
  });
  return mine.slice(0, limit).map((t) => {
    const v = lastVerdict(t);
    const cause = (v?.data.cause as Rec | undefined) ?? (v ? causeOf(v.gates) : undefined);
    return {
      theory_id: ref(t),
      title: t.title,
      cause: cause?.cause ?? 'other',
      why: cause?.text ?? '',
      failing_gates: (v?.gates ?? []).filter((r) => !r.passed).map((r) => r.gate),
    };
  });
}

/** The lineage a refinement joins: its root, the child's generation and the holdouts already spent. */
export async function lineageCheck(ownerId: string, parent: Theory) {
  if (!['promising', 'failed'].includes(parent.status))
    throw new HttpError(
      409,
      `${ref(parent)} is ${parent.status}: only a promising or failed idea can be refined`,
    );
  const generation = (((parent as Rec).generation as number | undefined) ?? 1) + 1;
  if (generation > MAX_GENERATIONS)
    throw new HttpError(
      409,
      `${ref(parent)} is generation ${generation - 1}: a lineage stops at ${MAX_GENERATIONS}`,
    );
  const root = ((parent as Rec).lineage as string | undefined) ?? ref(parent);
  const members = await theories()
    .find({ ownerId, $or: [{ lineage: root }, { number: Number(root.slice(2)) }] } as Rec, {
      projection: { holdoutEvaluationId: 1, status: 1 },
    })
    .toArray();
  const spent = members.filter((m) => m.holdoutEvaluationId).length;
  const open = members.filter(
    (m) => !['failed', 'promising', 'successful', 'rejected_untestable', 'parked'].includes(m.status),
  ).length;
  if (spent + open >= MAX_LINEAGE_HOLDOUTS)
    throw new HttpError(
      409,
      `The ${root} lineage has used ${spent} holdout run(s) and has ${open} idea(s) in progress: at most ${MAX_LINEAGE_HOLDOUTS} holdouts per lineage`,
    );
  return { root, generation };
}
