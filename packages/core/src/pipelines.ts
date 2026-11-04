// Pipelines (#156): one DAG across the layers (L1 syncs -> L2 transforms -> L3 research -> L5 live, plus
// harnesses and checks). A scheduled run covers one period; a node starts only when every upstream node of
// the same run succeeded and passed its gate. This file holds the definition (YAML kind `Pipeline`),
// validation, periods and the dependency-based suggestion; pipelineEngine.ts runs them.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collection } from './db.js';
import { HttpError } from './security.js';
import { scheduleSchema } from './schema.js';
import { catalogById } from './datasetCatalog.js';
import { datasetSyncs } from './datasetSync.js';
import { transforms } from './transforms.js';

export const NODE_TYPES = ['sync', 'transform', 'research', 'live', 'harness', 'check'] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export const PERIODS = ['day', 'week', 'month', 'event'] as const;
export type PeriodKind = (typeof PERIODS)[number];

export const gateSchema = z
  .object({
    /** Share of the sync's symbols that returned rows (0..1). */
    min_symbol_coverage: z.number().min(0).max(1).optional(),
    /** Rows written (or counted, for checks) at least this many. */
    min_rows: z.number().int().min(0).optional(),
    /** Rows may drop at most this % versus the same node in the previous period. */
    max_row_drop_pct: z.number().min(0).max(100).optional(),
    /** DQ issues per written row at most this (transforms). */
    max_dq_error_rate: z.number().min(0).max(1).optional(),
  })
  .strict();
export type Gate = z.infer<typeof gateSchema>;

export const pipelineNodeSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, 'Node ids: lowercase letters, digits and underscores'),
    /** `<type>:<name>`, e.g. `sync:L1 — EOD prices`, `transform:prices_daily`, `harness:Daily brief`. */
    ref: z
      .string()
      .min(3)
      .max(200)
      .regex(/^(sync|transform|research|live|harness|check):\S/, 'ref is <type>:<name>'),
    after: z.array(z.string().min(1).max(41)).max(50).default([]),
    gate: gateSchema.default({}),
    /** What an upstream failure does to this node: block it (default), skip it, or run it anyway. */
    on_upstream_failure: z.enum(['block', 'skip', 'continue_with_warning']).default('block'),
    params: z.record(z.unknown()).default({}),
    retries: z.number().int().min(0).max(5).default(1),
    timeout_minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(360),
  })
  .strict();
export type PipelineNode = z.infer<typeof pipelineNodeSchema>;

export const pipelineInputSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/, 'Lowercase letters, digits, dashes and underscores'),
    description: z.string().max(2000).default(''),
    schedule: scheduleSchema.optional(),
    /** The unit of one run. A run covers the period that contains the day before it starts. */
    period: z.enum(PERIODS).default('day'),
    /** Hours after a run starts by which it should be complete; past it an alert is raised. */
    deadline_hours: z
      .number()
      .min(1)
      .max(24 * 31)
      .optional(),
    nodes: z.array(pipelineNodeSchema).min(1).max(100),
    enabled: z.boolean().default(true),
  })
  .strict();
export type PipelineInput = z.infer<typeof pipelineInputSchema>;
export type Pipeline = PipelineInput & {
  _id: string;
  ownerId: string;
  version: number;
  nextRunAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  updatedBy?: string;
};
export const pipelines = () => collection<Pipeline>('pipelines');

export const refType = (ref: string) => ref.slice(0, ref.indexOf(':')) as NodeType;
export const refName = (ref: string) => ref.slice(ref.indexOf(':') + 1);

// --- Periods ---------------------------------------------------------------------------------------
export type Period = { kind: PeriodKind; id: string; start: string; end: string };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(`${s}T00:00:00Z`);
/** ISO week (Monday start): `2026-W45`. */
function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
/** The period of `kind` that contains `date` (YYYY-MM-DD). */
export function periodOf(kind: PeriodKind, date: string): Period {
  const d = utc(date);
  if (kind === 'day') return { kind, id: date, start: date, end: date };
  if (kind === 'week') {
    const monday = new Date(d.getTime() - ((d.getUTCDay() || 7) - 1) * 86400000);
    return { kind, id: isoWeek(d), start: iso(monday), end: iso(new Date(monday.getTime() + 6 * 86400000)) };
  }
  if (kind === 'month') {
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    return { kind, id: date.slice(0, 7), start: iso(start), end: iso(end) };
  }
  return { kind, id: `event-${date}`, start: date, end: date };
}
/** A run starting at `now` covers the period containing the previous day (Saturday's run -> that week). */
export function periodForRun(kind: PeriodKind, now = new Date()): Period {
  if (kind === 'event') {
    const d = iso(now);
    return { kind, id: `event-${now.toISOString().replace(/[:.]/g, '-')}`, start: d, end: d };
  }
  return periodOf(kind, iso(new Date(now.getTime() - 86400000)));
}
/** Parse a period id (`2026-11-03`, `2026-W45`, `2026-11`). */
export function parsePeriod(kind: PeriodKind, id: string): Period {
  if (kind === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(id)) return periodOf('day', id);
  if (kind === 'month' && /^\d{4}-\d{2}$/.test(id)) return periodOf('month', `${id}-01`);
  const w = /^(\d{4})-W(\d{2})$/.exec(id);
  if (kind === 'week' && w) {
    // Monday of ISO week 1 is the Monday of the week containing 4 January.
    const jan4 = new Date(Date.UTC(Number(w[1]), 0, 4));
    const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86400000);
    return periodOf('week', iso(new Date(monday.getTime() + (Number(w[2]) - 1) * 7 * 86400000)));
  }
  throw new HttpError(400, `Not a ${kind} period: ${id}`);
}
/** Periods from `from` to `to` inclusive, oldest first (backfills). */
export function periodRange(kind: PeriodKind, from: string, to: string, max = 400): Period[] {
  if (kind === 'event') throw new HttpError(400, 'Event pipelines have no periods to backfill');
  const out: Period[] = [];
  let p = parsePeriod(kind, from);
  const last = parsePeriod(kind, to);
  if (p.start > last.start) throw new HttpError(400, 'from must be on or before to');
  while (p.start <= last.start) {
    out.push(p);
    if (out.length > max) throw new HttpError(400, `At most ${max} periods per backfill`);
    p = periodOf(kind, iso(new Date(utc(p.end).getTime() + 86400000)));
  }
  return out;
}

// --- Validation ------------------------------------------------------------------------------------
/** Extra node types registered at runtime (e.g. research and live until Layers 3 and 5 exist; tests). */
export const extraNodeTypes = new Set<NodeType>();
export const BUILTIN_CHECKS = ['collection_rows'] as const;

export function pipelineCycle(nodes: Pick<PipelineNode, 'id' | 'after'>[]): string[] | undefined {
  const after = new Map(nodes.map((n) => [n.id, n.after]));
  const path: string[] = [];
  const done = new Set<string>();
  const visit = (id: string): string[] | undefined => {
    if (path.includes(id)) return [...path.slice(path.indexOf(id)), id];
    if (done.has(id)) return undefined;
    path.push(id);
    for (const u of after.get(id) ?? []) {
      const c = visit(u);
      if (c) return c;
    }
    path.pop();
    done.add(id);
    return undefined;
  };
  for (const n of nodes) {
    const c = visit(n.id);
    if (c) return c;
  }
  return undefined;
}
/** Node ids upstream of `id` (transitively). */
export function upstreamOf(nodes: Pick<PipelineNode, 'id' | 'after'>[], id: string) {
  const after = new Map(nodes.map((n) => [n.id, n.after]));
  const out = new Set<string>();
  const walk = (n: string) => {
    for (const u of after.get(n) ?? []) if (!out.has(u)) (out.add(u), walk(u));
  };
  walk(id);
  return out;
}
/** Node ids downstream of `id` (transitively). */
export function downstreamOf(nodes: Pick<PipelineNode, 'id' | 'after'>[], id: string) {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes)
      if (!out.has(n.id) && n.after.some((u) => u === id || out.has(u))) (out.add(n.id), (grew = true));
  }
  return out;
}

/** Errors block saving; warnings (e.g. a transform input produced outside the pipeline) are shown. */
export async function pipelineProblems(ownerId: string, p: PipelineInput, selfId?: string) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const clash = await pipelines().findOne({
    ownerId,
    name: p.name,
    ...(selfId ? { _id: { $ne: selfId } } : {}),
  });
  if (clash) errors.push(`A pipeline named ${p.name} already exists`);
  const ids = new Set<string>();
  for (const n of p.nodes) {
    if (ids.has(n.id)) errors.push(`Duplicate node id ${n.id}`);
    ids.add(n.id);
  }
  for (const n of p.nodes)
    for (const u of n.after) if (!ids.has(u)) errors.push(`${n.id}: after ${u}, which is not a node`);
  const cycle = pipelineCycle(p.nodes);
  if (cycle) errors.push(`Cycle: ${cycle.join(' → ')}`);
  const syncs = await datasetSyncs()
    .find({ ownerId }, { projection: { name: 1, dataset: 1, targetCollection: 1 } })
    .toArray();
  const ts = await transforms()
    .find({ ownerId }, { projection: { name: 1, inputs: 1, outputs: 1 } })
    .toArray();
  const harnesses = await collection<{ _id: string; name: string }>('workflows')
    .find({ ownerId }, { projection: { name: 1 } })
    .toArray();
  const syncCollection = (s: (typeof syncs)[number]) =>
    s.targetCollection || catalogById.get(s.dataset)?.defaultCollection || '';
  // Who produces each collection, as a ref.
  const producer = new Map<string, string>();
  for (const s of syncs) producer.set(syncCollection(s), `sync:${s.name}`);
  for (const t of ts) for (const o of t.outputs) producer.set(o.collection, `transform:${t.name}`);
  for (const n of p.nodes) {
    const type = refType(n.ref);
    const name = refName(n.ref);
    if (type === 'sync' && !syncs.some((s) => s.name === name))
      errors.push(`${n.id}: no dataset sync named "${name}"`);
    if (type === 'transform' && !ts.some((t) => t.name === name))
      errors.push(`${n.id}: no transform named ${name}`);
    if (type === 'harness' && !harnesses.some((h) => h.name === name))
      errors.push(`${n.id}: no harness named "${name}"`);
    if (type === 'check' && !(BUILTIN_CHECKS as readonly string[]).includes(name))
      errors.push(`${n.id}: unknown check ${name} (available: ${BUILTIN_CHECKS.join(', ')})`);
    if (type === 'check' && name === 'collection_rows' && typeof n.params.collection !== 'string')
      errors.push(`${n.id}: collection_rows needs params.collection`);
    if ((type === 'research' || type === 'live') && !extraNodeTypes.has(type))
      errors.push(
        `${n.id}: ${type} nodes need Layer ${type === 'research' ? 3 : 5}, which is not available yet`,
      );
    if (n.gate.min_symbol_coverage !== undefined && type !== 'sync')
      errors.push(`${n.id}: min_symbol_coverage applies to sync nodes`);
    if (type === 'transform') {
      const t = ts.find((x) => x.name === name);
      const ups = new Set([...upstreamOf(p.nodes, n.id)].map((u) => p.nodes.find((x) => x.id === u)?.ref));
      for (const input of t?.inputs ?? []) {
        const by = producer.get(input);
        if (by && !ups.has(by))
          warnings.push(
            `${n.id} reads ${input}, produced by ${by}, which is not upstream of it in this pipeline`,
          );
      }
    }
  }
  return { errors, warnings };
}

/** Parse and validate; throws a 400 listing the errors. */
export async function validatedPipeline(ownerId: string, input: unknown, selfId?: string) {
  const parsed = pipelineInputSchema.safeParse(input);
  if (!parsed.success)
    throw new HttpError(
      400,
      parsed.error.issues.map((i) => `${i.path.join('.') || 'pipeline'}: ${i.message}`).join('; '),
    );
  const { errors, warnings } = await pipelineProblems(ownerId, parsed.data, selfId);
  if (errors.length) throw new HttpError(400, errors.join('; '));
  return { spec: parsed.data, warnings };
}

export const pipelineSpec = (p: Pipeline): PipelineInput => {
  const { _id, ownerId, version, nextRunAt, createdAt, updatedAt, createdBy, updatedBy, ...spec } = p;
  return pipelineInputSchema.parse(spec);
};

export async function createPipeline(ownerId: string, input: unknown, userId?: string) {
  const { spec } = await validatedPipeline(ownerId, input);
  const now = new Date();
  const doc: Pipeline = {
    ...spec,
    _id: randomUUID(),
    ownerId,
    version: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
  };
  await pipelines().insertOne(doc);
  return doc;
}
export async function updatePipeline(ownerId: string, id: string, input: unknown, userId?: string) {
  const prev = await pipelines().findOne({ _id: id, ownerId });
  if (!prev) throw new HttpError(404, 'Pipeline not found');
  const { spec } = await validatedPipeline(ownerId, input, id);
  if (JSON.stringify(pipelineSpec(prev)) === JSON.stringify(spec)) return prev;
  const scheduleChanged = JSON.stringify(prev.schedule) !== JSON.stringify(spec.schedule);
  const next = { ...spec, version: prev.version + 1, updatedAt: new Date(), updatedBy: userId };
  await pipelines().updateOne({ _id: id, ownerId }, {
    $set: next,
    ...(scheduleChanged || !spec.schedule ? { $unset: { nextRunAt: '' } } : {}),
  } as Record<string, unknown>);
  if (!spec.schedule) delete (next as Partial<Pipeline>).schedule;
  return { ...prev, ...next, ...(scheduleChanged ? { nextRunAt: undefined } : {}) } as Pipeline;
}
export async function deletePipeline(ownerId: string, id: string) {
  const r = await pipelines().deleteOne({ _id: id, ownerId });
  if (!r.deletedCount) throw new HttpError(404, 'Pipeline not found');
  // Runs are kept for audit.
}

/**
 * "Generate from dependencies": nodes for the given transforms (default: all) and the syncs and transforms
 * that produce their inputs, with edges from inputs and `trigger.after`.
 */
export async function suggestPipelineNodes(ownerId: string, transformNames?: string[]) {
  const syncs = await datasetSyncs().find({ ownerId }).toArray();
  const ts = await transforms().find({ ownerId }).toArray();
  const byCollection = new Map<string, string>();
  for (const s of syncs)
    byCollection.set(
      s.targetCollection || catalogById.get(s.dataset)?.defaultCollection || '',
      `sync:${s.name}`,
    );
  for (const t of ts) for (const o of t.outputs) byCollection.set(o.collection, `transform:${t.name}`);
  const nodes = new Map<string, PipelineNode>();
  const idFor = (ref: string) =>
    (refType(ref) === 'sync' ? 'sync_' : '') +
      refName(ref)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 36) || 'node';
  const add = (ref: string): string => {
    const existing = [...nodes.values()].find((n) => n.ref === ref);
    if (existing) return existing.id;
    let id = idFor(ref);
    if (!/^[a-z]/.test(id)) id = `n_${id}`;
    while (nodes.has(id)) id = `${id}_2`;
    const node = pipelineNodeSchema.parse({ id, ref });
    nodes.set(id, node);
    if (refType(ref) === 'transform') {
      const t = ts.find((x) => x.name === refName(ref))!;
      const ups = new Set<string>();
      for (const i of t.inputs) {
        const by = byCollection.get(i);
        if (by && by !== ref) ups.add(add(by));
      }
      for (const a of t.trigger.after) {
        const [kind, name] = a.split(':');
        const by = kind === 'dataset' ? byCollection.get(name) : `transform:${name}`;
        if (by && by !== ref && (kind === 'dataset' || ts.some((x) => x.name === name))) ups.add(add(by));
      }
      node.after = [...ups];
    }
    return id;
  };
  for (const t of ts)
    if (!transformNames?.length || transformNames.includes(t.name)) add(`transform:${t.name}`);
  return [...nodes.values()];
}
