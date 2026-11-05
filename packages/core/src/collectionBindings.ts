// Collection-scoped MongoDB tools (#148). An agent's MongoDB connection binding may name the collections it
// works with, each with permissions (read / insert / update / delete), optional limits (max rows, a field
// projection, a fixed filter), an as_of cut (the collection's point-in-time rule, as in #108) and approval for
// writes. The runtime enforces them on every call, never the prompt:
//
// - only tools for granted operations are offered; admin tools (drop, rename, create/drop index, create
//   collection) and database-wide tools are never offered through a binding;
// - `collection` becomes an enum of the bound collections, and each tool's description lists their fields;
// - calls to an unbound collection, or above the granted permission, are rejected with a correctable error;
// - aggregation stages that reach other collections ($lookup, $graphLookup, $unionWith) must stay in the bound
//   set with read, and $out / $merge need write on their target;
// - the fixed filter, field projection, row cap and as_of cut are added to every read (and the filter to every
//   update and delete).
// Without bindings, a MongoDB connection keeps today's database-wide grant.
import { HttpError } from './security.js';
import type { KnownAtRule } from './knownAt.js';

import {
  COLLECTION_PERMISSIONS,
  collectionBindingSchema,
  type CollectionBinding,
  type CollectionPermission,
} from './schema.js';
export { COLLECTION_PERMISSIONS, collectionBindingSchema, type CollectionBinding, type CollectionPermission };

type Op = CollectionPermission | 'admin';
/** The operation each MongoDB MCP tool performs. Tools not listed are never offered through a binding. */
export const MONGO_TOOL_OPS: Record<string, Op> = {
  find: 'read',
  aggregate: 'read',
  count: 'read',
  'collection-schema': 'read',
  'collection-indexes': 'read',
  'collection-storage-size': 'read',
  'insert-many': 'insert',
  'update-many': 'update',
  'delete-many': 'delete',
  'create-collection': 'admin',
  'create-index': 'admin',
  'drop-collection': 'admin',
  'drop-index': 'admin',
  'rename-collection': 'admin',
};
const FILTER_ARG: Record<string, string> = {
  find: 'filter',
  count: 'query',
  'update-many': 'filter',
  'delete-many': 'filter',
};
const WRITE_OPS = new Set<Op>(['insert', 'update', 'delete']);

export const bindingFor = (bindings: CollectionBinding[], name: unknown) =>
  typeof name === 'string' ? bindings.find((b) => b.name === name) : undefined;
const allows = (b: CollectionBinding | undefined, op: Op) =>
  !!b && op !== 'admin' && b.permissions.includes(op as CollectionPermission);

/** The tools a binding set offers: only granted operations, never admin or database-wide ones. */
export function scopedToolNames(requested: string[], bindings: CollectionBinding[]) {
  return requested.filter((name) => {
    const op = MONGO_TOOL_OPS[name];
    return op && op !== 'admin' && bindings.some((b) => allows(b, op));
  });
}

/** The tool schema with `collection` as an enum of the collections bound for its operation, and their fields. */
export function scopeToolSchema(
  name: string,
  schema: Record<string, any>,
  description: string,
  bindings: CollectionBinding[],
  fieldsOf: (collection: string) => string[] | undefined,
) {
  const op = MONGO_TOOL_OPS[name];
  const names = bindings.filter((b) => allows(b, op)).map((b) => b.name);
  const properties = { ...(schema.properties ?? {}) };
  if (properties.collection)
    properties.collection = { ...properties.collection, type: 'string', enum: names };
  const lines = bindings
    .filter((b) => allows(b, op))
    .map((b) => {
      const fields = b.fields ?? fieldsOf(b.name);
      return `- ${b.name} (${b.permissions.join(', ')}${b.enforceAsOf ? ', as_of enforced' : ''}${b.maxRows ? `, ≤ ${b.maxRows} rows` : ''})${fields?.length ? `: ${fields.slice(0, 60).join(', ')}` : ''}`;
    });
  return {
    inputSchema: { ...schema, properties },
    description:
      `${description}\nOnly these collections (call collection-schema or the research describe_collection tool for details):\n${lines.join('\n')}`.slice(
        0,
        3000,
      ),
  };
}

const STAGE_FROM = (stage: Record<string, any>): { op: Op; target?: string }[] => {
  const out: { op: Op; target?: string }[] = [];
  if (stage.$lookup) out.push({ op: 'read', target: stage.$lookup.from });
  if (stage.$graphLookup) out.push({ op: 'read', target: stage.$graphLookup.from });
  if (stage.$unionWith)
    out.push({
      op: 'read',
      target: typeof stage.$unionWith === 'string' ? stage.$unionWith : stage.$unionWith.coll,
    });
  if (stage.$out)
    out.push({ op: 'insert', target: typeof stage.$out === 'string' ? stage.$out : stage.$out.coll });
  if (stage.$merge)
    out.push({
      op: 'insert',
      target:
        typeof stage.$merge.into === 'string' ? stage.$merge.into : (stage.$merge.into?.coll ?? stage.$merge),
    });
  if (stage.$facet)
    for (const sub of Object.values(stage.$facet) as Record<string, any>[][])
      for (const s of sub ?? []) out.push(...STAGE_FROM(s));
  for (const k of ['$lookup', '$unionWith'])
    for (const s of (stage[k]?.pipeline ?? []) as Record<string, any>[]) out.push(...STAGE_FROM(s));
  return out;
};

/** Why a call is not allowed (a message the agent can act on), or undefined when it is. */
export function bindingProblem(name: string, args: Record<string, any>, bindings: CollectionBinding[]) {
  const op = MONGO_TOOL_OPS[name];
  const bound = bindings.map((b) => b.name).join(', ');
  if (!op || op === 'admin') return `${name} is not available through collection bindings`;
  const b = bindingFor(bindings, args?.collection);
  if (!b) return `Collection ${String(args?.collection)} is not bound to this agent; use one of: ${bound}`;
  if (!allows(b, op)) return `${b.name} is bound with ${b.permissions.join(', ')}; ${name} needs ${op}`;
  if (name === 'update-many' && args.upsert && !allows(b, 'insert'))
    return `An upsert into ${b.name} needs insert permission`;
  if (name === 'aggregate') {
    const pipeline = Array.isArray(args.pipeline) ? args.pipeline : [];
    for (const stage of pipeline) {
      if (!stage || typeof stage !== 'object') continue;
      for (const ref of STAGE_FROM(stage)) {
        const target = bindingFor(bindings, ref.target);
        if (!target)
          return `The pipeline reaches ${String(ref.target)}, which is not bound to this agent (bound: ${bound})`;
        // A join would bypass the other collection's own filter and as_of cut: refuse it.
        if (ref.op === 'read' && target.name !== b.name && (target.filter || target.enforceAsOf))
          return `${target.name} has a fixed filter or an as_of cut, so it cannot be joined into; query it on its own`;
        const needs = ref.op === 'insert' ? ['insert', 'update'] : ['read'];
        if (!needs.some((p) => target.permissions.includes(p as CollectionPermission)))
          return `${ref.op === 'insert' ? '$out/$merge' : 'This stage'} into ${target.name} needs ${needs.join(' or ')} permission`;
      }
    }
  }
  return undefined;
}

/** Writes that wait for a human because the binding asks for approval. */
export function needsBindingApproval(name: string, args: Record<string, any>, bindings: CollectionBinding[]) {
  const op = MONGO_TOOL_OPS[name];
  if (!WRITE_OPS.has(op)) {
    if (name !== 'aggregate') return false;
    // $out / $merge write too.
    return (Array.isArray(args?.pipeline) ? args.pipeline : []).some((s: Record<string, any>) =>
      STAGE_FROM(s ?? {}).some(
        (r) => r.op === 'insert' && bindingFor(bindings, r.target)?.approval === 'always',
      ),
    );
  }
  return bindingFor(bindings, args?.collection)?.approval === 'always';
}

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/**
 * A MongoDB filter keeping only rows known by `d` under `rule`. Conservative (it never lets a row through early,
 * and may hold back a few that are borderline), because MCP results cannot be post-filtered exactly.
 */
export function strictAsOfFilter(rule: KnownAtRule, d: string): Record<string, unknown> {
  const lt = (f: string, v: string) => ({ [f]: { $lt: v, $type: 'string', $ne: '' } });
  const lte = (f: string, v: string) => ({ [f]: { $lte: v, $type: 'string', $ne: '' } });
  switch (rule.type) {
    case 'asOf':
    case 'eod':
    case 'snapshot':
      return lte(rule.field, d);
    case 'timestamp':
      return rule.fallback
        ? {
            $or: [lt(rule.field, d), { $and: [{ [rule.field]: { $in: [null, ''] } }, lt(rule.fallback, d)] }],
          }
        : lt(rule.field, d);
    case 'nextSession':
      return lt(rule.field, d);
    case 'dayBefore':
      return lte(rule.field, d);
    case 'statement':
      // A real acceptance time before d, or a period that ended more than 90 days before d (covers the fallback).
      return {
        $or: [
          {
            $and: [
              lt('acceptedDate', d),
              { $expr: { $ne: [{ $substrCP: ['$acceptedDate', 0, 10] }, '$date'] } },
            ],
          },
          lte('date', addDays(d, -91)), // period end + 90 days is known at that close: usable the day after
        ],
      };
    case 'periodLag':
      return lte(rule.periodField, addDays(d, -rule.lagDays - 1));
    case 'current_only':
      return { _id: { $exists: false } };
  }
}

type Session = { asOf: string; ruleOf: (collection: string) => KnownAtRule | 'static' | undefined };
/** The arguments actually sent: fixed filter, as_of cut, projection and row cap applied. */
export function applyBinding(
  name: string,
  args: Record<string, any>,
  bindings: CollectionBinding[],
  session?: Session,
) {
  const b = bindingFor(bindings, args.collection)!;
  const out: Record<string, any> = { ...args };
  const extra: Record<string, unknown>[] = [];
  if (b.filter) extra.push(b.filter);
  const op = MONGO_TOOL_OPS[name];
  if (op === 'read' && b.enforceAsOf) {
    const rule = session?.ruleOf(b.name);
    if (!rule)
      throw new HttpError(
        400,
        `${b.name} has no known point-in-time rule, so as_of cannot be enforced; reads are blocked`,
      );
    if (rule !== 'static') extra.push(strictAsOfFilter(rule, session!.asOf));
  }
  const and = (user: unknown) =>
    extra.length ? { $and: [...(user && Object.keys(user as object).length ? [user] : []), ...extra] } : user;
  const key = FILTER_ARG[name];
  if (key && extra.length) out[key] = and(out[key] ?? {});
  if (name === 'find') {
    if (b.maxRows) out.limit = Math.min(Number(out.limit) || b.maxRows, b.maxRows);
    if (b.fields) {
      const asked = out.projection && typeof out.projection === 'object' ? Object.keys(out.projection) : [];
      const keep = asked.length ? b.fields.filter((f) => asked.includes(f)) : b.fields;
      out.projection = Object.fromEntries([...keep.map((f) => [f, 1]), ['_id', 0]]);
    }
  }
  if (name === 'aggregate') {
    const pipeline = Array.isArray(out.pipeline) ? [...out.pipeline] : [];
    out.pipeline = [
      ...(extra.length ? [{ $match: extra.length === 1 ? extra[0] : { $and: extra } }] : []),
      ...pipeline,
      ...(b.fields ? [{ $project: Object.fromEntries([...b.fields.map((f) => [f, 1]), ['_id', 0]]) }] : []),
      ...(b.maxRows ? [{ $limit: b.maxRows }] : []),
    ];
  }
  return out;
}
