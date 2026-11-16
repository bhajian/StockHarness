// Scorecard formulas (#460), pure so they are unit-tested; researchKpis.ts loads the data.
export type IdeaRow = {
  model: string;
  agentId?: string;
  family: string;
  status: string;
  createdAt: Date;
  approved: boolean;
  evaluated: boolean;
  codeAttempts: number;
  sharpe?: number | null;
  excess?: number | null;
};
export type Scorecard = {
  key: string;
  proposed: number;
  approvedRate: number | null;
  evaluated: number;
  promising: number;
  successful: number;
  failed: number;
  rejected: number;
  /** Promising + successful per 100 proposals. */
  yieldPer100: number | null;
  medianSharpe: number | null;
  medianExcess: number | null;
  meanCodeAttempts: number | null;
};

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x: number | null, d = 4) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** One scorecard from the ideas in a group. */
export function scorecard(key: string, rows: IdeaRow[]): Scorecard {
  const n = rows.length;
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const promising = count('promising');
  const successful = count('successful') + count('approved');
  const nums = (f: (r: IdeaRow) => number | null | undefined) =>
    rows.map(f).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return {
    key,
    proposed: n,
    approvedRate: n ? round(rows.filter((r) => r.approved).length / n) : null,
    evaluated: rows.filter((r) => r.evaluated).length,
    promising,
    successful,
    failed: count('failed'),
    rejected: count('rejected_untestable'),
    yieldPer100: n ? round(((promising + successful) / n) * 100, 1) : null,
    medianSharpe: round(median(nums((r) => r.sharpe))),
    medianExcess: round(median(nums((r) => r.excess))),
    meanCodeAttempts: n ? round(rows.reduce((a, r) => a + r.codeAttempts, 0) / n, 2) : null,
  };
}
export const group = (rows: IdeaRow[], by: (r: IdeaRow) => string) => {
  const m = new Map<string, IdeaRow[]>();
  for (const r of rows) m.set(by(r), [...(m.get(by(r)) ?? []), r]);
  return [...m].map(([k, v]) => scorecard(k, v)).sort((a, b) => b.proposed - a.proposed);
};
/** Scorecards by model and by family, for all time and the last 90 and 30 days. */
export function scorecards(rows: IdeaRow[], now = new Date()) {
  const since = (days: number) =>
    rows.filter((r) => now.getTime() - r.createdAt.getTime() <= days * 86400000);
  const view = (rs: IdeaRow[]) => ({
    overall: scorecard('all', rs),
    byModel: group(rs, (r) => r.model),
    byFamily: group(rs, (r) => r.family),
  });
  return { all: view(rows), last90: view(since(90)), last30: view(since(30)) };
}
