// "Everything is a YAML object" (#152): export and import every object kind through one envelope.
// Writes go through saveResource/deleteResource (the same validation as the REST routes) or the dataset-sync
// import, so an import can never create something the UI could not.
import { Router } from 'express';
import { stringify } from 'yaml';
import { z } from 'zod';
import { collection } from '../../../packages/core/src/db.js';
import { HttpError } from '../../../packages/core/src/security.js';
import { agentSchema, skillSchema, workflowSchema } from '../../../packages/core/src/schema.js';
import { datasetSyncs } from '../../../packages/core/src/datasetSync.js';
import {
  applyDatasetSyncImport,
  planDatasetSyncImport,
  toConfigEntry,
} from '../../../packages/core/src/datasetSyncConfig.js';
import {
  API_VERSION,
  EXTERNAL_REF_TYPES,
  OBJECT_KINDS,
  REF_TYPE_BY_KIND,
  fromRefs,
  parseObjects,
  refsIn,
  renderObjects,
  stableJson,
  toRefs,
  type ObjectDoc,
  type ObjectKind,
} from '../../../packages/core/src/objectEnvelope.js';
import { saveResource, deleteResource, type ResourceKind, type ResourcePrincipal } from './resources.js';
import {
  catalogEntries,
  patchCatalogEntry,
  type CatalogCurated,
} from '../../../packages/core/src/schemaCatalog.js';

/** Kinds stored through the generic resource routes (the others have dedicated importers). */
const isResourceKind = (k: ObjectKind): k is 'Skill' | 'Agent' | 'Harness' => k in RESOURCE_KIND;
/** CatalogEntry spec: only the curated docs; generated stats are recomputed after import. */
const catalogSpec = (c: CatalogCurated | undefined) => {
  const spec: Record<string, unknown> = {};
  if (c?.description) spec.description = c.description;
  if (c?.grain) spec.grain = c.grain;
  const fields = Object.fromEntries(
    Object.entries(c?.fields ?? {})
      .filter(([, v]) => v && (v.description || v.unit))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  if (Object.keys(fields).length) spec.fields = fields;
  return spec;
};

type Rec = { _id: string; ownerId: string; name: string; [key: string]: any };
const COLLECTION_BY_REF_TYPE: Record<string, string> = {
  connections: 'connections',
  providers: 'providers',
  knowledge: 'knowledge',
  guardrails: 'guardrails',
  agents: 'agents',
  skills: 'skills',
  workflows: 'workflows',
  datasetSyncs: 'dataset_syncs',
};
const RESOURCE_KIND: Partial<Record<ObjectKind, ResourceKind>> = {
  Skill: 'skills',
  Agent: 'agents',
  Harness: 'workflows',
};
const SCHEMA = { Skill: skillSchema, Agent: agentSchema, Harness: workflowSchema } as const;

/** Server-set fields that are not part of a definition even though the schema allows them. */
function stripServerFields(kind: ObjectKind, spec: Record<string, any>) {
  if (kind === 'Agent') delete spec.skills; // run-time snapshot
  if (kind === 'Harness') for (const node of spec.nodes ?? []) if (node?.config) delete node.config.skills;
  return spec;
}

/** id -> {type, name} and (type, name) -> ids, across everything an object may reference. */
async function referenceIndex(ownerId: string) {
  const byId = new Map<string, { type: string; name: string }>();
  const byName = new Map<string, string[]>();
  for (const [type, coll] of Object.entries(COLLECTION_BY_REF_TYPE)) {
    const rows = await collection<Rec>(coll)
      .find({ ownerId }, { projection: { _id: 1, name: 1 } })
      .toArray();
    for (const r of rows) {
      if (!r.name) continue;
      byId.set(r._id, { type, name: r.name });
      const key = `${type}\u0000${r.name}`;
      byName.set(key, [...(byName.get(key) ?? []), r._id]);
    }
  }
  return { byId, byName };
}

/** Canonical definition of a stored record, in reference (by-name) form. */
function toSpec(
  kind: 'Skill' | 'Agent' | 'Harness',
  record: Rec,
  byId: Map<string, { type: string; name: string }>,
) {
  const parsed = SCHEMA[kind].safeParse(record);
  // Records saved before a schema change still export; unknown keys are dropped either way.
  const base: Record<string, any> = parsed.success ? { ...parsed.data } : { ...record };
  for (const k of [
    '_id',
    'id',
    'ownerId',
    'createdAt',
    'updatedAt',
    'createdBy',
    'updatedBy',
    'revision',
    'files',
  ])
    delete base[k];
  delete base.name;
  return toRefs(stripServerFields(kind, base), byId) as Record<string, unknown>;
}

export async function exportObjects(
  ownerId: string,
  kinds: ObjectKind[] = [...OBJECT_KINDS],
  names?: string[],
) {
  const { byId } = await referenceIndex(ownerId);
  const wanted = (n: string) => !names?.length || names.includes(n);
  const docs: ObjectDoc[] = [];
  for (const kind of kinds) {
    if (kind === 'DatasetSync') {
      const conns = await collection<Rec>('connections')
        .find({ ownerId }, { projection: { name: 1 } })
        .toArray();
      const connName = new Map(conns.map((c) => [c._id, c.name]));
      for (const s of await datasetSyncs().find({ ownerId }).toArray()) {
        if (!wanted(s.name)) continue;
        const { name, ...spec } = toConfigEntry(s, connName.get(s.connectionId)) as Record<string, unknown>;
        docs.push({ apiVersion: API_VERSION, kind, metadata: { name: String(name) }, spec });
      }
      continue;
    }
    if (kind === 'CatalogEntry') {
      for (const e of await catalogEntries()
        .find({ ownerId, curated: { $exists: true } })
        .toArray()) {
        const spec = catalogSpec(e.curated);
        if (!wanted(e.collection) || !Object.keys(spec).length) continue;
        docs.push({ apiVersion: API_VERSION, kind, metadata: { name: e.collection }, spec });
      }
      continue;
    }
    for (const r of await collection<Rec>(RESOURCE_KIND[kind]!).find({ ownerId }).toArray()) {
      if (!wanted(r.name)) continue;
      docs.push({
        apiVersion: API_VERSION,
        kind,
        metadata: { name: r.name, ...(kind === 'Skill' && r.version ? { version: String(r.version) } : {}) },
        spec: toSpec(kind, r, byId),
      });
    }
  }
  return { count: docs.length, yaml: renderObjects(docs) };
}

export type ObjectPlanItem = {
  kind: ObjectKind;
  name: string;
  action: 'create' | 'update' | 'unchanged' | 'remove';
};
export type ObjectPlan = {
  mode: 'merge' | 'replace';
  items: ObjectPlanItem[];
  errors: { kind?: ObjectKind; name?: string; message: string }[];
};

type Prepared = { doc: ObjectDoc; existingId?: string; action: ObjectPlanItem['action'] };

async function plan(
  principal: ResourcePrincipal,
  text: string,
  mode: 'merge' | 'replace',
  legacyKind?: ObjectKind,
) {
  const ownerId = principal.tenantId;
  const { docs, errors: parseErrors } = parseObjects(text, legacyKind);
  const result: ObjectPlan = {
    mode,
    items: [],
    errors: parseErrors.map((e) => ({ message: `Entry ${e.index + 1}: ${e.message}` })),
  };
  const { byId, byName } = await referenceIndex(ownerId);
  const incoming = new Set(docs.map((d) => `${REF_TYPE_BY_KIND[d.kind]}\u0000${d.metadata.name}`));
  const prepared: Prepared[] = [];

  // Dataset syncs keep their dedicated, already-tested importer (connection by name, cursor preserved).
  const syncDocs = docs.filter((d) => d.kind === 'DatasetSync');
  const syncYaml = syncDocs.length
    ? stringify({ syncs: syncDocs.map((d) => ({ name: d.metadata.name, ...d.spec })) }, { lineWidth: 0 })
    : '';
  if (syncDocs.length) {
    const p = await planDatasetSyncImport(ownerId, syncYaml, mode);
    for (const c of p.create) result.items.push({ kind: 'DatasetSync', name: c.name, action: 'create' });
    for (const u of p.update) result.items.push({ kind: 'DatasetSync', name: u.name, action: 'update' });
    for (const u of p.unchanged)
      result.items.push({ kind: 'DatasetSync', name: u.name, action: 'unchanged' });
    for (const r of p.remove) result.items.push({ kind: 'DatasetSync', name: r.name, action: 'remove' });
    for (const e of p.errors) result.errors.push({ kind: 'DatasetSync', name: e.name, message: e.message });
  }

  // Catalog docs: curated descriptions only, matched by collection name (merge semantics in both modes).
  for (const doc of docs.filter((d) => d.kind === 'CatalogEntry')) {
    const name = doc.metadata.name;
    const spec = doc.spec as CatalogCurated;
    if (spec.fields && (typeof spec.fields !== 'object' || Array.isArray(spec.fields))) {
      result.errors.push({
        kind: 'CatalogEntry',
        name,
        message: 'spec.fields must map field names to { description, unit }',
      });
      continue;
    }
    const current = await catalogEntries().findOne({ ownerId, collection: name });
    const action = !current?.curated
      ? 'create'
      : stableJson(catalogSpec(current.curated)) === stableJson(catalogSpec(spec))
        ? 'unchanged'
        : 'update';
    prepared.push({ doc, action });
    result.items.push({ kind: 'CatalogEntry', name, action });
  }

  for (const doc of docs) {
    if (!isResourceKind(doc.kind)) continue;
    const kind = doc.kind;
    const rk = RESOURCE_KIND[kind]!;
    const type = REF_TYPE_BY_KIND[kind];
    const same = byName.get(`${type}\u0000${doc.metadata.name}`) ?? [];
    if (same.length > 1) {
      result.errors.push({
        kind,
        name: doc.metadata.name,
        message: `${same.length} existing ${kind}s share this name`,
      });
      continue;
    }
    // References must exist on the target or be created by this same import.
    const missing: string[] = [];
    for (const r of refsIn(doc.spec)) {
      const hits = byName.get(`${r.type}\u0000${r.name}`) ?? [];
      if (hits.length > 1) missing.push(`several ${r.type} named "${r.name}"`);
      else if (!hits.length && !incoming.has(`${r.type}\u0000${r.name}`))
        missing.push(
          `${r.type} "${r.name}"${(EXTERNAL_REF_TYPES as readonly string[]).includes(r.type) ? ' (create it on this install first)' : ''}`,
        );
    }
    if (missing.length) {
      result.errors.push({
        kind,
        name: doc.metadata.name,
        message: `Missing references: ${missing.join(', ')}`,
      });
      continue;
    }
    // Validate the shape now (placeholders stand in for objects this import creates).
    const resolved = fromRefs(
      doc.spec,
      (t, n) => (byName.get(`${t}\u0000${n}`) ?? [])[0] ?? `00000000-0000-4000-8000-000000000000`,
    );
    const parsed = SCHEMA[kind].safeParse({ ...(resolved as object), name: doc.metadata.name });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      result.errors.push({
        kind,
        name: doc.metadata.name,
        message: `${issue.path.join('.') || 'spec'}: ${issue.message}`,
      });
      continue;
    }
    const existingId = same[0];
    let action: Prepared['action'] = 'create';
    if (existingId) {
      const current = await collection<Rec>(rk).findOne({ _id: existingId, ownerId });
      const now = current ? toSpec(kind, current, byId) : undefined;
      const next = toSpec(
        kind,
        { ...(parsed.data as object), _id: existingId, ownerId, name: doc.metadata.name } as Rec,
        byId,
      );
      action = now && stableJson(now) === stableJson(next) ? 'unchanged' : 'update';
    }
    prepared.push({ doc, existingId, action });
    result.items.push({ kind, name: doc.metadata.name, action });
  }

  // Replace: remove objects of each kind present in the file that the file no longer contains.
  if (mode === 'replace')
    for (const kind of OBJECT_KINDS) {
      if (!isResourceKind(kind) || !docs.some((d) => d.kind === kind)) continue;
      const keep = new Set(docs.filter((d) => d.kind === kind).map((d) => d.metadata.name));
      for (const r of await collection<Rec>(RESOURCE_KIND[kind]!)
        .find({ ownerId }, { projection: { name: 1 } })
        .toArray())
        if (!keep.has(r.name)) {
          prepared.push({
            doc: { apiVersion: API_VERSION, kind, metadata: { name: r.name }, spec: {} },
            existingId: r._id,
            action: 'remove',
          });
          result.items.push({ kind, name: r.name, action: 'remove' });
        }
    }
  return { result, prepared, syncYaml, hasSyncs: syncDocs.length > 0 };
}

export async function planObjectImport(
  principal: ResourcePrincipal,
  text: string,
  mode: 'merge' | 'replace',
  legacyKind?: ObjectKind,
) {
  return (await plan(principal, text, mode, legacyKind)).result;
}

/** All-or-nothing on plan errors; writes in dependency order (skills, agents, harnesses, dataset syncs). */
export async function applyObjectImport(
  principal: ResourcePrincipal,
  text: string,
  mode: 'merge' | 'replace',
  legacyKind?: ObjectKind,
) {
  const ownerId = principal.tenantId;
  const { result, prepared, syncYaml, hasSyncs } = await plan(principal, text, mode, legacyKind);
  if (result.errors.length) return { applied: false, plan: result };
  const done: ObjectPlanItem[] = [];
  try {
    for (const kind of OBJECT_KINDS) {
      if (!isResourceKind(kind)) continue;
      // Re-resolve per kind so references to objects created earlier in this import find their new ids.
      const { byName } = await referenceIndex(ownerId);
      for (const p of prepared.filter(
        (x) => x.doc.kind === kind && (x.action === 'create' || x.action === 'update'),
      )) {
        const spec = fromRefs(p.doc.spec, (t, n) => (byName.get(`${t}\u0000${n}`) ?? [])[0]);
        await saveResource(
          RESOURCE_KIND[kind]!,
          principal,
          { ...(spec as object), name: p.doc.metadata.name },
          p.existingId ? { id: p.existingId } : {},
        );
        done.push({ kind, name: p.doc.metadata.name, action: p.action });
      }
    }
    if (hasSyncs) {
      const r = await applyDatasetSyncImport(ownerId, syncYaml, mode, principal.user._id);
      if (!r.applied) throw new HttpError(400, r.plan.errors[0]?.message ?? 'Dataset sync import failed');
    }
    // Catalog docs last: their collections may be targets of the syncs just imported.
    for (const p of prepared.filter((x) => x.doc.kind === 'CatalogEntry' && x.action !== 'unchanged')) {
      const spec = p.doc.spec as CatalogCurated;
      await patchCatalogEntry(ownerId, p.doc.metadata.name, {
        description: spec.description,
        grain: spec.grain,
        fields: spec.fields ?? {},
      });
      done.push({ kind: 'CatalogEntry', name: p.doc.metadata.name, action: p.action });
    }
    // Removals last and in reverse dependency order, so harnesses go before the skills/agents they use.
    for (const kind of [...OBJECT_KINDS].reverse()) {
      if (!isResourceKind(kind)) continue;
      for (const p of prepared.filter((x) => x.doc.kind === kind && x.action === 'remove')) {
        await deleteResource(RESOURCE_KIND[kind]!, principal, p.existingId!);
        done.push({ kind, name: p.doc.metadata.name, action: 'remove' });
      }
    }
  } catch (error) {
    // A write the plan could not foresee (e.g. a reference check) failed: report what was applied before it.
    return {
      applied: false,
      partial: done,
      plan: result,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { applied: true, plan: result };
}

const kindList = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined))
  .pipe(z.array(z.enum(OBJECT_KINDS)).optional());
const importInput = z.object({
  yaml: z.string().min(1).max(5_000_000),
  mode: z.enum(['merge', 'replace']).default('merge'),
  dryRun: z.boolean().default(true),
  /** Kind of a bare list (deploy/config-io files). */
  legacyKind: z.enum(OBJECT_KINDS).optional(),
});

/** Mounted under /api with requireSession. */
export const objectsRouter = Router();
objectsRouter.get('/objects/kinds', (_req, res) =>
  res.json({ apiVersion: API_VERSION, kinds: OBJECT_KINDS }),
);
objectsRouter.get('/objects/export', async (req, res) => {
  const kinds = kindList.parse(typeof req.query.kinds === 'string' ? req.query.kinds : undefined);
  const names =
    typeof req.query.names === 'string' && req.query.names ? req.query.names.split(',') : undefined;
  const { yaml } = await exportObjects(req.principal!.tenantId, kinds, names);
  res
    .type('application/yaml')
    .set(
      'Content-Disposition',
      `attachment; filename="stockharness-${new Date().toISOString().slice(0, 10)}.yaml"`,
    )
    .send(yaml);
});
objectsRouter.post('/objects/import', async (req, res) => {
  if (req.principal!.user.role !== 'admin')
    throw new HttpError(403, 'Only administrators can import objects');
  const { yaml, mode, dryRun, legacyKind } = importInput.parse(req.body);
  if (dryRun)
    return void res.json({
      applied: false,
      plan: await planObjectImport(req.principal!, yaml, mode, legacyKind),
    });
  res.json(await applyObjectImport(req.principal!, yaml, mode, legacyKind));
});
