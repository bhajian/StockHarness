// Portfolio Builder (#461): loads the candidates (promising and successful ideas with an exploration) and applies the
// rule in portfolioBuilder.ts. The proposal is a simulation over the exploration window, never the holdout.
import { collection } from './db.js';
import { theories } from './theories.js';
import { evaluationParams } from './researchLoop.js';
import { buildPortfolio, DEFAULT_RULES, type Candidate, type Rules } from './portfolioBuilder.js';

const ELIGIBLE = ['promising', 'successful', 'approved'];

export async function proposePortfolio(ownerId: string, rules: Partial<Rules> = {}) {
  const r: Rules = { ...DEFAULT_RULES, ...rules };
  const ts = await theories()
    .find(
      { ownerId, status: { $in: ELIGIBLE as any } },
      { projection: { number: 1, title: 1, status: 1, holdoutEvaluationId: 1 } },
    )
    .toArray();
  const candidates: Candidate[] = [];
  for (const t of ts as any[]) {
    const e = await collection<any>('evaluations')
      .find({ ownerId, theoryId: t._id, mode: 'explore', status: 'succeeded' }, { projection: { record: 1 } })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    if (!e?.record?.series) continue;
    const h = t.holdoutEvaluationId
      ? await collection<any>('evaluations').findOne(
          { ownerId, _id: t.holdoutEvaluationId, status: 'succeeded' },
          { projection: { 'record.excess.spx.excess_cagr': 1 } },
        )
      : null;
    const dates: string[] = e.record.series.dates ?? [];
    const rets: (number | null)[] = e.record.series.series?.returns ?? [];
    const returns = new Map<string, number>();
    dates.forEach((d, i) => typeof rets[i] === 'number' && returns.set(d, rets[i] as number));
    const holdoutExcess = h?.record?.excess?.spx?.excess_cagr;
    candidates.push({
      ref: `T-${t.number}`,
      title: t.title,
      status: t.status,
      score: typeof holdoutExcess === 'number' ? holdoutExcess : (e.record.summary?.sharpe ?? null),
      scoreSource: typeof holdoutExcess === 'number' ? 'holdout_excess' : 'explore_sharpe',
      returns,
    });
  }
  const built = buildPortfolio(candidates, r);
  const window = await evaluationParams(ownerId);
  return {
    ...built,
    candidates: candidates.map((c) => ({
      ref: c.ref,
      title: c.title,
      status: c.status,
      score: c.score,
      scoreSource: c.scoreSource,
    })),
    simulation: built.picked.length
      ? {
          name: `Portfolio of ${built.picked.length} ideas`,
          ideas: built.picked.map((idea) => ({ idea })),
          period: window ? { start: window.start, end: window.end } : undefined,
          allocation: 'risk_parity',
        }
      : null,
  };
}
