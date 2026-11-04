// Layer 2 Transforms (#89): a first-class resource (not a workflow). Python code that reads Layer 1 (or other
// transforms' outputs) and writes one or more flat, point-in-time collections. Every save is an immutable
// version. Layer 2 is optional: transforms exist only where raw data needs cleaning, joining or versioning.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mongo, collection } from './db.js';
import { workspaceDatabase } from './mongoMcp.js';
import { HttpError } from './security.js';
import { scheduleSchema } from './schema.js';
import { catalogById } from './datasetCatalog.js';
import { datasetSyncs } from './datasetSync.js';

const collectionName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,62}$/, 'Letters, digits and underscores');
const fieldName = z.string().min(1).max(100);
export const transformOutputSchema = z.object({
  collection: collectionName,
  /** Upsert identity for this output. */
  key: z.array(fieldName).min(1).max(10),
  write_mode: z.enum(['upsert', 'append', 'replace']).default('upsert'),
  /** Required unless `static`: when each row became known (point-in-time). */
  known_at_field: fieldName.optional(),
  as_of_field: fieldName.optional(),
  /** Static reference data (e.g. a calendar) needs no point-in-time fields. */
  static: z.boolean().default(false),
  description: z.string().max(2000).optional(),
  grain: z.string().max(500).optional(),
  fields: z
    .record(z.object({ description: z.string().max(2000).optional(), unit: z.string().max(60).optional() }))
    .optional(),
});
export const transformInputSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/, 'Lowercase letters, digits and underscores (e.g. prices_daily)'),
    description: z.string().max(2000).default(''),
    code: z.string().min(1).max(200_000),
    /** Collections the code reads; used for lineage, triggers and validation. */
    inputs: z.array(collectionName).max(50).default([]),
    outputs: z.array(transformOutputSchema).min(1).max(20),
    trigger: z
      .object({
        schedule: scheduleSchema.optional(),
        /** Run after these complete: `dataset:<collection>` or `transform:<name>`. */
        after: z
          .array(z.string().regex(/^(dataset|transform):[A-Za-z][A-Za-z0-9_]{0,62}$/))
          .max(20)
          .default([]),
      })
      .default({ after: [] }),
    incremental: z
      .object({
        mode: z.enum(['full', 'date_range']).default('full'),
        /** Extra history loaded before the window (e.g. 10 for returns); only rows in the window are written. */
        lookback_days: z.number().int().min(0).max(3650).default(0),
      })
      .default({ mode: 'full', lookback_days: 0 }),
    params: z.record(z.unknown()).default({}),
    /** Python secret names (Settings -> Python secrets) given to the code; never values. */
    secrets: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/))
      .max(50)
      .default([]),
    enabled: z.boolean().default(true),
  })
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    t.outputs.forEach((o, i) => {
      if (!o.static && !o.known_at_field)
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', i, 'known_at_field'],
          message: `Output ${o.collection} needs a known_at field (point-in-time) unless it is marked static`,
        });
      if (seen.has(o.collection))
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', i, 'collection'],
          message: `Duplicate output ${o.collection}`,
        });
      seen.add(o.collection);
      if (t.inputs.includes(o.collection))
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', i, 'collection'],
          message: `${o.collection} cannot be both an input and an output`,
        });
    });
    if (t.trigger.after.includes(`transform:${t.name}`))
      ctx.addIssue({
        code: 'custom',
        path: ['trigger', 'after'],
        message: 'A transform cannot run after itself',
      });
  });
export type TransformInput = z.infer<typeof transformInputSchema>;
export type Transform = TransformInput & {
  _id: string;
  ownerId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  updatedBy?: string;
};
export type TransformVersion = {
  _id: string; // `${transformId}:${version}`
  ownerId: string;
  transformId: string;
  version: number;
  spec: TransformInput;
  note?: string;
  createdAt: Date;
  createdBy?: string;
};
export const transforms = () => collection<Transform>('transforms');
export const transformVersions = () => collection<TransformVersion>('transform_versions');

/** Collections that Layer 1 syncs write (a transform may not write to them). */
async function syncTargets(ownerId: string) {
  const syncs = await datasetSyncs()
    .find({ ownerId }, { projection: { dataset: 1, targetCollection: 1, name: 1 } })
    .toArray();
  const map = new Map<string, string>();
  for (const s of syncs) {
    const c = s.targetCollection || catalogById.get(s.dataset)?.defaultCollection;
    if (c) map.set(c, s.name);
  }
  // The universe sync also writes the delisted-companies list.
  if (syncs.some((s) => s.dataset === 'universe')) map.set('delisted_companies', 'universe sync');
  return map;
}

/** Workspace rules a transform must satisfy beyond its schema. Returns the problems (empty when valid). */
export async function transformProblems(ownerId: string, t: TransformInput, selfId?: string) {
  const problems: string[] = [];
  const targets = await syncTargets(ownerId);
  const others = await transforms()
    .find({ ownerId, ...(selfId ? { _id: { $ne: selfId } } : {}) }, { projection: { name: 1, outputs: 1 } })
    .toArray();
  if (others.some((o) => o.name === t.name)) problems.push(`A transform named ${t.name} already exists`);
  const producedBy = new Map<string, string>();
  for (const o of others) for (const out of o.outputs) producedBy.set(out.collection, o.name);
  for (const out of t.outputs) {
    if (targets.has(out.collection))
      problems.push(
        `${out.collection} is written by the Layer 1 sync "${targets.get(out.collection)}"; a transform must write its own collection`,
      );
    if (producedBy.has(out.collection))
      problems.push(
        `${out.collection} is already produced by the transform ${producedBy.get(out.collection)} (one producer per collection)`,
      );
  }
  const existing = new Set(
    (await mongo.db(workspaceDatabase(ownerId)).listCollections({}, { nameOnly: true }).toArray()).map(
      (c) => c.name,
    ),
  );
  for (const i of t.inputs)
    if (!existing.has(i) && !targets.has(i) && !producedBy.has(i))
      problems.push(
        `Input ${i} does not exist (no collection, sync target or transform output by that name)`,
      );
  for (const a of t.trigger.after) {
    const [kind, ref] = a.split(':');
    if (kind === 'dataset' && !targets.has(ref)) problems.push(`Trigger ${a}: no dataset sync writes ${ref}`);
    if (kind === 'transform' && !others.some((o) => o.name === ref))
      problems.push(`Trigger ${a}: no transform named ${ref}`);
  }
  return problems;
}

const specOf = (t: Transform | TransformInput): TransformInput => {
  const { _id, ownerId, version, createdAt, updatedAt, createdBy, updatedBy, ...spec } = t as Transform;
  return transformInputSchema.parse(spec);
};
const sameSpec = (a: TransformInput, b: TransformInput) => JSON.stringify(a) === JSON.stringify(b);

export async function createTransform(ownerId: string, input: unknown, userId?: string) {
  const spec = transformInputSchema.parse(input);
  const problems = await transformProblems(ownerId, spec);
  if (problems.length) throw new HttpError(400, problems.join('; '));
  const now = new Date();
  const doc: Transform = {
    ...spec,
    _id: randomUUID(),
    ownerId,
    version: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
  };
  await transforms().insertOne(doc);
  await transformVersions().insertOne({
    _id: `${doc._id}:1`,
    ownerId,
    transformId: doc._id,
    version: 1,
    spec,
    createdAt: now,
    createdBy: userId,
  });
  return doc;
}

/** Save a new version (no-op when nothing changed). */
export async function updateTransform(
  ownerId: string,
  id: string,
  input: unknown,
  userId?: string,
  note?: string,
) {
  const prev = await transforms().findOne({ _id: id, ownerId });
  if (!prev) throw new HttpError(404, 'Transform not found');
  const spec = transformInputSchema.parse(input);
  if (sameSpec(specOf(prev), spec)) return prev;
  const problems = await transformProblems(ownerId, spec, id);
  if (problems.length) throw new HttpError(400, problems.join('; '));
  const version = prev.version + 1;
  const now = new Date();
  // The version row first: a saved transform always has its version.
  await transformVersions().insertOne({
    _id: `${id}:${version}`,
    ownerId,
    transformId: id,
    version,
    spec,
    ...(note ? { note } : {}),
    createdAt: now,
    createdBy: userId,
  });
  // A changed schedule re-seeds from now instead of firing missed slots.
  const scheduleChanged = JSON.stringify(prev.trigger?.schedule) !== JSON.stringify(spec.trigger.schedule);
  const r = await transforms().updateOne(
    { _id: id, ownerId, version: prev.version },
    {
      $set: { ...spec, version, updatedAt: now, updatedBy: userId },
      ...(scheduleChanged ? { $unset: { nextRunAt: '' } as Record<string, ''> } : {}),
    },
  );
  if (!r.matchedCount) {
    await transformVersions().deleteOne({ _id: `${id}:${version}` });
    throw new HttpError(409, 'This transform changed meanwhile. Reopen it and save again.');
  }
  return (await transforms().findOne({ _id: id, ownerId }))!;
}

/** Restore an old version as a new version (history is never rewritten). */
export async function restoreTransformVersion(ownerId: string, id: string, version: number, userId?: string) {
  const v = await transformVersions().findOne({ _id: `${id}:${version}`, ownerId });
  if (!v) throw new HttpError(404, 'Version not found');
  return updateTransform(ownerId, id, v.spec, userId, `Restored from v${version}`);
}

export async function deleteTransform(ownerId: string, id: string) {
  const t = await transforms().findOne({ _id: id, ownerId });
  if (!t) throw new HttpError(404, 'Transform not found');
  const outs = t.outputs.map((o) => o.collection);
  const dependents = await transforms()
    .find(
      {
        ownerId,
        _id: { $ne: id },
        $or: [{ inputs: { $in: outs } }, { 'trigger.after': `transform:${t.name}` }],
      },
      { projection: { name: 1 } },
    )
    .toArray();
  if (dependents.length)
    throw new HttpError(409, `Used by ${dependents.map((d) => d.name).join(', ')}; change those first`);
  await transforms().deleteOne({ _id: id, ownerId });
  // Versions are kept for audit; output collections and their data are never dropped here.
}

export const transformSpec = specOf;

export type TransformHistoryEntry = { version: number; note?: string; spec?: Omit<TransformInput, 'name'> };
/**
 * Earlier versions (oldest first) for an export with history (#96). The current version's spec is the
 * object's own spec; when it has a note (e.g. "Restored from v2") a last entry carries just that note.
 */
export async function transformHistory(ownerId: string, t: Transform): Promise<TransformHistoryEntry[]> {
  const rows = await transformVersions()
    .find({ ownerId, transformId: t._id, version: { $lte: t.version } })
    .sort({ version: 1 })
    .toArray();
  const out: TransformHistoryEntry[] = [];
  for (const v of rows) {
    if (v.version === t.version) {
      if (v.note && rows.length > 1) out.push({ version: v.version, note: v.note });
      continue;
    }
    const { name: _n, ...spec } = specOf({ ...(v.spec as Transform) });
    out.push({ version: v.version, ...(v.note ? { note: v.note } : {}), spec });
  }
  return out;
}
/**
 * After an import created a transform (at v1 = the current spec), recreate its earlier versions so diff and
 * restore keep working: history rows become v1..vN-1 and the current spec vN, as in the source workspace.
 */
export async function restoreTransformHistory(
  ownerId: string,
  id: string,
  history: TransformHistoryEntry[],
  userId?: string,
) {
  const earlier = history.filter((h) => h.spec);
  if (!earlier.length) return;
  const t = await transforms().findOne({ _id: id, ownerId });
  if (!t) throw new HttpError(404, 'Transform not found');
  const versions = earlier.map((h) => transformInputSchema.parse({ ...h.spec, name: t.name }));
  const current = earlier.length + 1;
  const currentNote = history.find((h) => !h.spec)?.note;
  const now = new Date();
  await transformVersions().deleteMany({ ownerId, transformId: id });
  await transformVersions().insertMany([
    ...versions.map((spec, i) => ({
      _id: `${id}:${i + 1}`,
      ownerId,
      transformId: id,
      version: i + 1,
      spec,
      ...(earlier[i].note ? { note: earlier[i].note } : {}),
      createdAt: new Date(now.getTime() - (current - i)),
      createdBy: userId,
    })),
    {
      _id: `${id}:${current}`,
      ownerId,
      transformId: id,
      version: current,
      spec: specOf(t),
      ...(currentNote ? { note: currentNote } : {}),
      createdAt: now,
      createdBy: userId,
    },
  ]);
  await transforms().updateOne({ _id: id, ownerId }, { $set: { version: current } });
}
/** History entries in an imported spec: versions 1, 2, … in order; only the last may omit its spec (a note). */
export const transformHistorySchema = z
  .array(
    z.object({
      version: z.number().int().min(1),
      note: z.string().max(500).optional(),
      spec: z.record(z.unknown()).optional(),
    }),
  )
  .max(500)
  .superRefine((h, ctx) => {
    h.forEach((e, i) => {
      if (e.version !== i + 1)
        ctx.addIssue({
          code: 'custom',
          path: [i, 'version'],
          message: 'History must list versions 1, 2, … in order',
        });
      if (!e.spec && i !== h.length - 1)
        ctx.addIssue({
          code: 'custom',
          path: [i, 'spec'],
          message: 'Only the last (current) entry may omit its spec',
        });
    });
  });
