// Ingest validation (#83): every FMP response is checked before it is written. Error-shaped JSON fails the item;
// rows are compared with the collection's last known schema (the catalog): missing, added and type-changed
// fields and rising null rates are drift. Breaking drift (a key or date field missing or changing type) fails the
// item with a clear error instead of writing; other drift is written and recorded as an alert.
import { collection } from './db.js';
import { HttpError } from './security.js';

export type ExpectedField = { name: string; type: string; null_pct: number };
export type Drift = {
  kind: 'missing_field' | 'added_field' | 'type_change' | 'null_rate';
  field: string;
  detail: string;
  breaking: boolean;
};
/** Fields the sync adds itself, never compared with the payload. */
const OURS = new Set(['_id', '_hash', '_syncedAt', 'symbol', 'period', 'snapshot_date']);
const ERROR_KEYS = ['Error Message', 'error', 'Error', 'message'];

const typeOf = (v: unknown) =>
  typeof v === 'number'
    ? Number.isInteger(v)
      ? 'integer'
      : 'number'
    : typeof v === 'string'
      ? /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/.test(v)
        ? v.length > 10
          ? 'datetime'
          : 'date'
        : 'string'
      : typeof v === 'boolean'
        ? 'boolean'
        : Array.isArray(v)
          ? 'array'
          : v && typeof v === 'object'
            ? 'object'
            : 'null';
/** Types that are the same thing for drift purposes. */
const family = (t: string) =>
  t === 'integer' || t === 'number' ? 'number' : t === 'date' || t === 'datetime' ? 'date' : t;

/** An FMP error body (e.g. `{"Error Message": "Invalid API KEY."}`), as text, else undefined. */
export function errorShape(data: unknown): string | undefined {
  if (typeof data === 'string') return data.slice(0, 300);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const k = ERROR_KEYS.find((x) => typeof (data as Record<string, unknown>)[x] === 'string');
    if (k && Object.keys(data as object).length <= 3)
      return String((data as Record<string, unknown>)[k]).slice(0, 300);
  }
  return undefined;
}

/** Compare one response's rows with the expected schema (empty = no schema known yet: nothing to compare). */
export function validateRows(
  rows: Record<string, unknown>[],
  expected: ExpectedField[],
  opts: { keyFields: string[]; dateField?: string },
): Drift[] {
  if (!rows.length || !expected.length) return [];
  const known = new Map(expected.filter((f) => !OURS.has(f.name)).map((f) => [f.name, f]));
  const seen = new Map<string, { present: number; nonNull: number; types: Set<string> }>();
  for (const r of rows)
    for (const [k, v] of Object.entries(r)) {
      if (OURS.has(k)) continue;
      const s = seen.get(k) ?? { present: 0, nonNull: 0, types: new Set<string>() };
      s.present++;
      if (v !== null && v !== undefined && v !== '') {
        s.nonNull++;
        s.types.add(typeOf(v));
      }
      seen.set(k, s);
    }
  const critical = new Set([...opts.keyFields, ...(opts.dateField ? [opts.dateField] : [])]);
  const drift: Drift[] = [];
  for (const f of known.values()) {
    const s = seen.get(f.name);
    if (!s) {
      // Usually present before: now absent from every row.
      if (f.null_pct < 50)
        drift.push({
          kind: 'missing_field',
          field: f.name,
          detail: `absent from all ${rows.length} rows`,
          breaking: critical.has(f.name),
        });
      continue;
    }
    const was = family(f.type);
    const now = [...s.types].map(family);
    if (now.length && was !== 'null' && was !== 'mixed' && !now.includes(was))
      drift.push({
        kind: 'type_change',
        field: f.name,
        detail: `was ${f.type}, now ${[...s.types].join('/')}`,
        breaking: critical.has(f.name),
      });
    const nullPct = (1 - s.nonNull / rows.length) * 100;
    if (rows.length >= 20 && f.null_pct < 10 && nullPct > 50)
      drift.push({
        kind: 'null_rate',
        field: f.name,
        detail: `${Math.round(nullPct)}% null (was ${f.null_pct}%)`,
        breaking: false,
      });
  }
  for (const k of seen.keys())
    if (!known.has(k))
      drift.push({ kind: 'added_field', field: k, detail: 'new in the payload', breaking: false });
  return drift;
}

export type DriftAlert = {
  _id: string; // ownerId|collection|kind|field
  ownerId: string;
  collection: string;
  kind: Drift['kind'];
  field: string;
  detail: string;
  breaking: boolean;
  syncId?: string;
  syncName?: string;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolved: boolean;
};
export const driftAlerts = () => collection<DriftAlert>('schema_drift');

/** Record drift (idempotent per collection, kind and field; a resolved alert re-opens when it happens again). */
export async function recordDrift(
  ownerId: string,
  coll: string,
  drift: Drift[],
  sync?: { _id: string; name: string },
) {
  const now = new Date();
  for (const d of drift)
    await driftAlerts().updateOne(
      { _id: `${ownerId}|${coll}|${d.kind}|${d.field}` },
      {
        $set: {
          detail: d.detail,
          breaking: d.breaking,
          lastSeenAt: now,
          resolved: false,
          ...(sync ? { syncId: sync._id, syncName: sync.name } : {}),
        },
        $inc: { count: 1 },
        $setOnInsert: { ownerId, collection: coll, kind: d.kind, field: d.field, firstSeenAt: now },
      },
      { upsert: true },
    );
}

/**
 * A per-pull checker: validates each response against the schema known at the start of the pull, collects drift
 * (recorded once at the end), and throws (failing that item) on an error payload or breaking drift.
 */
export function ingestChecker(
  expected: ExpectedField[],
  opts: { collection: string; keyFields: string[]; dateField?: string },
) {
  const found = new Map<string, Drift>();
  return {
    check(data: unknown): unknown[] {
      const err = errorShape(data);
      if (err)
        throw new HttpError(502, `FMP returned an error instead of data for ${opts.collection}: ${err}`);
      const list = Array.isArray(data) ? data : data ? [data] : [];
      const rows = list.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
      const drift = validateRows(rows, expected, opts);
      for (const d of drift) found.set(`${d.kind}|${d.field}`, d);
      const breaking = drift.filter((d) => d.breaking);
      if (breaking.length)
        throw new HttpError(
          422,
          `Schema drift in ${opts.collection}, not written: ${breaking.map((d) => `${d.field} ${d.kind.replace('_', ' ')} (${d.detail})`).join('; ')}`,
        );
      return list;
    },
    drift: () => [...found.values()],
  };
}
