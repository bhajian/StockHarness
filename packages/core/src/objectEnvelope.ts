// "Everything is a YAML object" (#152): the envelope every exported object uses, plus the pure helpers
// for rendering, parsing (including legacy formats) and id <-> name reference rewriting.
import { parseAllDocuments, stringify } from 'yaml';
import { HttpError } from './security.js';

export const API_VERSION = 'stockharness/v1';
/** Object kinds in import (dependency) order: earlier kinds can be referenced by later ones. */
export const OBJECT_KINDS = ['Skill', 'Agent', 'Harness', 'DatasetSync', 'CatalogEntry'] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];
/**
 * Reference type names used in `{ $ref: { type, name } }`. Kept identical to the deploy/config-io CLI so its
 * existing exports import unchanged.
 */
export const REF_TYPE_BY_KIND: Record<ObjectKind, string> = {
  Skill: 'skills',
  Agent: 'agents',
  Harness: 'workflows',
  DatasetSync: 'datasetSyncs',
  CatalogEntry: 'catalog',
};
/** Referenceable types that are never exported (they hold secrets); they must already exist on the target. */
export const EXTERNAL_REF_TYPES = ['connections', 'providers', 'knowledge', 'guardrails'] as const;

export type ObjectDoc = {
  apiVersion: typeof API_VERSION;
  kind: ObjectKind;
  metadata: { name: string; version?: string; labels?: Record<string, string> };
  spec: Record<string, unknown>;
};
export type Ref = { $ref: { type: string; name: string } };

const isRef = (v: unknown): v is Ref =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === 1 &&
  '$ref' in v &&
  typeof (v as Ref).$ref?.type === 'string' &&
  typeof (v as Ref).$ref?.name === 'string';

/** Replace every string equal to a known id with `{ $ref: { type, name } }` (deep). */
export function toRefs(value: unknown, byId: Map<string, { type: string; name: string }>): unknown {
  if (typeof value === 'string') {
    const hit = byId.get(value);
    return hit ? { $ref: { ...hit } } : value;
  }
  if (Array.isArray(value)) return value.map((v) => toRefs(v, byId));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toRefs(v, byId)]));
  return value;
}

/**
 * Replace every `{ $ref }` (deep) using `resolve`, which returns the target id or undefined. Missing references are
 * collected (and left as placeholders) so a plan can report all of them at once.
 */
export function fromRefs(
  value: unknown,
  resolve: (type: string, name: string) => string | undefined,
  missing: { type: string; name: string }[] = [],
): unknown {
  if (isRef(value)) {
    const id = resolve(value.$ref.type, value.$ref.name);
    if (id === undefined) {
      missing.push({ ...value.$ref });
      return `missing:${value.$ref.type}:${value.$ref.name}`;
    }
    return id;
  }
  if (Array.isArray(value)) return value.map((v) => fromRefs(v, resolve, missing));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromRefs(v, resolve, missing)]));
  return value;
}

/** Collect the `{ $ref }`s inside a value (deep). */
export function refsIn(value: unknown, out: { type: string; name: string }[] = []) {
  if (isRef(value)) out.push({ ...value.$ref });
  else if (Array.isArray(value)) value.forEach((v) => refsIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => refsIn(v, out));
  return out;
}

const kindOrder = (k: ObjectKind) => OBJECT_KINDS.indexOf(k);
/** Deterministic multi-document YAML: kind order, then name. No volatile fields, so git diffs stay minimal. */
export function renderObjects(docs: ObjectDoc[]) {
  const sorted = [...docs].sort(
    (a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.metadata.name.localeCompare(b.metadata.name),
  );
  const header =
    '# StockHarness objects (apiVersion stockharness/v1). Import from Settings -> Configuration or the\n' +
    '# object list pages. References are by name; secrets and data rows are never included.\n';
  if (!sorted.length) return header;
  return header + sorted.map((d) => stringify(d, { lineWidth: 0 })).join('---\n');
}

export type LegacyKind = ObjectKind;
export type ParseResult = { docs: ObjectDoc[]; errors: { index: number; message: string }[] };

/**
 * Parse envelopes from YAML or JSON. Accepts one or more `stockharness/v1` objects (multi-document or
 * `kind: List`), the Datasets toolbar's `kind: DatasetSyncs` export, and the deploy/config-io files (a bare list,
 * whose kind is given by `legacyKind`).
 */
export function parseObjects(text: string, legacyKind?: LegacyKind): ParseResult {
  let raw: unknown[];
  try {
    raw = parseAllDocuments(text).map((d) => {
      if (d.errors.length) throw new Error(d.errors[0].message.split('\n')[0]);
      return d.toJSON();
    });
  } catch (e) {
    throw new HttpError(400, `Not valid YAML: ${(e as Error).message}`);
  }
  const docs: ObjectDoc[] = [];
  const errors: ParseResult['errors'] = [];
  const pushItem = (item: unknown, index: number, fallbackKind?: ObjectKind) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      return void errors.push({ index, message: 'Entry is not a mapping' });
    const o = item as Record<string, unknown>;
    if (o.apiVersion !== undefined || o.kind !== undefined) {
      if (o.apiVersion !== API_VERSION)
        return void errors.push({ index, message: `Unsupported apiVersion ${String(o.apiVersion)}` });
      if (!OBJECT_KINDS.includes(o.kind as ObjectKind))
        return void errors.push({ index, message: `Unknown kind ${String(o.kind)}` });
      const md = (o.metadata ?? {}) as Record<string, unknown>;
      if (typeof md.name !== 'string' || !md.name.trim())
        return void errors.push({ index, message: 'metadata.name is required' });
      if (!o.spec || typeof o.spec !== 'object' || Array.isArray(o.spec))
        return void errors.push({ index, message: 'spec must be a mapping' });
      return void docs.push({
        apiVersion: API_VERSION,
        kind: o.kind as ObjectKind,
        metadata: { name: md.name, ...(md.version ? { version: String(md.version) } : {}) },
        spec: o.spec as Record<string, unknown>,
      });
    }
    // Legacy flat object: { name, ...fields }.
    if (!fallbackKind)
      return void errors.push({ index, message: 'Not a stockharness/v1 object (missing apiVersion/kind)' });
    const { name, ...spec } = o;
    if (typeof name !== 'string' || !name.trim())
      return void errors.push({ index, message: 'name is required' });
    docs.push({ apiVersion: API_VERSION, kind: fallbackKind, metadata: { name }, spec });
  };
  let index = 0;
  for (const doc of raw) {
    if (doc === null || doc === undefined) continue;
    if (Array.isArray(doc)) {
      if (!legacyKind) {
        errors.push({
          index,
          message: 'A bare list needs its kind (legacyKind), e.g. a config-io export file',
        });
        index += doc.length;
        continue;
      }
      for (const item of doc) pushItem(item, index++, legacyKind);
      continue;
    }
    const o = doc as Record<string, unknown>;
    if (o.kind === 'List' && Array.isArray(o.items)) {
      for (const item of o.items) pushItem(item, index++);
      continue;
    }
    if (o.kind === 'DatasetSyncs' && Array.isArray(o.syncs)) {
      for (const item of o.syncs) pushItem(item, index++, 'DatasetSync');
      continue;
    }
    pushItem(doc, index++, legacyKind);
  }
  const seen = new Set<string>();
  docs.forEach((d, i) => {
    const key = `${d.kind}:${d.metadata.name}`;
    if (seen.has(key)) errors.push({ index: i, message: `Duplicate ${d.kind} named "${d.metadata.name}"` });
    seen.add(key);
  });
  return { docs, errors };
}

/** Stable JSON for change detection (sorted keys). */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

/** Field names whose values must never appear in an export. Used by the no-secrets check. */
export const SECRET_FIELD_PATTERN = /(Encrypted|apiKey|password|secretValue|token)"?\s*:/i;
