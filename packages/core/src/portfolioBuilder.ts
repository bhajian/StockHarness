// Portfolio Builder (#461): combine ideas into one book by a written rule, with an audit of every pick. Pure, so it is
// unit-tested; the API loads promising and successful ideas' latest explorations and proposes a simulation over the
// exploration window (the holdout stays untouched; a simulation over it counts as trials, #450).

export type Candidate = {
  ref: string;
  title?: string;
  status: string;
  /** Holdout excess when there is one, else the exploration Sharpe. */
  score: number | null;
  scoreSource: 'holdout_excess' | 'explore_sharpe';
  returns: Map<string, number>; // date -> daily return
};
export type Rules = { maxIdeas: number; corrCap: number; minOverlapDays: number };
export const DEFAULT_RULES: Rules = { maxIdeas: 8, corrCap: 0.5, minOverlapDays: 252 };
export type AuditLine = { ref: string; decision: 'picked' | 'skipped'; reason: string };

export function correlation(a: Map<string, number>, b: Map<string, number>) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [d, x] of a) {
    const y = b.get(d);
    if (y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
      xs.push(x);
      ys.push(y);
    }
  }
  const n = xs.length;
  if (n < 3) return { r: null as number | null, n };
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return { r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : null, n };
}

/** Best score first; add an idea only when its correlation with every pick is at most corrCap. */
export function buildPortfolio(candidates: Candidate[], rules: Rules = DEFAULT_RULES) {
  const audit: AuditLine[] = [];
  const picked: Candidate[] = [];
  const ranked = [...candidates].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  for (const c of ranked) {
    if (c.score === null || !(c.score > 0)) {
      audit.push({
        ref: c.ref,
        decision: 'skipped',
        reason: `no positive ${c.scoreSource.replace('_', ' ')}`,
      });
      continue;
    }
    if (picked.length >= rules.maxIdeas) {
      audit.push({ ref: c.ref, decision: 'skipped', reason: `the book is full (${rules.maxIdeas} ideas)` });
      continue;
    }
    let reason = '';
    for (const p of picked) {
      const { r, n } = correlation(c.returns, p.returns);
      if (n < rules.minOverlapDays) {
        reason = `only ${n} days in common with ${p.ref} (needs ${rules.minOverlapDays})`;
        break;
      }
      if (r !== null && r > rules.corrCap) {
        reason = `correlation ${r.toFixed(2)} with ${p.ref} is above ${rules.corrCap}`;
        break;
      }
    }
    if (reason) {
      audit.push({ ref: c.ref, decision: 'skipped', reason });
      continue;
    }
    picked.push(c);
    audit.push({
      ref: c.ref,
      decision: 'picked',
      reason: `${c.scoreSource === 'holdout_excess' ? 'holdout excess' : 'exploration Sharpe'} ${c.score.toFixed(2)}${picked.length > 1 ? `, correlation ≤ ${rules.corrCap} with the others` : ', the best score'}`,
    });
  }
  return { picked: picked.map((p) => p.ref), audit, rules };
}
