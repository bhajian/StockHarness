// Ideas (#118): the human view of the research loop's theories. An idea is a theory with its evaluations, its debate,
// its code versions and the gates that decided it. List and filter them, open one, act on it (approve, park,
// reject, send back with a comment), reproduce an evaluation, compare a few.
import { profileOf, theoryProfileId } from './profiles.js';
import { HttpError } from './security.js';
import { downsample } from './series.js';
import { evaluations, getEvaluation, startEvaluation, type Evaluation } from './evaluations.js';
import { activeGates, evaluateGates, type GateResult } from './gates.js';
import { getTheory, theories, transitionTheory, type Theory, type TheoryEvent } from './theories.js';
import { listStrategyPluginVersions, strategyPlugins } from './strategyPlugins.js';
import { TERMINAL_STATES } from './theoryLifecycle.js';
import type { Filter } from 'mongodb';

const r4 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);
export const IN_PROGRESS = [
  'draft',
  'pre_review',
  'revise',
  'approved_for_code',
  'coding',
  'code_error',
  'evaluated',
  'post_review',
  'revise_code',
];

/** The evaluations that belong to an idea (its trials, the holdout, and reproductions), newest first. */
/**
 * The rebuild cutoff (owner, 2026-11-17): a rebuilding or rebuilt idea counts only what came after its rebuild began;
 * the earlier code, runs and verdict stay in its history (preserved, never shown as its current numbers).
 */
export const rebuildCutoff = (t: Pick<Theory, 'rebuild' | 'rebuiltAt'>) => {
  const at = t.rebuild?.at ?? t.rebuiltAt;
  return at ? new Date(at) : undefined;
};
const afterCutoff = (t: Theory, at: Date | string | undefined) => {
  const c = rebuildCutoff(t);
  return !c || (!!at && new Date(at) >= c);
};
/** The idea's evaluations; with `all`, the ones from before a rebuild too (marked superseded by the caller). */
async function ideaEvaluationDocs(t: Theory, opts: { all?: boolean } = {}) {
  const docs = await allIdeaEvaluationDocs(t);
  return opts.all ? docs : docs.filter((e) => afterCutoff(t, e.createdAt));
}
async function allIdeaEvaluationDocs(t: Theory) {
  const ids = [...t.evaluationIds, ...(t.holdoutEvaluationId ? [t.holdoutEvaluationId] : [])];
  // Records imported from another workspace keep their original ids as sourceId.
  const theoryIds = [
    t._id,
    ...((t as { sourceId?: string }).sourceId ? [(t as { sourceId?: string }).sourceId!] : []),
  ];
  return evaluations()
    .find({
      ownerId: t.ownerId,
      $or: [{ _id: { $in: ids } }, { sourceId: { $in: ids } }, { theoryId: { $in: theoryIds } }],
    } as Filter<Evaluation>)
    .sort({ createdAt: -1 })
    .toArray();
}
const latestExplore = (evals: Evaluation[]) =>
  evals.find((e) => e.status === 'succeeded' && e.mode === 'explore' && !e.reproduces);
const holdoutOf = (t: Theory, evals: Evaluation[]) => evals.find((e) => e._id === t.holdoutEvaluationId);

/** A small equity sparkline (about 40 points). */
function spark(record: Record<string, any> | undefined) {
  const eq: number[] = record?.series?.series?.equity ?? [];
  if (eq.length < 2) return [];
  const step = Math.max(1, Math.floor(eq.length / 40));
  return eq.filter((_, i) => i % step === 0 || i === eq.length - 1).map((v) => r4(v));
}
const lastVerdict = (t: Theory) =>
  [...t.history]
    .reverse()
    .find((h) => h.type === 'transition' && h.data && 'gatesVersion' in h.data && afterCutoff(t, h.at));

function row(t: Theory, evals: Evaluation[]) {
  const ex = latestExplore(evals)?.record;
  const ho = holdoutOf(t, evals);
  const verdict = lastVerdict(t);
  return {
    id: t._id,
    ref: `T-${t.number}`,
    title: t.title,
    status: t.status,
    family: t.family,
    side: t.direction,
    profile: theoryProfileId(t),
    profileLabel: profileOf(theoryProfileId(t)).label,
    horizonDays: t.horizonDays,
    dataNeeded: t.dataNeeded,
    forwardOnly: !!t.forwardOnly,
    trials: t.trials,
    revisions: t.revisions,
    // Rebuilding: new code and a fresh verdict on the corrected data are on the way; the old numbers are history.
    ...(t.rebuild ? { rebuilding: true } : {}),
    sharpe: r4(ex?.summary?.sharpe),
    deflatedSharpe: r4(ex?.trial_context?.dsr),
    excessPerYear: r4(ex?.excess?.spx?.excess_cagr),
    maxDrawdown: r4(ex?.summary?.max_drawdown),
    cagr: r4(ex?.summary?.cagr),
    holdout: ho
      ? {
          status: ho.status,
          sharpe: r4(ho.record?.summary?.sharpe),
          excess: r4(ho.record?.excess?.spx?.excess_cagr),
        }
      : null,
    gatesVersion: (verdict?.data as { gatesVersion?: number } | undefined)?.gatesVersion ?? null,
    spark: spark(ex),
    updatedAt: t.updatedAt,
    createdAt: t.createdAt,
  };
}
export type IdeaRow = ReturnType<typeof row>;

export type IdeaQuery = {
  status?: string; // comma list, or `in_progress`
  family?: string;
  side?: string;
  /** #323: a profile id (equity_long, options_covered_call, ...) or `options` for any options idea. */
  profile?: string;
  horizonMin?: number;
  horizonMax?: number;
  data?: string; // a collection or collection.field the idea uses
  gatesVersion?: number;
  q?: string;
  sort?: 'dsr' | 'sharpe' | 'recent' | 'excess';
  limit?: number;
  offset?: number;
};
export async function listIdeas(ownerId: string, q: IdeaQuery = {}) {
  const filter: Filter<Theory> = { ownerId };
  if (q.status) {
    const st = q.status.split(',').flatMap((s) => (s === 'in_progress' ? IN_PROGRESS : [s.trim()]));
    filter.status = { $in: st as Theory['status'][] };
  }
  if (q.family) filter.family = q.family;
  if (q.side) filter.direction = q.side as Theory['direction'];
  if (q.profile === 'options') filter.instrument = 'options';
  else if (q.profile?.startsWith('options_'))
    Object.assign(filter, { instrument: 'options', structure: q.profile.slice('options_'.length) });
  else if (q.profile?.startsWith('equity_'))
    Object.assign(filter, {
      instrument: { $ne: 'options' },
      direction:
        { equity_long: 'long', equity_short: 'short', equity_long_short: 'long_short' }[q.profile] ?? 'none',
    });
  if (q.horizonMin || q.horizonMax)
    filter.horizonDays = {
      ...(q.horizonMin ? { $gte: q.horizonMin } : {}),
      ...(q.horizonMax ? { $lte: q.horizonMax } : {}),
    };
  if (q.data) filter.dataNeeded = { $regex: `^${q.data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } as any;
  if (q.q?.trim()) {
    const re = { $regex: q.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filter.$or = [{ title: re }, { hypothesis: re }, { signalLogic: re }, { family: re }] as any;
    if (/^T-\d+$/i.test(q.q.trim())) filter.$or!.push({ number: Number(q.q.trim().slice(2)) } as any);
  }
  const docs = await theories().find(filter).sort({ number: -1 }).limit(2000).toArray();
  const allEvals = await evaluations()
    .find(
      { ownerId, theoryId: { $in: docs.map((d) => d._id) } },
      {
        projection: {
          'record.series.series.returns': 0,
          'record.series.series.spx_returns': 0,
          'record.series.series.drawdown': 0,
          'record.series.series.rolling_sharpe_126': 0,
          'record.series.series.gross': 0,
          'record.series.series.turnover': 0,
          'record.rebalances': 0,
        },
      },
    )
    .sort({ createdAt: -1 })
    .toArray();
  const byTheory = new Map<string, Evaluation[]>();
  for (const e of allEvals) byTheory.set(e.theoryId!, [...(byTheory.get(e.theoryId!) ?? []), e]);
  let rows = docs.map((t) => row(t, byTheory.get(t._id) ?? []));
  if (q.gatesVersion) rows = rows.filter((r) => r.gatesVersion === q.gatesVersion);
  const key = q.sort ?? 'dsr';
  const num = (v: number | null) => (v === null ? -Infinity : v);
  rows.sort((a, b) =>
    key === 'recent'
      ? +new Date(b.updatedAt) - +new Date(a.updatedAt)
      : key === 'sharpe'
        ? num(b.sharpe) - num(a.sharpe)
        : key === 'excess'
          ? num(b.excessPerYear) - num(a.excessPerYear)
          : num(b.deflatedSharpe) - num(a.deflatedSharpe) || num(b.sharpe) - num(a.sharpe),
  );
  const all = await theories()
    .find({ ownerId }, { projection: { status: 1, forwardOnly: 1 } })
    .toArray();
  const count = (f: (t: Pick<Theory, 'status' | 'forwardOnly'>) => boolean) => all.filter(f).length;
  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.min(1000, Math.max(1, q.limit ?? 200));
  return {
    kpis: {
      successful: count((t) => t.status === 'successful'),
      promising: count((t) => t.status === 'promising'),
      approved: count((t) => t.status === 'approved'),
      failed: count((t) => t.status === 'failed' || t.status === 'rejected_untestable'),
      inProgress: count((t) => IN_PROGRESS.includes(t.status)),
      forwardOnly: count((t) => !!t.forwardOnly),
      total: all.length,
    },
    total: rows.length,
    items: rows.slice(offset, offset + limit),
  };
}

/** One idea: the theory, the models used, the latest results, the gates and the Judge's summary. */
export async function getIdea(ownerId: string, id: string) {
  const t = await getTheory(ownerId, id);
  const evals = await ideaEvaluationDocs(t);
  const explore = latestExplore(evals);
  const holdout = holdoutOf(t, evals);
  const verdict = lastVerdict(t);
  const active = await activeGates(ownerId);
  const gates: { version: number; results: GateResult[]; mechanical?: string; final: boolean } = verdict
    ? {
        version: (verdict.data as any).gatesVersion,
        results: (verdict.data as any).gates ?? [],
        mechanical: (verdict.data as any).mechanical,
        final: true,
      }
    : {
        version: active.version,
        results: evaluateGates(
          active.gates,
          explore?.record,
          holdout?.status === 'succeeded' ? holdout.record : undefined,
        ),
        final: false,
      };
  const judge = [...t.history]
    .reverse()
    .find((h) => h.actor.role === 'judge' && h.type === 'transition' && afterCutoff(t, h.at));
  const models: Record<string, string[]> = {};
  for (const h of t.history)
    if (h.actor.model) models[h.actor.role] = [...new Set([...(models[h.actor.role] ?? []), h.actor.model])];
  const { history, ...rest } = t;
  // #413: which Theorist proposed the idea, and with which model.
  const created = t.history.find((h) => h.type === 'create');
  return {
    ...row(t, evals),
    theory: { ...rest, id: t._id },
    models,
    proposedBy: created
      ? {
          agent: agentLabel(created.actor.nodeId) ?? ROLE_NAMES[created.actor.role] ?? created.actor.role,
          ...(created.actor.model ? { model: created.actor.model } : {}),
        }
      : null,
    gates,
    judgeSummary: judge
      ? { at: judge.at, to: judge.to, reasoning: judge.reasoning, model: judge.actor.model }
      : null,
    explore: explore ? summaryOf(explore) : null,
    holdoutEvaluation: holdout ? summaryOf(holdout) : null,
    comments: t.history
      .filter((h) => h.type === 'comment')
      .map((h) => ({ at: h.at, by: h.actor.userId, text: h.reasoning })),
    actions: humanActions(t),
  };
}
/** What a person can do with the idea now. */
export function humanActions(t: Pick<Theory, 'status'>) {
  const s = t.status;
  return {
    approve: s === 'successful',
    park:
      s === 'successful' ||
      s === 'approved' ||
      s === 'promising' ||
      [
        'pre_review',
        'revise',
        'approved_for_code',
        'coding',
        'code_error',
        'post_review',
        'revise_code',
      ].includes(s),
    resume: s === 'parked',
    rebuild: REBUILDABLE.includes(s),
    reject: s === 'successful' || s === 'approved' || s === 'promising',
    sendBack: [
      'successful',
      'promising',
      'approved',
      'failed',
      'parked',
      'rejected_untestable',
      'post_review',
    ].includes(s),
  };
}
function summaryOf(e: Evaluation) {
  const r = e.record;
  return {
    id: e._id,
    mode: e.mode,
    status: e.status,
    pluginVersion: e.pluginVersion,
    codeHash: e.codeHash,
    trial: e.trial,
    params: e.params,
    createdAt: e.createdAt,
    durationMs: e.durationMs,
    ...(e.error ? { error: e.error } : {}),
    ...(e.reproduces ? { reproduces: e.reproduces } : {}),
    ...(r
      ? {
          evaluatorVersion: r.evaluator_version,
          dataSnapshot: r.data_snapshot,
          recordHash: r.record_hash,
          summary: r.summary,
          excess: r.excess,
          factors: {
            alpha_t: r.factors?.alpha_t,
            alpha_annual: r.factors?.alpha_annual,
            betas: r.factors?.betas,
            t: r.factors?.t,
          },
          deflatedSharpe: r.trial_context?.dsr,
          folds: r.folds,
          warnings: r.warnings,
        }
      : {}),
  };
}
export async function ideaEvaluations(ownerId: string, id: string) {
  const t = await getTheory(ownerId, id);
  // Every run, the ones before a rebuild marked superseded (kept as history).
  return (await ideaEvaluationDocs(t, { all: true })).map((e) => ({
    ...summaryOf(e),
    ...(afterCutoff(t, e.createdAt) ? {} : { superseded: true }),
  }));
}

// --- the debate, with cited numbers checked against the idea's evaluations (#121) ---------------------------
const NUMBER = /(?<![\w.-])[-+]?\d+(?:[.,]\d+)?%?(?!\w|[.,]\d)/g;
function metricValues(evals: Evaluation[]) {
  const out: { value: number; evaluationId: string }[] = [];
  const walk = (v: unknown, id: string) => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ value: v, evaluationId: id });
    else if (v && typeof v === 'object' && !Array.isArray(v)) Object.values(v).forEach((x) => walk(x, id));
    else if (Array.isArray(v) && v.length <= 50) v.forEach((x) => walk(x, id));
  };
  for (const e of evals) {
    const r = e.record;
    if (!r) continue;
    walk(
      {
        summary: r.summary,
        excess: r.excess,
        factors: r.factors,
        trial: r.trial_context,
        folds: r.folds,
        by_regime: r.by_regime,
      },
      e._id,
    );
  }
  return out;
}
/** #279: a unit after the number makes it a design parameter (252-day, 3 names, 10 bps), not a result. */
const PARAM_AFTER =
  /^\s*-?\s*(?:trading\s+)?(?:days?|sessions?|weeks?|months?|quarters?|years?|yrs?|names?|stocks?|securities|holdings|positions|bps|basis\s+points?)\b/i;
/** #279: so does a parameter phrase before it (top 20%, lookback of 63, every 21, rebalance 5). */
const PARAM_BEFORE =
  /\b(?:top|bottom|lookback(?:\s+of)?|window(?:\s+of)?|every|rebalance(?:d)?(?:\s+every)?|hold(?:ing)?(?:\s+for)?|first|last|past|decile|quintile|percentile)\s*$/i;
export type NumberChip = {
  text: string;
  value: number;
  evaluationId: string | null;
  /** #279: sourced (links its evaluation), unsourced (matches none) or parameter (a design choice, not checked). */
  kind: 'sourced' | 'unsourced' | 'parameter';
};
/**
 * Numbers in a text, each with the evaluation it comes from. Design parameters are neutral; with `claims: false` (a
 * Theorist's proposal, or an idea with no evaluation yet) a number that matches nothing is neutral too (#279).
 */
export function sourceNumbers(
  text: string,
  values: { value: number; evaluationId: string }[],
  opts: { claims?: boolean } = {},
) {
  const claims = opts.claims ?? true;
  const chips: NumberChip[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const raw = m[0];
    const before = text.slice(Math.max(0, m.index! - 2), m.index!);
    if (/T-$|v$|#$/.test(before)) continue; // T-3, v2, #110
    const pctSign = raw.endsWith('%');
    const n = Number(raw.replace('%', '').replace(',', '.'));
    if (!Number.isFinite(n)) continue;
    if (!pctSign && Number.isInteger(n) && (Math.abs(n) < 10 || (n >= 1900 && n <= 2100))) continue; // counts, years
    const after = text.slice(m.index! + raw.length, m.index! + raw.length + 24);
    const lead = text.slice(Math.max(0, m.index! - 24), m.index!);
    if (PARAM_AFTER.test(after) || PARAM_BEFORE.test(lead)) {
      chips.push({ text: raw, value: n, evaluationId: null, kind: 'parameter' });
      continue;
    }
    const decimals = (raw.replace('%', '').split(/[.,]/)[1] ?? '').length;
    const tol = 0.5 * 10 ** -Math.max(decimals, 0) + 1e-9;
    const candidates = pctSign ? [n / 100, n] : [n, n / 100];
    const hit = values.find((v) =>
      candidates.some(
        (c) =>
          Math.abs(v.value - c) <= (c === n / 100 ? tol / 100 : tol) ||
          Math.abs(v.value * (pctSign ? 100 : 1) - n) <= tol,
      ),
    );
    const evaluationId = hit?.evaluationId ?? null;
    chips.push({
      text: raw,
      value: n,
      evaluationId,
      kind: evaluationId ? 'sourced' : claims ? 'unsourced' : 'parameter',
    });
  }
  return chips;
}
const ROLE_NAMES: Record<string, string> = {
  theorist: 'Theorist',
  judge: 'Judge',
  coder: 'Coder',
  human: 'Person',
};
/** The harness step as a name: theorist_2 → "Theorist 2" (#413); other steps are named by their role. */
export function agentLabel(nodeId?: string) {
  const m = /^theorist_(\d+)$/.exec(nodeId ?? '');
  return m ? `Theorist ${m[1]}` : undefined;
}
export async function ideaDebate(ownerId: string, id: string) {
  const t = await getTheory(ownerId, id);
  const values = metricValues(await ideaEvaluationDocs(t));
  return t.history.map((h: TheoryEvent, i) => ({
    i,
    at: h.at,
    type: h.type,
    ...(h.from ? { from: h.from } : {}),
    ...(h.to ? { to: h.to } : {}),
    role: h.actor.role,
    ...(agentLabel(h.actor.nodeId) ? { agent: agentLabel(h.actor.nodeId) } : {}),
    ...(h.actor.model ? { model: h.actor.model } : {}),
    ...(h.actor.userId ? { userId: h.actor.userId } : {}),
    reasoning: h.reasoning,
    ...(h.data ? { data: h.data } : {}),
    // Agents' numbers are checked; people's comments and system links are not. A Theorist proposes (its numbers are
    // design choices), and before any evaluation nothing can be cited: their unmatched numbers are neutral (#279).
    numbers:
      h.actor.role === 'human' || h.type === 'link'
        ? []
        : sourceNumbers(h.reasoning, values, { claims: h.actor.role !== 'theorist' && values.length > 0 }),
  }));
}

/** Every code version (test outcome, error, note), the selected version's code and the one before it, for the diff. */
export async function ideaCode(ownerId: string, id: string, version?: number) {
  const t = await getTheory(ownerId, id);
  if (!t.plugin) return { plugin: null, versions: [], selected: null, previous: null };
  const p = await strategyPlugins().findOne({ ownerId, name: t.plugin.name });
  const versions = p ? await listStrategyPluginVersions(ownerId, p._id) : [];
  const evals = await ideaEvaluationDocs(t);
  const pick = version ?? versions[0]?.version;
  const at = (v?: number) => versions.find((x) => x.version === v);
  const view = (v?: (typeof versions)[number]) =>
    v
      ? {
          version: v.version,
          hash: v.hash,
          code: v.code,
          note: v.note,
          error: v.error,
          tested: (v as { tested?: string }).tested ?? null,
          createdAt: v.createdAt,
          evaluations: evals
            .filter((e) => e.pluginVersion === v.version)
            .map((e) => ({
              id: e._id,
              mode: e.mode,
              status: e.status,
              evaluatorVersion: e.record?.evaluator_version,
            })),
        }
      : null;
  return {
    plugin: { name: t.plugin.name, current: p?.version },
    versions: versions.map((v) => ({
      version: v.version,
      hash: v.hash,
      note: v.note,
      error: v.error,
      tested: (v as { tested?: string }).tested ?? null,
      createdAt: v.createdAt,
    })),
    selected: view(at(pick)),
    previous: view(at(versions.filter((v) => pick !== undefined && v.version < pick)[0]?.version)),
  };
}

// --- people act on ideas (#122) -------------------------------------------------------------------------------
export type IdeaAction = 'approve' | 'park' | 'reject' | 'send_back' | 'resume' | 'rebuild';
export async function actOnIdea(
  ownerId: string,
  id: string,
  action: IdeaAction,
  comment: string,
  userId: string,
) {
  const t = await getTheory(ownerId, id);
  const to = (
    {
      approve: 'approved',
      park: 'parked',
      reject: 'failed',
      send_back: 'revise',
      resume: 'approved_for_code', // #379: a parked idea back in the Coder's queue
      rebuild: 'approved_for_code', // a judged idea's code is written again and re-evaluated
    } as const
  )[action];
  if (!to) throw new HttpError(400, 'action must be approve, park, reject, send_back, resume or rebuild');
  if (action === 'rebuild') return rebuildIdea(ownerId, t, comment, userId);
  const text = comment.trim();
  if ((action === 'send_back' || action === 'reject') && text.length < 5)
    throw new HttpError(
      400,
      action === 'send_back' ? 'Say what the Theorist should change' : 'Say why the idea is rejected',
    );
  const moved = await transitionTheory(
    ownerId,
    t._id,
    to,
    { role: 'human', userId },
    text || `${action} by a person`,
    {
      action,
    },
  );
  return getIdea(ownerId, moved._id);
}
const REBUILDABLE = ['failed', 'promising', 'successful', 'approved'];
/**
 * Rebuild a judged idea (owner, 2026-11-17): back in the Coder's queue with fresh code attempts; its new evaluation
 * keeps the trial number of its last exploration (a re-test of the same hypothesis on corrected data, not a new
 * trial), and the Judge gives a fresh verdict. The old code and verdict stay in the history.
 */
export async function rebuildIdea(ownerId: string, t: Theory, comment: string, userId: string) {
  if (!REBUILDABLE.includes(t.status))
    throw new HttpError(
      409,
      `T-${t.number} is ${t.status}: only a failed, promising or successful idea is rebuilt`,
    );
  const last = await evaluations()
    .find({ ownerId, theoryId: t._id, mode: 'explore', status: 'succeeded' }, { projection: { trial: 1 } })
    .sort({ createdAt: -1 })
    .limit(1)
    .next();
  const moved = await transitionTheory(
    ownerId,
    t._id,
    'approved_for_code',
    { role: 'human', userId },
    comment.trim() || 'Rebuild: write the code again and re-evaluate on the corrected data',
    { action: 'rebuild', from: t.status, ...(last?.trial ? { trial: last.trial } : {}) },
  );
  await theories().updateOne(
    { _id: moved._id, ownerId },
    {
      $set: {
        codeAttempts: 0,
        rebuild: { ...(last?.trial ? { trial: last.trial } : {}), from: t.status, at: new Date() },
      },
    },
  );
  return getIdea(ownerId, moved._id);
}
/** Rebuild every judged idea that has code (failed, promising, successful or approved). */
export async function rebuildAllIdeas(ownerId: string, userId: string, comment = '') {
  const rows = await theories()
    .find(
      { ownerId, status: { $in: REBUILDABLE as any }, 'plugin.name': { $exists: true } },
      { projection: { number: 1 } },
    )
    .sort({ number: 1 })
    .toArray();
  const done: string[] = [];
  for (const r of rows) {
    const t = await getTheory(ownerId, r._id);
    await rebuildIdea(ownerId, t, comment, userId);
    done.push(`T-${t.number}`);
  }
  return { rebuilt: done };
}
export async function commentOnIdea(ownerId: string, id: string, text: string, userId: string) {
  const t = await getTheory(ownerId, id);
  const body = text.trim();
  if (body.length < 2) throw new HttpError(400, 'Write the comment');
  await theories().updateOne(
    { _id: t._id, ownerId },
    {
      $push: {
        history: {
          type: 'comment',
          actor: { role: 'human', userId },
          reasoning: body.slice(0, 8000),
          at: new Date(),
        },
      },
      $set: { updatedAt: new Date() },
    },
  );
  return getIdea(ownerId, t._id);
}

/** Re-run an evaluation (same plugin version and params; not a new trial) and compare the records. */
export async function reproduceIdea(
  ownerId: string,
  id: string,
  evaluationId?: string,
  userId?: string,
  waitSeconds = 50,
) {
  const t = await getTheory(ownerId, id);
  const evals = await ideaEvaluationDocs(t);
  const original = evaluationId ? evals.find((e) => e._id === evaluationId) : latestExplore(evals);
  if (!original) throw new HttpError(404, 'No evaluation of this idea to reproduce');
  if (original.mode === 'holdout')
    throw new HttpError(400, 'The holdout is one shot; reproduce an exploration evaluation');
  if (original.status !== 'succeeded')
    throw new HttpError(400, 'Only a finished evaluation can be reproduced');
  const { evaluation, done } = await startEvaluation(
    ownerId,
    {
      plugin: original.pluginName,
      version: original.pluginVersion,
      theoryId: t._id,
      params: original.params,
    },
    { userId, reproduces: original },
  );
  const finished = await Promise.race([
    done.catch(() => undefined),
    new Promise<undefined>((r) => void setTimeout(r, waitSeconds * 1000)),
  ]);
  const e = finished ?? (await getEvaluation(ownerId, evaluation._id));
  return { original: original._id, reproduction: summaryOf(e) };
}

/** 2–4 ideas side by side: equity overlay, metrics, return correlation, holdings overlap (#123). */
export async function compareIdeas(ownerId: string, ids: string[]) {
  if (ids.length < 2 || ids.length > 4) throw new HttpError(400, 'Compare 2 to 4 ideas');
  const items = [];
  for (const id of ids) {
    const t = await getTheory(ownerId, id);
    const e = latestExplore(await ideaEvaluationDocs(t));
    items.push({ t, e });
  }
  const dates = [...new Set(items.flatMap((x) => (x.e?.record?.series?.dates ?? []) as string[]))].sort();
  const seriesFor = (rec: Record<string, any> | undefined, key: string) => {
    const by = new Map<string, number | null>();
    (rec?.series?.dates ?? []).forEach((d: string, i: number) =>
      by.set(d, rec!.series.series[key]?.[i] ?? null),
    );
    return dates.map((d) => by.get(d) ?? null);
  };
  const equity = downsample(
    {
      dates,
      series: Object.fromEntries(items.map((x) => [`T-${x.t.number}`, seriesFor(x.e?.record, 'equity')])),
    },
    1500,
  );
  const returns = items.map((x) => seriesFor(x.e?.record, 'returns'));
  const corr = returns.map((a) =>
    returns.map((b) => {
      const pairs = a.map((v, i) => [v, b[i]] as const).filter(([x, y]) => x !== null && y !== null) as [
        number,
        number,
      ][];
      if (pairs.length < 3) return null;
      const mx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
      const my = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
      let sxy = 0,
        sxx = 0,
        syy = 0;
      for (const [x, y] of pairs) {
        sxy += (x - mx) * (y - my);
        sxx += (x - mx) ** 2;
        syy += (y - my) ** 2;
      }
      return sxx && syy ? r4(sxy / Math.sqrt(sxx * syy)) : null;
    }),
  );
  const holdings = items.map((x) => new Set(Object.keys(x.e?.record?.holdings?.weights ?? {})));
  const overlap = holdings.map((a) =>
    holdings.map((b) => {
      const common = [...a].filter((s) => b.has(s)).length;
      const base = Math.min(a.size, b.size);
      return base ? r4(common / base) : null;
    }),
  );
  return {
    ideas: items.map((x) => ({ ...row(x.t, x.e ? [x.e] : []), evaluationId: x.e?._id ?? null })),
    metrics: items.map((x) => ({
      ref: `T-${x.t.number}`,
      cagr: r4(x.e?.record?.summary?.cagr),
      sharpe: r4(x.e?.record?.summary?.sharpe),
      sortino: r4(x.e?.record?.summary?.sortino),
      maxDrawdown: r4(x.e?.record?.summary?.max_drawdown),
      deflatedSharpe: r4(x.e?.record?.trial_context?.dsr),
      excessPerYear: r4(x.e?.record?.excess?.spx?.excess_cagr),
      alphaT: r4(x.e?.record?.factors?.alpha_t),
      trades: x.e?.record?.summary?.trades ?? null,
      annualTurnover: r4(x.e?.record?.summary?.annual_turnover),
    })),
    equity,
    correlation: corr,
    holdingsOverlap: overlap,
  };
}
export const isTerminal = (s: Theory['status']) => TERMINAL_STATES.includes(s);

/** The object names an idea exports under (records imported from elsewhere keep their original names). */
export async function ideaExportNames(ownerId: string, id: string) {
  const t = await getTheory(ownerId, id);
  const evals = await ideaEvaluationDocs(t);
  return [
    (t as { sourceId?: string }).sourceId ?? t._id,
    ...(t.plugin ? [t.plugin.name] : []),
    ...evals.map((e) => (e as Evaluation & { sourceId?: string }).sourceId ?? e._id),
  ];
}
