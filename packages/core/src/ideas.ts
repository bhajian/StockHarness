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
async function ideaEvaluationDocs(t: Theory) {
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
  [...t.history].reverse().find((h) => h.type === 'transition' && h.data && 'gatesVersion' in h.data);

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
  const judge = [...t.history].reverse().find((h) => h.actor.role === 'judge' && h.type === 'transition');
  const models: Record<string, string[]> = {};
  for (const h of t.history)
    if (h.actor.model) models[h.actor.role] = [...new Set([...(models[h.actor.role] ?? []), h.actor.model])];
  const { history, ...rest } = t;
  return {
    ...row(t, evals),
    theory: { ...rest, id: t._id },
    models,
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
    park: s === 'successful' || s === 'approved',
    reject: s === 'successful' || s === 'approved',
    sendBack: ['successful', 'approved', 'failed', 'parked', 'rejected_untestable', 'post_review'].includes(
      s,
    ),
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
  return (await ideaEvaluationDocs(t)).map(summaryOf);
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
/** Numbers in a text, each with the evaluation it comes from (or null: unsourced). */
export function sourceNumbers(text: string, values: { value: number; evaluationId: string }[]) {
  const chips: { text: string; value: number; evaluationId: string | null }[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const raw = m[0];
    const before = text.slice(Math.max(0, m.index! - 2), m.index!);
    if (/T-$|v$|#$/.test(before)) continue; // T-3, v2, #110
    const pctSign = raw.endsWith('%');
    const n = Number(raw.replace('%', '').replace(',', '.'));
    if (!Number.isFinite(n)) continue;
    if (!pctSign && Number.isInteger(n) && (Math.abs(n) < 10 || (n >= 1900 && n <= 2100))) continue; // counts, years
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
    chips.push({ text: raw, value: n, evaluationId: hit?.evaluationId ?? null });
  }
  return chips;
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
    ...(h.actor.model ? { model: h.actor.model } : {}),
    ...(h.actor.userId ? { userId: h.actor.userId } : {}),
    reasoning: h.reasoning,
    ...(h.data ? { data: h.data } : {}),
    // Agents' numbers are checked; people's comments and system links are not.
    numbers: h.actor.role === 'human' || h.type === 'link' ? [] : sourceNumbers(h.reasoning, values),
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
export type IdeaAction = 'approve' | 'park' | 'reject' | 'send_back';
export async function actOnIdea(
  ownerId: string,
  id: string,
  action: IdeaAction,
  comment: string,
  userId: string,
) {
  const t = await getTheory(ownerId, id);
  const to = ({ approve: 'approved', park: 'parked', reject: 'failed', send_back: 'revise' } as const)[
    action
  ];
  if (!to) throw new HttpError(400, 'action must be approve, park, reject or send_back');
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
