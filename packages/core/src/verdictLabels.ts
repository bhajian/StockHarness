// Promising (#354): verdicts given before the label existed are relabelled from their recorded gates.
import { evaluations } from './evaluations.js';
import { outcomeOf, type GateResult } from './gates.js';
import { theories, transitionTheory } from './theories.js';

/**
 * Failed theories whose recorded verdict says they beat the S&P 500 and failed only the proof gates become
 * promising (once; the history keeps the change). A theory the Judge downgraded from passing stays failed.
 */
export async function relabelPromising(ownerId?: string) {
  let changed = 0;
  for (const t of await theories()
    .find({ status: 'failed', ...(ownerId ? { ownerId } : {}) })
    .toArray()) {
    const v = [...t.history].reverse().find((h) => h.type === 'transition' && h.to === 'failed');
    const data = v?.data as { gates?: GateResult[]; mechanical?: string; evaluationId?: string } | undefined;
    if (!data?.gates || data.mechanical !== 'failed' || !data.evaluationId) continue;
    const e = await evaluations().findOne(
      { _id: data.evaluationId },
      { projection: { 'record.excess.spx.excess_cagr': 1 } },
    );
    const excess = e?.record?.excess?.spx?.excess_cagr as number | undefined;
    if (outcomeOf(data.gates, excess) !== 'promising') continue;
    const proof = data.gates
      .filter((g) => !g.passed && g.gate !== 'holdout')
      .map((g) => g.gate.replace('_', ' '))
      .join(' and ');
    await transitionTheory(
      t.ownerId,
      t._id,
      'promising',
      { role: 'evaluator' },
      `Relabelled (#354): it beat the S&P 500 by ${((excess ?? 0) * 100).toFixed(1)}% a year and failed only the proof gates (${proof}). Promising: worth a simulation or a narrower test, not yet proven.`,
      { relabelled: 'promising', fromVerdictAt: v!.at, evaluationId: data.evaluationId },
    );
    changed++;
  }
  return changed;
}
