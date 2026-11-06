// Research Lab (#116): what the research loop is doing, for the Research page. KPIs, the pipeline board, charts,
// the activity feed (the theories' debate as it happens), pause / resume, budget alerts.
import { collection } from './db.js';
import { theories, type Theory } from './theories.js';
import { trialCount } from './evaluations.js';
import { researchSettings } from './researchLoop.js';
import { budgetState } from './spendGuard.js';

export const BOARD_COLUMNS: { key: string; label: string; statuses: Theory['status'][] }[] = [
  { key: 'draft', label: 'Draft', statuses: ['draft', 'revise'] },
  { key: 'pre_review', label: 'Pre-review', statuses: ['pre_review'] },
  { key: 'coding', label: 'Coding', statuses: ['approved_for_code', 'coding', 'code_error', 'revise_code'] },
  { key: 'evaluating', label: 'Evaluating', statuses: ['evaluated'] },
  { key: 'post_review', label: 'Post-review', statuses: ['post_review'] },
];
const VERDICTS: Theory['status'][] = ['successful', 'failed', 'rejected_untestable', 'approved', 'parked'];
const IN_FLIGHT: Theory['status'][] = BOARD_COLUMNS.flatMap((c) => c.statuses).filter((s) => s !== 'draft');
/** Agent card ids in the research loop harness -> role. */
export const roleOfNode = (nodeId?: string) =>
  !nodeId
    ? 'other'
    : nodeId.startsWith('theorist')
      ? 'theorist'
      : nodeId.startsWith('judge')
        ? 'judge'
        : nodeId === 'coder'
          ? 'coder'
          : 'other';
const startOfDay = (d = new Date()) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const day = (d: Date) => d.toISOString().slice(0, 10);

/** The research loop harness of this workspace (by name). */
export async function researchHarness(ownerId: string, name = 'Research loop') {
  return collection<{
    _id: string;
    name: string;
    ownerId: string;
    schedule?: { enabled: boolean; everyMinutes: number };
  }>('workflows').findOne({ ownerId, name }, { projection: { name: 1, schedule: 1 } });
}

async function researchRunIds(ownerId: string, since: Date) {
  const h = await researchHarness(ownerId);
  if (!h) return [];
  const runs = await collection<{ _id: string }>('runs')
    .find({ ownerId, workflowId: h._id, createdAt: { $gte: since } } as Record<string, unknown>, {
      projection: { _id: 1 },
    })
    .toArray();
  return runs.map((r) => r._id);
}
/** Tokens by role since a date, from the per-call usage the runtime records. */
export async function tokensByRole(ownerId: string, since: Date) {
  const runIds = await researchRunIds(ownerId, since);
  const rows = runIds.length
    ? await collection<{ _id: string; nodeId?: string; input: number; output: number }>('model_usage')
        .find({ ownerId, runId: { $in: runIds }, at: { $gte: since } } as Record<string, unknown>)
        .toArray()
    : [];
  const out: Record<string, { input: number; output: number; calls: number }> = {};
  for (const r of rows) {
    const k = roleOfNode(r.nodeId);
    const cur = (out[k] ??= { input: 0, output: 0, calls: 0 });
    cur.input += r.input ?? 0;
    cur.output += r.output ?? 0;
    cur.calls++;
  }
  return out;
}

export async function researchStatus(ownerId: string) {
  const s = await researchSettings(ownerId);
  const h = await researchHarness(ownerId);
  const today = startOfDay();
  const all = await theories()
    .find({ ownerId }, { projection: { history: 0 } })
    .sort({ number: -1 })
    .limit(1000)
    .toArray();
  const decided = all.filter((t) => VERDICTS.includes(t.status) && t.status !== 'rejected_untestable');
  const successes = decided.filter((t) => t.status === 'successful' || t.status === 'approved').length;
  const tokens = await tokensByRole(ownerId, today);
  const tokensToday = Object.values(tokens).reduce((n, r) => n + r.input + r.output, 0);
  const spend = await budgetState(ownerId);
  const lastRun = h
    ? await collection<{ _id: string; status: string; createdAt: Date; finishedAt?: Date }>('runs')
        .find({ ownerId, workflowId: h._id } as Record<string, unknown>, {
          projection: { status: 1, createdAt: 1, finishedAt: 1 },
        })
        .sort({ createdAt: -1 })
        .limit(1)
        .next()
    : null;
  return {
    paused: !!s.paused,
    harness: h ? { id: h._id, name: h.name, schedule: h.schedule ?? null } : null,
    lastRun: lastRun
      ? {
          id: lastRun._id,
          status: lastRun.status,
          startedAt: lastRun.createdAt,
          finishedAt: lastRun.finishedAt,
        }
      : null,
    kpis: {
      theoriesToday: all.filter((t) => t.createdAt >= today).length,
      inFlight: all.filter((t) => IN_FLIGHT.includes(t.status)).length,
      successRate: decided.length ? successes / decided.length : null,
      decided: decided.length,
      trials: await trialCount(ownerId),
      tokensToday,
      // Priced per model (#297); usdPerMillionTokens only for models missing from the price table.
      costToday: Math.round(spend.today * 100) / 100,
    },
    spend,
    budgetAlert:
      s.budget?.dailyTokenAlert && tokensToday > s.budget.dailyTokenAlert
        ? `Today's tokens (${tokensToday.toLocaleString('en-US')}) passed the alert of ${s.budget.dailyTokenAlert.toLocaleString('en-US')}`
        : null,
    tokensByRole: tokens,
    board: {
      columns: BOARD_COLUMNS.map((c) => ({
        key: c.key,
        label: c.label,
        cards: all.filter((t) => c.statuses.includes(t.status)).map(card),
      })),
      verdictsToday: all.filter((t) => VERDICTS.includes(t.status) && t.updatedAt >= today).map(card),
    },
  };
}
const card = (t: Theory) => ({
  id: t._id,
  ref: `T-${t.number}`,
  title: t.title,
  status: t.status,
  family: t.family,
  revisions: t.revisions,
  codeAttempts: t.codeAttempts,
  trials: t.trials,
  ...(t.forwardOnly ? { forwardOnly: true } : {}),
  updatedAt: t.updatedAt,
});

/** Chart series for the last `days` days: verdicts per day, success rate, cumulative trials, tokens by role. */
export async function researchCharts(ownerId: string, days = 30) {
  const since = new Date(startOfDay().getTime() - (days - 1) * 86400_000);
  const dates = Array.from({ length: days }, (_, i) => day(new Date(since.getTime() + i * 86400_000)));
  const rows = await theories()
    .find({ ownerId, updatedAt: { $gte: since } }, { projection: { history: 1, status: 1 } })
    .toArray();
  const perDay: Record<string, Record<string, number>> = {};
  for (const t of rows)
    for (const h of t.history)
      if (h.type === 'transition' && h.to && VERDICTS.includes(h.to) && new Date(h.at) >= since) {
        const d = day(new Date(h.at));
        (perDay[d] ??= {})[h.to] = (perDay[d][h.to] ?? 0) + 1;
      }
  const series = (k: string) => dates.map((d) => perDay[d]?.[k] ?? 0);
  const successful = series('successful');
  const failed = series('failed');
  const evals = await collection<{ _id: string; createdAt: Date }>('evaluations')
    .find({ ownerId }, { projection: { createdAt: 1 } })
    .toArray();
  const before = evals.filter((e) => e.createdAt < since).length;
  let running = before;
  const cumulative = dates.map((d) => (running += evals.filter((e) => day(e.createdAt) === d).length));
  return {
    verdicts: {
      dates,
      series: { successful, failed, rejected: series('rejected_untestable') },
    },
    successRate: {
      dates,
      series: {
        'success rate': dates.map((_, i) =>
          successful[i] + failed[i] ? successful[i] / (successful[i] + failed[i]) : null,
        ),
      },
    },
    trials: { dates, series: { 'evaluations (cumulative)': cumulative } },
    tokensByRole: await tokensByRole(ownerId, since),
  };
}

export type ActivityItem = {
  at: string;
  theory: string;
  theoryId: string;
  title: string;
  type: string;
  from?: string;
  to?: string;
  role: string;
  model?: string;
  reasoning: string;
};
/** The debate as a feed: every theory event after `since`, oldest first. */
export async function researchActivity(ownerId: string, since: Date, limit = 200): Promise<ActivityItem[]> {
  const rows = await theories()
    .find({ ownerId, updatedAt: { $gt: since } }, { projection: { number: 1, title: 1, history: 1 } })
    .toArray();
  return rows
    .flatMap((t) =>
      t.history
        .filter((h) => new Date(h.at) > since)
        .map((h) => ({
          at: new Date(h.at).toISOString(),
          theory: `T-${t.number}`,
          theoryId: t._id,
          title: t.title,
          type: h.type,
          ...(h.from ? { from: h.from } : {}),
          ...(h.to ? { to: h.to } : {}),
          role: h.actor.role,
          ...(h.actor.model ? { model: h.actor.model } : {}),
          reasoning: h.reasoning.slice(0, 600),
        })),
    )
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-limit);
}
