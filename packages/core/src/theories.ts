// Theories (#110): the research loop's unit of work. A theory is a testable hypothesis with its signal logic in
// words; it moves through the lifecycle (theoryLifecycle.ts) and links to the plugin versions and evaluations it
// produced. Every transition is stored with its actor, model and reasoning: the debate the Ideas pages show (M5).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collection } from './db.js';
import { HttpError } from './security.js';
import {
  DEFAULT_CAPS,
  EDITABLE_STATES,
  THEORY_ROLES,
  THEORY_STATES,
  countsAfter,
  transitionProblem,
  type LifecycleCaps,
  type TheoryRole,
  type TheoryState,
} from './theoryLifecycle.js';

export const theoryContent = z.object({
  title: z.string().trim().min(3).max(200),
  hypothesis: z.string().trim().min(10).max(4000),
  rationale: z.string().trim().max(8000).default(''),
  /** Collections and fields the test needs (names from the Schema Catalog). */
  dataNeeded: z.array(z.string().trim().min(1).max(200)).max(40).default([]),
  universe: z.string().trim().max(1000).default('universe_daily (in_universe)'),
  /** The signal in words: what is ranked, how, and when. */
  signalLogic: z.string().trim().min(10).max(8000),
  horizonDays: z.number().int().min(1).max(1260).default(21),
  direction: z.enum(['long', 'short', 'long_short']).default('long'),
  /** What result would show the hypothesis is wrong. */
  falsification: z.string().trim().min(5).max(4000),
  family: z.string().trim().max(100).default('other'),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  /** For a near-duplicate of an earlier theory (#111): what is different. */
  differsFrom: z.string().trim().max(2000).optional(),
});
export type TheoryContent = z.infer<typeof theoryContent>;

export type TheoryActor = {
  role: TheoryRole;
  agentId?: string;
  userId?: string;
  /** Model that made the decision (provider name / model id), for the debate history. */
  model?: string;
  runId?: string;
};
export type TheoryEvent = {
  /** A transition, or `edit` when the Theorist changed the content in draft / revise. */
  type: 'create' | 'transition' | 'edit' | 'link';
  from?: TheoryState;
  to?: TheoryState;
  actor: TheoryActor;
  reasoning: string;
  data?: Record<string, unknown>;
  at: Date;
};
export type Theory = TheoryContent & {
  _id: string;
  ownerId: string;
  /** T-<number>, per workspace. */
  number: number;
  status: TheoryState;
  revisions: number;
  codeAttempts: number;
  /** Plugin and versions written for this theory (#112 submit_code). */
  plugin?: { name: string; versions: number[] };
  evaluationIds: string[];
  holdoutEvaluationId?: string;
  /** Evaluations run for this theory (counted in the workspace trials). */
  trials: number;
  /** Depends on estimate / consensus snapshots: no backtest, paper tracking only (#113). */
  forwardOnly?: boolean;
  history: TheoryEvent[];
  createdAt: Date;
  updatedAt: Date;
};
export const theories = () => collection<Theory>('theories');
const counters = () => collection<{ _id: string; n: number }>('theory_counters');
const settings = () =>
  collection<{ _id: string; maxRevisions?: number; maxCodeAttempts?: number }>('research_settings');

export const actorSchema = z.object({
  role: z.enum(THEORY_ROLES),
  agentId: z.string().max(100).optional(),
  userId: z.string().max(100).optional(),
  model: z.string().max(200).optional(),
  runId: z.string().max(100).optional(),
});

/** The workspace's lifecycle caps (research settings, #116), else the defaults. */
export async function lifecycleCaps(ownerId: string): Promise<LifecycleCaps> {
  const s = await settings().findOne({ _id: ownerId });
  return {
    maxRevisions: s?.maxRevisions ?? DEFAULT_CAPS.maxRevisions,
    maxCodeAttempts: s?.maxCodeAttempts ?? DEFAULT_CAPS.maxCodeAttempts,
  };
}

const ref = (t: Pick<Theory, 'number'>) => `T-${t.number}`;
/** A theory by id or by T-<number>. */
export async function getTheory(ownerId: string, idOrRef: string) {
  const m = /^T-(\d+)$/i.exec(idOrRef.trim());
  const t = await theories().findOne(m ? { ownerId, number: Number(m[1]) } : { ownerId, _id: idOrRef });
  if (!t) throw new HttpError(404, `No theory ${idOrRef}`);
  return t;
}

export async function createTheory(
  ownerId: string,
  input: unknown,
  actor: TheoryActor,
  opts: { reasoning?: string; submit?: boolean } = {},
) {
  const content = theoryContent.parse(input);
  if (!['theorist', 'human'].includes(actor.role))
    throw new HttpError(403, 'Only the Theorist (or a human) creates theories');
  const n = await counters().findOneAndUpdate(
    { _id: ownerId },
    { $inc: { n: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  const now = new Date();
  const doc: Theory = {
    ...content,
    _id: randomUUID(),
    ownerId,
    number: n!.n,
    status: 'draft',
    revisions: 0,
    codeAttempts: 0,
    evaluationIds: [],
    trials: 0,
    history: [{ type: 'create', to: 'draft', actor, reasoning: opts.reasoning ?? '', at: now }],
    createdAt: now,
    updatedAt: now,
  };
  await theories().insertOne(doc);
  return opts.submit
    ? transitionTheory(ownerId, doc._id, 'pre_review', actor, opts.reasoning ?? 'Submitted')
    : doc;
}

/** The Theorist edits the content while the theory is a draft or being revised. */
export async function editTheory(
  ownerId: string,
  id: string,
  patch: unknown,
  actor: TheoryActor,
  reasoning = '',
) {
  const t = await getTheory(ownerId, id);
  if (!EDITABLE_STATES.includes(t.status))
    throw new HttpError(
      409,
      `${ref(t)} is ${t.status}; its content can change only in ${EDITABLE_STATES.join(' or ')}`,
    );
  if (!['theorist', 'human'].includes(actor.role))
    throw new HttpError(403, 'Only the Theorist edits a theory');
  const {
    _id,
    ownerId: _o,
    number,
    status,
    revisions,
    codeAttempts,
    plugin,
    evaluationIds,
    trials,
    history,
    createdAt,
    updatedAt,
    holdoutEvaluationId,
    forwardOnly,
    ...current
  } = t;
  const next = theoryContent.parse({ ...current, ...(patch as object) });
  const changed = Object.keys(next).filter(
    (k) => JSON.stringify((next as any)[k]) !== JSON.stringify((current as any)[k]),
  );
  if (!changed.length) return t;
  const r = await theories().findOneAndUpdate(
    { _id: t._id, ownerId, status: t.status, updatedAt: t.updatedAt },
    {
      $set: { ...next, updatedAt: new Date() },
      $push: { history: { type: 'edit', actor, reasoning, data: { fields: changed }, at: new Date() } },
    },
    { returnDocument: 'after' },
  );
  if (!r) throw new HttpError(409, `${ref(t)} changed meanwhile; read it again`);
  return r;
}

/**
 * Move a theory to `to`. Only legal transitions by the right role, within the caps; the update is conditional on
 * the status read, so two agents cannot both move the same theory.
 */
export async function transitionTheory(
  ownerId: string,
  id: string,
  to: TheoryState,
  actor: TheoryActor,
  reasoning: string,
  data?: Record<string, unknown>,
) {
  if (!THEORY_STATES.includes(to)) throw new HttpError(400, `Unknown state ${to}`);
  if (!reasoning?.trim() && actor.role !== 'evaluator')
    throw new HttpError(400, 'Every decision needs its reasoning');
  const t = await getTheory(ownerId, id);
  const caps = await lifecycleCaps(ownerId);
  const problem = transitionProblem(t.status, to, actor.role, t, caps);
  if (problem) throw new HttpError(409, `${ref(t)}: ${problem}`);
  const counts = countsAfter(t.status, to, t);
  const r = await theories().findOneAndUpdate(
    { _id: t._id, ownerId, status: t.status },
    {
      $set: { status: to, ...counts, updatedAt: new Date() },
      $push: {
        history: {
          type: 'transition',
          from: t.status,
          to,
          actor,
          reasoning: reasoning.slice(0, 20000),
          ...(data ? { data } : {}),
          at: new Date(),
        },
      },
    },
    { returnDocument: 'after' },
  );
  if (!r) throw new HttpError(409, `${ref(t)} moved meanwhile (it was ${t.status}); read it again`);
  return r;
}

/** Record a plugin version or an evaluation produced for the theory. */
export async function linkTheory(
  ownerId: string,
  id: string,
  link: { pluginName?: string; pluginVersion?: number; evaluationId?: string; holdoutEvaluationId?: string },
  actor: TheoryActor,
) {
  const t = await getTheory(ownerId, id);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const addToSet: Record<string, unknown> = {};
  const inc: Record<string, number> = {};
  if (link.pluginName) {
    if (t.plugin && t.plugin.name !== link.pluginName)
      throw new HttpError(409, `${ref(t)} already has the plugin ${t.plugin.name}`);
    set['plugin.name'] = link.pluginName;
    if (link.pluginVersion) addToSet['plugin.versions'] = link.pluginVersion;
  }
  if (link.evaluationId && !t.evaluationIds.includes(link.evaluationId)) {
    addToSet.evaluationIds = link.evaluationId;
    inc.trials = 1;
  }
  if (link.holdoutEvaluationId) {
    set.holdoutEvaluationId = link.holdoutEvaluationId;
    if (!t.holdoutEvaluationId) inc.trials = (inc.trials ?? 0) + 1;
  }
  await theories().updateOne({ _id: t._id, ownerId }, {
    $set: set,
    ...(Object.keys(addToSet).length ? { $addToSet: addToSet } : {}),
    ...(Object.keys(inc).length ? { $inc: inc } : {}),
    $push: { history: { type: 'link', actor, reasoning: '', data: link, at: new Date() } },
  } as Record<string, unknown>);
  return getTheory(ownerId, t._id);
}

export async function listTheories(ownerId: string, filter: { status?: string; family?: string } = {}) {
  return theories()
    .find(
      {
        ownerId,
        ...(filter.status ? { status: filter.status as TheoryState } : {}),
        ...(filter.family ? { family: filter.family } : {}),
      },
      { projection: { history: 0 } },
    )
    .sort({ number: -1 })
    .limit(500)
    .toArray();
}

// --- YAML (kind Theory): the record with its debate, links and trial count ------------------------------------
/** Fixed key order, so an export never depends on the order fields were added to the document. */
const SPEC_KEYS = [
  'title',
  'hypothesis',
  'rationale',
  'dataNeeded',
  'universe',
  'signalLogic',
  'horizonDays',
  'direction',
  'falsification',
  'family',
  'tags',
  'differsFrom',
  'number',
  'status',
  'revisions',
  'codeAttempts',
  'plugin',
  'evaluationIds',
  'holdoutEvaluationId',
  'trials',
  'forwardOnly',
] as const;
export function theorySpec(t: Theory) {
  const spec: Record<string, unknown> = {};
  for (const k of SPEC_KEYS) if ((t as any)[k] !== undefined) spec[k] = (t as any)[k];
  if (t.plugin) spec.plugin = { name: t.plugin.name, versions: t.plugin.versions };
  spec.history = t.history.map((h) => ({
    type: h.type,
    ...(h.from ? { from: h.from } : {}),
    ...(h.to ? { to: h.to } : {}),
    actor: Object.fromEntries(
      (['role', 'agentId', 'userId', 'model', 'runId'] as const)
        .filter((k) => h.actor[k] !== undefined)
        .map((k) => [k, h.actor[k]]),
    ),
    reasoning: h.reasoning,
    ...(h.data ? { data: h.data } : {}),
    at: h.at.toISOString(),
  }));
  spec.createdAt = t.createdAt.toISOString();
  spec.updatedAt = t.updatedAt.toISOString();
  return spec;
}
export const theorySpecSchema = theoryContent.extend({
  number: z.number().int().min(1),
  status: z.enum(THEORY_STATES),
  revisions: z.number().int().min(0),
  codeAttempts: z.number().int().min(0),
  plugin: z.object({ name: z.string(), versions: z.array(z.number().int()) }).optional(),
  evaluationIds: z.array(z.string()),
  holdoutEvaluationId: z.string().optional(),
  trials: z.number().int().min(0),
  forwardOnly: z.boolean().optional(),
  history: z.array(
    z.object({
      type: z.enum(['create', 'transition', 'edit', 'link']),
      from: z.enum(THEORY_STATES).optional(),
      to: z.enum(THEORY_STATES).optional(),
      actor: actorSchema,
      reasoning: z.string(),
      data: z.record(z.unknown()).optional(),
      at: z.string().datetime(),
    }),
  ),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** Insert an imported theory with its id; its trials are added to the workspace count (deflated Sharpe). */
export async function restoreTheory(ownerId: string, id: string, spec: z.infer<typeof theorySpecSchema>) {
  const taken = await theories().findOne({ ownerId, number: spec.number }, { projection: { _id: 1 } });
  if (taken) throw new HttpError(409, `T-${spec.number} already exists in this workspace`);
  const doc: Theory = {
    ...spec,
    _id: id,
    ownerId,
    history: spec.history.map((h) => ({ ...h, at: new Date(h.at) })) as TheoryEvent[],
    createdAt: new Date(spec.createdAt),
    updatedAt: new Date(spec.updatedAt),
  };
  await theories().insertOne(doc);
  // Keep numbering ahead of imported theories.
  await counters().updateOne({ _id: ownerId }, { $max: { n: spec.number } }, { upsert: true });
  if (spec.trials)
    await collection<{ _id: string; count: number }>('evaluation_trials').updateOne(
      { _id: ownerId },
      { $inc: { count: spec.trials } },
      { upsert: true },
    );
  return doc;
}
