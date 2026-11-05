// "Everything is a YAML object" (#152): export and import every object kind through one envelope.
// Writes go through saveResource/deleteResource (the same validation as the REST routes) or the dataset-sync
// import, so an import can never create something the UI could not.
import { randomUUID } from 'node:crypto';
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
import {
  createTransform,
  deleteTransform,
  transformInputSchema,
  transformProblems,
  transformSpec,
  transforms,
  updateTransform,
  transformHistory,
  restoreTransformHistory,
  transformHistorySchema,
  type TransformHistoryEntry,
} from '../../../packages/core/src/transforms.js';
import { catalogById } from '../../../packages/core/src/datasetCatalog.js';
import {
  createPipeline,
  deletePipeline,
  pipelineInputSchema,
  pipelineProblems,
  pipelineSpec,
  pipelines,
  refName,
  refType,
  updatePipeline,
} from '../../../packages/core/src/pipelines.js';
import {
  createStrategyPlugin,
  deleteStrategyPlugin,
  pluginProblems,
  restoreStrategyPluginHistory,
  strategyPluginHashProblems,
  strategyPluginHistory,
  strategyPluginHistorySchema,
  strategyPluginInput,
  strategyPluginSpec,
  strategyPlugins,
  updateStrategyPlugin,
  type StrategyPluginHistoryEntry,
} from '../../../packages/core/src/strategyPlugins.js';
import { evaluations, type Evaluation } from '../../../packages/core/src/evaluations.js';

/** An Evaluation record's spec: provenance, params, outcome and the evaluator's record, verbatim. */
function evaluationSpec(e: Evaluation) {
  return {
    plugin: e.pluginName,
    pluginVersion: e.pluginVersion,
    codeHash: e.codeHash,
    ...(e.theoryId ? { theoryId: e.theoryId } : {}),
    mode: e.mode,
    trial: e.trial,
    status: e.status,
    params: e.params,
    ...(e.error ? { error: e.error } : {}),
    ...(e.record ? { record: e.record } : {}),
    ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
    createdAt: e.createdAt.toISOString(),
    ...(e.finishedAt ? { finishedAt: e.finishedAt.toISOString() } : {}),
  };
}
function evaluationSpecProblems(spec: Record<string, any>) {
  const problems: string[] = [];
  if (typeof spec.plugin !== 'string' || !spec.plugin) problems.push('spec.plugin is required');
  if (!Number.isInteger(spec.pluginVersion)) problems.push('spec.pluginVersion must be an integer');
  if (typeof spec.codeHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(spec.codeHash))
    problems.push('spec.codeHash must be a sha256: hash');
  if (!['explore', 'holdout'].includes(spec.mode)) problems.push('spec.mode must be explore or holdout');
  if (!['succeeded', 'failed'].includes(spec.status))
    problems.push('spec.status must be succeeded or failed');
  if (!spec.params || typeof spec.params !== 'object') problems.push('spec.params is required');
  if (Number.isNaN(Date.parse(spec.createdAt))) problems.push('spec.createdAt must be a date');
  // Provenance must agree with itself: the record ran the code the evaluation names.
  if (spec.record && spec.record.plugin?.hash !== spec.codeHash)
    problems.push('record.plugin.hash does not match codeHash');
  return problems;
}

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
  if (c?.caveats?.length) spec.caveats = [...c.caveats].sort((x, y) => x.id.localeCompare(y.id));
  if (c?.dismissedCaveats?.length) spec.dismissedCaveats = [...c.dismissedCaveats].sort();
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
  opts: { withHistory?: boolean } = {},
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
    if (kind === 'Transform') {
      for (const t of await transforms().find({ ownerId }).toArray()) {
        if (!wanted(t.name)) continue;
        const { name, ...spec } = transformSpec(t);
        // With history (#96): earlier versions, oldest first, so an import keeps diff and restore working.
        const history = opts.withHistory ? await transformHistory(ownerId, t) : [];
        docs.push({
          apiVersion: API_VERSION,
          kind,
          metadata: { name, version: String(t.version) },
          spec: history.length ? { ...spec, history } : spec,
        });
      }
      continue;
    }
    if (kind === 'Pipeline') {
      for (const p of await pipelines().find({ ownerId }).toArray()) {
        if (!wanted(p.name)) continue;
        const { name, ...spec } = pipelineSpec(p);
        docs.push({ apiVersion: API_VERSION, kind, metadata: { name, version: String(p.version) }, spec });
      }
      continue;
    }
    if (kind === 'StrategyPlugin') {
      for (const p of await strategyPlugins().find({ ownerId }).toArray()) {
        if (!wanted(p.name)) continue;
        const history = opts.withHistory ? await strategyPluginHistory(ownerId, p) : [];
        const spec = strategyPluginSpec(p);
        docs.push({
          apiVersion: API_VERSION,
          kind,
          metadata: { name: p.name, version: String(p.version) },
          spec: history.length ? { ...spec, history } : spec,
        });
      }
      continue;
    }
    if (kind === 'Evaluation') {
      for (const e of await evaluations()
        .find({ ownerId, status: { $ne: 'running' } })
        .sort({ createdAt: 1 })
        .toArray()) {
        const name = (e as Evaluation & { sourceId?: string }).sourceId ?? e._id;
        if (!wanted(name)) continue;
        docs.push({ apiVersion: API_VERSION, kind, metadata: { name }, spec: evaluationSpec(e) });
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
    if (!isResourceKind(kind)) continue;
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

  // Transforms: validated by their schema and workspace rules; matched by name.
  const transformDocs = docs.filter((d) => d.kind === 'Transform');
  const incomingTransformNames = new Set(transformDocs.map((d) => d.metadata.name));
  // Collections this same import creates: transform outputs and the targets of incoming dataset syncs.
  const incomingOutputs = new Set([
    ...transformDocs.flatMap((d) =>
      ((d.spec.outputs as { collection: string }[]) ?? []).map((o) => o.collection),
    ),
    ...docs
      .filter((d) => d.kind === 'DatasetSync')
      .map(
        (d) =>
          (d.spec.targetCollection as string | undefined) ||
          catalogById.get(String(d.spec.dataset))?.defaultCollection ||
          '',
      )
      .filter(Boolean),
    // The universe sync also writes the delisted-companies list (as syncTargets() knows).
    ...(docs.some((d) => d.kind === 'DatasetSync' && d.spec.dataset === 'universe')
      ? ['delisted_companies']
      : []),
  ]);
  for (const doc of transformDocs) {
    const name = doc.metadata.name;
    const parsed = transformInputSchema.safeParse({ ...doc.spec, name });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      result.errors.push({
        kind: 'Transform',
        name,
        message: `${issue.path.join('.') || 'spec'}: ${issue.message}`,
      });
      continue;
    }
    if (doc.spec.history !== undefined) {
      const h = transformHistorySchema.safeParse(doc.spec.history);
      const bad = h.success
        ? h.data
            .filter((e) => e.spec)
            .map((e) => transformInputSchema.safeParse({ ...e.spec, name }))
            .find((r) => !r.success)
        : undefined;
      if (!h.success || bad) {
        const issue = (h.success ? bad!.error! : h.error).issues[0];
        result.errors.push({
          kind: 'Transform',
          name,
          message: `history: ${issue.path.join('.') || 'entry'}: ${issue.message}`,
        });
        continue;
      }
    }
    const current = await transforms().findOne({ ownerId, name });
    // Inputs and triggers may point at transforms (or their outputs) created by this same import.
    const problems = (await transformProblems(ownerId, parsed.data, current?._id)).filter(
      (p) =>
        !(p.startsWith('Input ') && [...incomingOutputs].some((c) => p.startsWith(`Input ${c} `))) &&
        !(
          p.startsWith('Trigger transform:') &&
          [...incomingTransformNames].some((n) => p.startsWith(`Trigger transform:${n}:`))
        ) &&
        !(
          p.startsWith('Trigger dataset:') &&
          [...incomingOutputs].some((c) => p.startsWith(`Trigger dataset:${c}:`))
        ),
    );
    if (problems.length) {
      result.errors.push({ kind: 'Transform', name, message: problems.join('; ') });
      continue;
    }
    const action = !current
      ? 'create'
      : stableJson(transformSpec(current)) === stableJson(parsed.data)
        ? 'unchanged'
        : 'update';
    prepared.push({ doc, existingId: current?._id, action });
    result.items.push({ kind: 'Transform', name, action });
  }
  if (mode === 'replace' && transformDocs.length)
    for (const t of await transforms()
      .find({ ownerId }, { projection: { name: 1 } })
      .toArray())
      if (!incomingTransformNames.has(t.name)) {
        prepared.push({
          doc: { apiVersion: API_VERSION, kind: 'Transform', metadata: { name: t.name }, spec: {} },
          existingId: t._id,
          action: 'remove',
        });
        result.items.push({ kind: 'Transform', name: t.name, action: 'remove' });
      }

  // Pipelines (#156): validated like the API does; refs to syncs, transforms and harnesses created by this
  // same import are fine (they are applied first).
  const pipelineDocs = docs.filter((d) => d.kind === 'Pipeline');
  const incomingRefs: Record<string, Set<string>> = {
    sync: new Set(docs.filter((d) => d.kind === 'DatasetSync').map((d) => d.metadata.name)),
    transform: new Set(transformDocs.map((d) => d.metadata.name)),
    harness: new Set(docs.filter((d) => d.kind === 'Harness').map((d) => d.metadata.name)),
  };
  for (const doc of pipelineDocs) {
    const name = doc.metadata.name;
    const parsed = pipelineInputSchema.safeParse({ ...doc.spec, name });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      result.errors.push({
        kind: 'Pipeline',
        name,
        message: `${issue.path.join('.') || 'spec'}: ${issue.message}`,
      });
      continue;
    }
    const current = await pipelines().findOne({ ownerId, name });
    const suppliedHere = new Set(
      parsed.data.nodes.filter((n) => incomingRefs[refType(n.ref)]?.has(refName(n.ref))).map((n) => n.id),
    );
    const { errors } = await pipelineProblems(ownerId, parsed.data, current?._id);
    const real = errors.filter(
      (e) =>
        !/^([a-z0-9_]+): no (dataset sync|transform|harness) named/.test(e) ||
        !suppliedHere.has(e.split(':')[0]),
    );
    if (real.length) {
      result.errors.push({ kind: 'Pipeline', name, message: real.join('; ') });
      continue;
    }
    const action = !current
      ? 'create'
      : stableJson(pipelineSpec(current)) === stableJson(parsed.data)
        ? 'unchanged'
        : 'update';
    prepared.push({ doc, existingId: current?._id, action });
    result.items.push({ kind: 'Pipeline', name, action });
  }
  if (mode === 'replace' && pipelineDocs.length) {
    const names = new Set(pipelineDocs.map((d) => d.metadata.name));
    for (const p of await pipelines()
      .find({ ownerId }, { projection: { name: 1 } })
      .toArray())
      if (!names.has(p.name)) {
        prepared.push({
          doc: { apiVersion: API_VERSION, kind: 'Pipeline', metadata: { name: p.name }, spec: {} },
          existingId: p._id,
          action: 'remove',
        });
        result.items.push({ kind: 'Pipeline', name: p.name, action: 'remove' });
      }
  }

  // Strategy plugins (#103): code verbatim; its hash (and every history entry's) must match.
  const pluginDocs = docs.filter((d) => d.kind === 'StrategyPlugin');
  for (const doc of pluginDocs) {
    const name = doc.metadata.name;
    const { history, hash: _h, ...rest } = doc.spec;
    const parsed = strategyPluginInput.safeParse({ ...rest, name });
    const hist = history === undefined ? undefined : strategyPluginHistorySchema.safeParse(history);
    const problems = [
      ...(parsed.success
        ? pluginProblems(parsed.data)
        : [`${parsed.error.issues[0].path.join('.') || 'spec'}: ${parsed.error.issues[0].message}`]),
      ...(hist && !hist.success ? ['history: must be a list of { version, hash, code }'] : []),
      ...strategyPluginHashProblems(doc.spec),
    ];
    if (problems.length) {
      result.errors.push({ kind: 'StrategyPlugin', name, message: problems.join('; ') });
      continue;
    }
    const current = await strategyPlugins().findOne({ ownerId, name });
    const next = parsed.data!;
    const action = !current
      ? 'create'
      : current.code === next.code &&
          (current.description ?? '') === (next.description ?? '') &&
          current.evaluatorVersion === next.evaluatorVersion
        ? 'unchanged'
        : 'update';
    prepared.push({ doc, existingId: current?._id, action });
    result.items.push({ kind: 'StrategyPlugin', name, action });
  }
  if (mode === 'replace' && pluginDocs.length) {
    const names = new Set(pluginDocs.map((d) => d.metadata.name));
    for (const p of await strategyPlugins()
      .find({ ownerId }, { projection: { name: 1 } })
      .toArray())
      if (!names.has(p.name)) {
        prepared.push({
          doc: { apiVersion: API_VERSION, kind: 'StrategyPlugin', metadata: { name: p.name }, spec: {} },
          existingId: p._id,
          action: 'remove',
        });
        result.items.push({ kind: 'StrategyPlugin', name: p.name, action: 'remove' });
      }
  }

  // Evaluations (#109): audit records, restored with their provenance and never re-run; immutable once stored.
  for (const doc of docs.filter((d) => d.kind === 'Evaluation')) {
    const name = doc.metadata.name;
    const problems = evaluationSpecProblems(doc.spec);
    if (problems.length) {
      result.errors.push({ kind: 'Evaluation', name, message: problems.join('; ') });
      continue;
    }
    const current = await evaluations().findOne({
      ownerId,
      $or: [{ _id: name }, { sourceId: name }],
    } as Record<string, unknown>);
    if (current && stableJson(evaluationSpec(current)) !== stableJson(doc.spec)) {
      result.errors.push({
        kind: 'Evaluation',
        name,
        message: 'Evaluations are immutable; this one differs',
      });
      continue;
    }
    prepared.push({ doc, action: current ? 'unchanged' : 'create' });
    result.items.push({ kind: 'Evaluation', name, action: current ? 'unchanged' : 'create' });
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
    // Transforms after syncs (they read sync outputs); producers before consumers (retry until ordered).
    const pendingT = prepared.filter(
      (x) => x.doc.kind === 'Transform' && (x.action === 'create' || x.action === 'update'),
    );
    for (let pass = 0; pendingT.length && pass <= pendingT.length + 1; pass++)
      for (const p of [...pendingT]) {
        try {
          const { history, ...spec } = p.doc.spec;
          const body = { ...spec, name: p.doc.metadata.name };
          if (p.existingId) await updateTransform(ownerId, p.existingId, body, principal.user._id);
          else {
            // History is restored only for transforms this import creates (an existing one keeps its own).
            const t = await createTransform(ownerId, body, principal.user._id);
            if (Array.isArray(history) && history.length)
              await restoreTransformHistory(
                ownerId,
                t._id,
                transformHistorySchema.parse(history) as TransformHistoryEntry[],
                principal.user._id,
              );
          }
          done.push({ kind: 'Transform', name: p.doc.metadata.name, action: p.action });
          pendingT.splice(pendingT.indexOf(p), 1);
        } catch (e) {
          if (!pendingT.length) throw e;
        }
      }
    if (pendingT.length)
      throw new HttpError(
        400,
        `Could not import transforms: ${pendingT.map((p) => p.doc.metadata.name).join(', ')}`,
      );
    for (const p of prepared.filter((x) => x.doc.kind === 'Transform' && x.action === 'remove')) {
      await deleteTransform(ownerId, p.existingId!);
      done.push({ kind: 'Transform', name: p.doc.metadata.name, action: 'remove' });
    }
    // Catalog docs last: their collections may be targets of the syncs just imported.
    for (const p of prepared.filter((x) => x.doc.kind === 'CatalogEntry' && x.action !== 'unchanged')) {
      const spec = p.doc.spec as CatalogCurated;
      await patchCatalogEntry(ownerId, p.doc.metadata.name, {
        description: spec.description,
        grain: spec.grain,
        fields: spec.fields ?? {},
        caveats: spec.caveats ?? [],
        dismissedCaveats: spec.dismissedCaveats ?? [],
      });
      done.push({ kind: 'CatalogEntry', name: p.doc.metadata.name, action: p.action });
    }
    // Pipelines after everything they reference.
    for (const p of prepared.filter((x) => x.doc.kind === 'Pipeline' && x.action !== 'unchanged')) {
      const body = { ...p.doc.spec, name: p.doc.metadata.name };
      if (p.action === 'remove') await deletePipeline(ownerId, p.existingId!);
      else if (p.existingId) await updatePipeline(ownerId, p.existingId, body, principal.user._id);
      else await createPipeline(ownerId, body, principal.user._id);
      done.push({ kind: 'Pipeline', name: p.doc.metadata.name, action: p.action });
    }
    // Strategy plugins: history is restored only for plugins this import creates.
    for (const p of prepared.filter((x) => x.doc.kind === 'StrategyPlugin' && x.action !== 'unchanged')) {
      const { history, hash: _h, ...spec } = p.doc.spec;
      const body = { ...spec, name: p.doc.metadata.name };
      if (p.action === 'remove') await deleteStrategyPlugin(ownerId, p.existingId!);
      else if (p.existingId) await updateStrategyPlugin(ownerId, p.existingId, body, principal.user._id);
      else {
        const created = await createStrategyPlugin(ownerId, body, principal.user._id);
        if (Array.isArray(history) && history.length)
          await restoreStrategyPluginHistory(
            ownerId,
            created._id,
            strategyPluginHistorySchema.parse(history) as StrategyPluginHistoryEntry[],
            principal.user._id,
          );
      }
      done.push({ kind: 'StrategyPlugin', name: p.doc.metadata.name, action: p.action });
    }
    for (const p of prepared.filter((x) => x.doc.kind === 'Evaluation' && x.action === 'create')) {
      const sp = p.doc.spec as ReturnType<typeof evaluationSpec>;
      const plugin = await strategyPlugins().findOne(
        { ownerId, name: sp.plugin },
        { projection: { _id: 1 } },
      );
      // Ids are global: a record imported from another workspace keeps its name as sourceId.
      const taken = await evaluations().findOne({ _id: p.doc.metadata.name }, { projection: { _id: 1 } });
      await evaluations().insertOne({
        _id: taken ? randomUUID() : p.doc.metadata.name,
        ...(taken ? { sourceId: p.doc.metadata.name } : {}),
        ownerId,
        pluginId: plugin?._id ?? '',
        pluginName: sp.plugin,
        pluginVersion: sp.pluginVersion,
        codeHash: sp.codeHash,
        ...(sp.theoryId ? { theoryId: sp.theoryId } : {}),
        mode: sp.mode,
        params: sp.params as Evaluation['params'],
        trial: sp.trial,
        status: sp.status,
        ...(sp.error ? { error: sp.error } : {}),
        ...(sp.record ? { record: sp.record } : {}),
        ...(sp.durationMs !== undefined ? { durationMs: sp.durationMs } : {}),
        createdAt: new Date(sp.createdAt),
        ...(sp.finishedAt ? { finishedAt: new Date(sp.finishedAt) } : {}),
        importedAt: new Date(),
      } as Evaluation);
      done.push({ kind: 'Evaluation', name: p.doc.metadata.name, action: 'create' });
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
  const withHistory = req.query.history === '1' || req.query.history === 'true';
  const { yaml } = await exportObjects(req.principal!.tenantId, kinds, names, { withHistory });
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
