// Research scorecards (#460): how each Theorist model and each strategy family has done, overall and over the last
// 30 and 90 days. The Lab shows them; a Theorist's brief carries its own record so it can learn from it. The formulas
// are pure (scorecard) and unit-tested; researchScorecards loads the theories and their latest exploration.
import { collection } from './db.js';
import { theories } from './theories.js';

import { group, scorecard, scorecards, type IdeaRow } from './scorecard.js';
export { scorecard, scorecards, type IdeaRow } from './scorecard.js';

/** The ideas of a workspace with who proposed them and their latest exploration. */
export async function ideaRows(ownerId: string): Promise<IdeaRow[]> {
  const ts = await theories()
    .find(
      { ownerId },
      { projection: { status: 1, family: 1, history: 1, createdAt: 1, codeAttempts: 1, tags: 1 } },
    )
    .toArray();
  const evals = await collection<any>('evaluations')
    .find(
      { ownerId, mode: 'explore', status: 'succeeded', theoryId: { $in: ts.map((t) => t._id) } },
      {
        projection: {
          theoryId: 1,
          createdAt: 1,
          'record.summary.sharpe': 1,
          'record.excess.spx.excess_cagr': 1,
        },
      },
    )
    .sort({ createdAt: 1 })
    .toArray();
  const latest = new Map<string, any>();
  for (const e of evals) latest.set(e.theoryId, e);
  return ts.map((t: any) => {
    const created = (t.history ?? []).find((h: any) => h.type === 'create');
    const e = latest.get(t._id);
    return {
      model: created?.actor?.model ?? 'unknown',
      ...(created?.actor?.agentId ? { agentId: created.actor.agentId } : {}),
      family: t.family || 'unknown',
      mode: String((t.tags ?? []).find((x: string) => String(x).startsWith('mode:')) ?? 'mode:single').slice(
        5,
      ),
      status: t.status,
      createdAt: new Date(t.createdAt),
      approved: (t.history ?? []).some((h: any) => h.type === 'transition' && h.to === 'approved_for_code'),
      evaluated: !!e,
      codeAttempts: t.codeAttempts ?? 0,
      sharpe: e?.record?.summary?.sharpe ?? null,
      excess: e?.record?.excess?.spx?.excess_cagr ?? null,
    };
  });
}
export async function researchScorecards(ownerId: string) {
  return scorecards(await ideaRows(ownerId));
}
/** A Theorist's own record (by its agent id, else its model), for its brief. */
export async function ownRecord(ownerId: string, who: { agentId?: string; model?: string }) {
  const rows = await ideaRows(ownerId);
  // By agent id; an agent rebuilt with a new id (or none) falls back to its model's record.
  let mine = who.agentId ? rows.filter((r) => r.agentId === who.agentId) : [];
  if (!mine.length && who.model) mine = rows.filter((r) => r.model === who.model);
  if (!mine.length) return undefined;
  return { ...scorecard('you', mine), byFamily: group(mine, (r) => r.family).slice(0, 8) };
}
