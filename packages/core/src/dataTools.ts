// Research data tools (#108): list / describe / sample / query the workspace's collections with the session's
// as_of applied on the server. Served over MCP by the built-in research connection (apps/api/src/researchMcp.ts).
//
// - The session as_of is the connection's fixed date, or the latest trading date, and never later than the day
//   before the locked holdout (#105). A call may pass an earlier as_of, never a later one.
// - Each collection is cut by its point-in-time policy (pitPolicy.ts): Layer 2 `as_of_date`, Layer 1 known-at
//   rules, static data uncut; current-only and undocumented collections are refused unless the session is at
//   the latest date and there is no holdout.
// - Rows are limited (count and bytes), and server-side JavaScript operators are refused.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { collection, mongo } from './db.js';
import { config } from './config.js';
import { HttpError } from './security.js';
import { workspaceDatabase } from './mongoMcp.js';
import { agentView, listCatalog, type CatalogEntry } from './schemaCatalog.js';
import { coarseFilter, policyOf, ruleFields, visibleAt, type PitPolicy } from './pitPolicy.js';
import { evaluatorSettings, latestPriceDate } from './evaluations.js';
import { knownAtOf } from './knownAt.js';

export const MAX_ROWS = 500;
export const DEFAULT_ROWS = 50;
export const MAX_RESULT_BYTES = 256_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const BANNED = new Set(['$where', '$function', '$accumulator']);

export type DataSession = {
  ownerId: string;
  /** The effective as_of every read is cut at. */
  asOf: string;
  latest?: string;
  readableEnd?: string;
  /** The session sits at the latest date with no holdout: current-only data may be read. */
  current: boolean;
};

/** The session for a workspace and an optional fixed date (the research connection's `asOf`). */
export async function dataSession(ownerId: string, fixedAsOf?: string): Promise<DataSession> {
  const latest = await latestPriceDate(ownerId);
  const { readableEnd } = await evaluatorSettings(ownerId);
  const today = new Date().toISOString().slice(0, 10);
  const candidates = [fixedAsOf ?? latest ?? today, ...(readableEnd ? [readableEnd] : [])];
  const asOf = candidates.sort()[0];
  return { ownerId, asOf, latest, readableEnd, current: !readableEnd && !fixedAsOf };
}

function assertSafeFilter(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(assertSafeFilter);
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    if (BANNED.has(k)) throw new HttpError(400, `${k} is not allowed in a filter`);
    assertSafeFilter(v);
  }
}
const effectiveAsOf = (s: DataSession, requested?: unknown) => {
  if (requested === undefined || requested === null || requested === '') return s.asOf;
  if (typeof requested !== 'string' || !ISO.test(requested))
    throw new HttpError(400, 'as_of must be a date (YYYY-MM-DD)');
  return requested < s.asOf ? requested : s.asOf; // never later than the session
};

async function entryFor(ownerId: string, name: string) {
  const e = (await listCatalog(ownerId)).find((x) => x.collection === name);
  if (!e)
    throw new HttpError(
      404,
      `${name} is not in the Schema Catalog; call list_collections for the collections you can read`,
    );
  return e;
}
function readable(s: DataSession, e: CatalogEntry): PitPolicy {
  const p = policyOf(e);
  if (p.mode === 'refuse' && !(s.current && e.timeSemantics.status === 'current_only'))
    throw new HttpError(
      400,
      `${e.collection} cannot be read point-in-time: ${p.reason}. Use a collection with a known-at rule.`,
    );
  return p;
}

const clean = (row: Record<string, unknown>) => {
  const { _id, _hash, ...rest } = row;
  return rest;
};

export async function listCollections(s: DataSession) {
  const entries = await listCatalog(s.ownerId);
  return {
    as_of: s.asOf,
    ...(s.readableEnd ? { holdout_from: nextDay(s.readableEnd) } : {}),
    collections: entries.map((e) => {
      const p = policyOf(e);
      return {
        collection: e.collection,
        layer: e.layer,
        description: e.description.split(/(?<=\.)\s/)[0] ?? '',
        rows: e.coverage.rows,
        point_in_time: e.timeSemantics.status,
        readable: p.mode !== 'refuse' || (s.current && e.timeSemantics.status === 'current_only'),
        ...(p.mode === 'refuse' ? { reason: p.reason } : {}),
      };
    }),
  };
}
const nextDay = (iso: string) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/** The catalog's compact agent view (the same text as Catalog → Agent view), plus the session's cut. */
export async function describeCollection(s: DataSession, name: string) {
  const e = await entryFor(s.ownerId, name);
  const view = agentView(e);
  return { collection: name, as_of: s.asOf, text: view.text, tokens: view.tokens };
}

type QueryArgs = {
  collection: string;
  filter?: Record<string, unknown>;
  fields?: string[];
  sort?: Record<string, 1 | -1>;
  limit?: number;
  as_of?: string;
};
/** Rows visible at the session's (or an earlier) as_of. */
export async function queryCollection(s: DataSession, args: QueryArgs) {
  if (!args?.collection || typeof args.collection !== 'string')
    throw new HttpError(400, 'collection is required');
  const e = await entryFor(s.ownerId, args.collection);
  const p = readable(s, e);
  const asOf = effectiveAsOf(s, args.as_of);
  const filter = args.filter ?? {};
  if (typeof filter !== 'object' || Array.isArray(filter))
    throw new HttpError(400, 'filter must be an object');
  assertSafeFilter(filter);
  const limit = Math.min(
    MAX_ROWS,
    Math.max(1, Math.floor(Number(args.limit ?? DEFAULT_ROWS)) || DEFAULT_ROWS),
  );
  const fields = Array.isArray(args.fields)
    ? args.fields.filter((f) => typeof f === 'string').slice(0, 200)
    : [];
  const rule = p.mode === 'pit' ? p.rule : undefined;
  const query = rule ? { $and: [filter, coarseFilter(rule, asOf)] } : filter;
  const projection = fields.length
    ? Object.fromEntries([...fields, ...(rule ? ruleFields(rule) : [])].map((f) => [f, 1]))
    : undefined;
  const sort =
    args.sort && typeof args.sort === 'object'
      ? Object.fromEntries(
          Object.entries(args.sort)
            .filter(([, v]) => v === 1 || v === -1)
            .slice(0, 5),
        )
      : undefined;
  const coll = mongo.db(workspaceDatabase(s.ownerId)).collection(e.collection);
  // The coarse filter is exact for Layer 2; Layer 1 rules can over-fetch a little, so read a margin.
  const docs = await coll
    .find(query, { ...(projection ? { projection } : {}), ...(sort ? { sort } : {}), maxTimeMS: 30000 })
    .limit(rule && rule.type !== 'asOf' ? limit * 2 + 50 : limit)
    .toArray();
  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  let truncated = false;
  for (const d of docs) {
    if (rule && !visibleAt(rule, d, asOf)) continue;
    const r = clean(d);
    if (rule && rule.type !== 'asOf') r.as_of_date = knownAtOf(rule, d)!.as_of_date;
    const out = fields.length
      ? Object.fromEntries(Object.entries(r).filter(([k]) => fields.includes(k) || k === 'as_of_date'))
      : r;
    const size = JSON.stringify(out).length;
    if (bytes + size > MAX_RESULT_BYTES) {
      truncated = true;
      break;
    }
    bytes += size;
    rows.push(out);
    if (rows.length >= limit) break;
  }
  return {
    collection: e.collection,
    as_of: asOf,
    count: rows.length,
    ...(truncated || rows.length === limit ? { more: true } : {}),
    ...(truncated ? { note: `Stopped at ${MAX_RESULT_BYTES} bytes; ask for fewer fields or rows.` } : {}),
    rows,
  };
}

export async function sampleCollection(s: DataSession, name: string, n = 5) {
  const e = await entryFor(s.ownerId, name);
  const p = readable(s, e);
  const dateField =
    p.mode === 'pit'
      ? p.rule.type === 'statement'
        ? 'date'
        : p.rule.type === 'periodLag'
          ? p.rule.periodField
          : p.rule.type === 'current_only'
            ? undefined
            : p.rule.field
      : undefined;
  return queryCollection(s, {
    collection: name,
    limit: Math.min(20, Math.max(1, Number(n) || 5)),
    ...(dateField ? { sort: { [dateField]: -1 } } : {}),
  });
}

// --- tool definitions (MCP) --------------------------------------------------------------------------------
export const DATA_TOOLS = [
  {
    name: 'list_collections',
    description:
      'List the collections you can read, with their layer, size and point-in-time status. Every read is cut at the session as_of.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'describe_collection',
    description:
      'The Schema Catalog entry of one collection: description, grain, key, point-in-time rule, coverage, caveats, joins and every field with its type, unit and meaning. Read it before querying.',
    inputSchema: {
      type: 'object',
      properties: { collection: { type: 'string' } },
      required: ['collection'],
      additionalProperties: false,
    },
  },
  {
    name: 'sample_collection',
    description: 'The latest few rows of a collection that were known by the session as_of.',
    inputSchema: {
      type: 'object',
      properties: { collection: { type: 'string' }, n: { type: 'integer', minimum: 1, maximum: 20 } },
      required: ['collection'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_collection',
    description: `Rows of a collection known by the session as_of (applied on the server; as_of may only be earlier). filter is a MongoDB filter; fields limits the columns; sort is { field: 1 | -1 }; limit is at most ${MAX_ROWS}. Each row carries its as_of_date.`,
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        filter: { type: 'object' },
        fields: { type: 'array', items: { type: 'string' }, maxItems: 200 },
        sort: { type: 'object' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS },
        as_of: { type: 'string', description: 'YYYY-MM-DD, on or before the session as_of' },
      },
      required: ['collection'],
      additionalProperties: false,
    },
  },
] as const;

export async function callDataTool(s: DataSession, name: string, args: Record<string, unknown> = {}) {
  switch (name) {
    case 'list_collections':
      return listCollections(s);
    case 'describe_collection':
      return describeCollection(s, String(args.collection ?? ''));
    case 'sample_collection':
      return sampleCollection(s, String(args.collection ?? ''), Number(args.n ?? 5));
    case 'query_collection':
      return queryCollection(s, args as unknown as QueryArgs);
    default:
      throw new HttpError(404, `Unknown tool ${name}`);
  }
}

// --- the research connection's bearer token ------------------------------------------------------------------
const mac = (ownerId: string, connectionId: string) =>
  createHmac('sha256', Buffer.from(config.ENCRYPTION_KEY, 'hex'))
    .update(`research-mcp:${ownerId}:${connectionId}`)
    .digest('hex');
/** `ohrs.<connectionId>.<hmac>`: names the connection; the HMAC proves it was issued for its workspace. */
export const researchToken = (ownerId: string, connectionId: string) =>
  `ohrs.${connectionId}.${mac(ownerId, connectionId)}`;
/** The research connection a bearer token belongs to (undefined when it is not valid). */
export async function verifyResearchToken(token: string) {
  const m = /^ohrs\.([A-Za-z0-9-]{1,100})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return undefined;
  const conn = await collection<{
    _id: string;
    ownerId: string;
    kind?: string;
    enabled?: boolean;
    asOf?: string;
    role?: 'theorist' | 'judge' | 'coder';
  }>('connections').findOne({ _id: m[1], kind: 'research' });
  if (!conn || conn.enabled === false) return undefined;
  const expected = Buffer.from(mac(conn.ownerId, conn._id), 'hex');
  const got = Buffer.from(m[2], 'hex');
  return expected.length === got.length && timingSafeEqual(expected, got) ? conn : undefined;
}
/** Where the runtime reaches the research MCP server (the API, as the executor does). */
export const researchMcpUrl = () => `${config.EXECUTOR_CALLBACK_URL.replace(/\/$/, '')}/mcp/research`;
