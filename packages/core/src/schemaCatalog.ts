// Schema Catalog v1 (#84): one machine-readable entry per workspace collection, so agents know what data
// exists, what fields mean, when rows became known, and how complete the data is. Auto-refreshed after
// every sync run; curated docs (descriptions, units, caveats) are edited separately and never overwritten.
import { mongo, collection } from './db.js';
import { workspaceDatabase } from './mongoMcp.js';
import { safeError } from './security.js';
import { describeSchedule } from './schedule.js';
import { catalogById, DATASET_CATALOG, UNIVERSE_COLLECTION, type DatasetDef } from './datasetCatalog.js';
import { KNOWN_AT, describeKnownAt, type KnownAtRule } from './knownAt.js';
import { FIELD_DOCS } from './fieldDocs.js';
import type { DatasetSync } from './datasetSync.js';

export type FieldType =
  'string' | 'date' | 'datetime' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null' | 'mixed';
export type CatalogField = {
  name: string;
  type: FieldType;
  null_pct: number;
  min?: number | string;
  max?: number | string;
  example?: unknown;
  description?: string;
  unit?: string;
  /** Where the description comes from: curated (edited), dictionary (built-in), or none (undocumented). */
  doc: 'curated' | 'dictionary' | 'none';
};
export type CatalogCurated = {
  description?: string;
  grain?: string;
  fields?: Record<string, { description?: string; unit?: string }>;
};
export type CatalogEntry = {
  _id: string; // `${ownerId}:${collection}`
  ownerId: string;
  collection: string;
  layer: 1 | 2 | null;
  producedBy: { type: 'sync' | 'pipeline'; name: string; id?: string; dataset?: string }[];
  description: string;
  grain: string;
  primaryKey: string[];
  timeSemantics: {
    status: 'pit' | 'current_only' | 'static' | 'unknown';
    rule?: KnownAtRule;
    text: string;
    eventDate?: string;
  };
  fields: CatalogField[];
  coverage: {
    rows: number;
    symbols?: number;
    universeCoveragePct?: number;
    dateField?: string;
    dateMin?: string;
    dateMax?: string;
  };
  freshness: { cadence?: string; lastUpdated?: Date; lastStatus?: 'ok' | 'failed'; lastError?: string };
  joins: { to: string; on: string | string[] }[];
  curated?: CatalogCurated;
  docCompletenessPct: number;
  refreshedAt: Date;
  refreshError?: string;
};
export const catalogEntries = () => collection<CatalogEntry>('dataset_catalog');

/** The existing Layer 2 pipeline outputs (pipeline/layer2), until they become Transforms (M2). */
const LAYER2: Record<
  string,
  { name: string; description: string; grain: string; key: string[]; static?: boolean; dateField: string }
> = {
  trading_calendar: {
    name: 'build_trading_calendar',
    description: 'NYSE trading days with open/close times and neighbours.',
    grain: 'one row per calendar date',
    key: ['date'],
    static: true,
    dateField: 'date',
  },
  securities: {
    name: 'build_securities',
    description:
      'One row per security with its identifiers (ticker, CIK, CUSIP, ISIN) and sector/industry/exchange over time.',
    grain: 'one row per security_id',
    key: ['security_id'],
    dateField: 'ipo_date',
  },
  corporate_actions: {
    name: 'build_corporate_actions',
    description: 'Deduplicated splits and dividends, full history.',
    grain: 'one row per security_id, action and ex_date',
    key: ['security_id', 'action_type', 'ex_date'],
    dateField: 'ex_date',
  },
  prices_daily: {
    name: 'build_prices_daily',
    description: 'Split/dividend-adjusted daily prices with total returns and data-quality flags.',
    grain: 'one row per security_id per trading date',
    key: ['security_id', 'date'],
    dateField: 'date',
  },
  macro_daily: {
    name: 'build_macro_daily',
    description: 'Treasury curve, VIX, index levels and sector returns per trading date.',
    grain: 'one row per trading date',
    key: ['date'],
    dateField: 'date',
  },
  dq_issues: {
    name: 'pipeline',
    description: 'Data-quality log for Layer 2 transforms.',
    grain: 'one row per issue',
    key: ['collection', 'issue_type', 'security_id', 'date'],
    dateField: 'date',
  },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;
function typeOf(v: unknown): FieldType {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (v instanceof Date) return 'datetime';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') {
    // BSON Long / Decimal show up as objects; treat them as numbers.
    const t = (v as { _bsontype?: string })._bsontype;
    return t === 'Long' || t === 'Decimal128' || t === 'Double' || t === 'Int32' ? 'integer' : 'object';
  }
  if (typeof v === 'string') return DATE_RE.test(v) ? 'date' : DATETIME_RE.test(v) ? 'datetime' : 'string';
  return 'mixed';
}
const short = (v: unknown) => {
  if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const s = JSON.stringify(v);
    return s.length > 120 ? `${s.slice(0, 120)}…` : JSON.parse(s);
  }
  return v instanceof Date ? v.toISOString() : v;
};

/** Field stats from a sample of documents (pure; unit-tested). */
export function inferFields(docs: Record<string, unknown>[], curated?: CatalogCurated): CatalogField[] {
  const names = new Set<string>();
  for (const d of docs) for (const k of Object.keys(d)) if (k !== '_id') names.add(k);
  const fields: CatalogField[] = [];
  for (const name of names) {
    const values = docs.map((d) => d[name]);
    const present = values.filter((v) => v !== null && v !== undefined && v !== '');
    const types = new Set(present.map(typeOf));
    let type: FieldType = present.length ? (types.size === 1 ? [...types][0] : 'mixed') : 'null';
    if (types.size === 2 && types.has('integer') && types.has('number')) type = 'number';
    const field: CatalogField = {
      name,
      type,
      null_pct: docs.length ? Math.round((1 - present.length / docs.length) * 1000) / 10 : 0,
      doc: 'none',
    };
    if ((type === 'number' || type === 'integer') && present.length) {
      const nums = present.filter((v): v is number => typeof v === 'number');
      if (nums.length) Object.assign(field, { min: Math.min(...nums), max: Math.max(...nums) });
    }
    if ((type === 'date' || type === 'datetime') && present.length) {
      const strs = present.map((v) => (v instanceof Date ? v.toISOString() : String(v))).sort();
      Object.assign(field, { min: strs[0], max: strs[strs.length - 1] });
    }
    if (present.length) field.example = short(present[0]);
    const c = curated?.fields?.[name];
    const dict = FIELD_DOCS[name];
    if (c?.description)
      Object.assign(field, { description: c.description, unit: c.unit ?? dict?.unit, doc: 'curated' });
    else if (dict)
      Object.assign(field, {
        description: dict.description,
        ...(dict.unit ? { unit: dict.unit } : {}),
        doc: 'dictionary',
      });
    fields.push(field);
  }
  return fields.sort((a, b) => a.name.localeCompare(b.name));
}

const grainOf = (key: string[]) => `one row per ${key.join(' × ')}`;
/** Defs whose rows land in `name` (a sync's targetCollection override wins). */
function producersOf(name: string, syncs: DatasetSync[]) {
  return syncs.filter((s) => (s.targetCollection || catalogById.get(s.dataset)?.defaultCollection) === name);
}

/** Recompute one collection's entry (stats, coverage, freshness), keeping its curated docs. */
export async function refreshCatalogEntry(ownerId: string, name: string, syncs?: DatasetSync[]) {
  const db = mongo.db(workspaceDatabase(ownerId));
  const allSyncs = syncs ?? (await collection<DatasetSync>('dataset_syncs').find({ ownerId }).toArray());
  const prior = await catalogEntries().findOne({ _id: `${ownerId}:${name}` });
  const curated = prior?.curated;
  const coll = db.collection(name);
  const producers = producersOf(name, allSyncs);
  const def: DatasetDef | undefined =
    (producers[0] && catalogById.get(producers[0].dataset)) ||
    DATASET_CATALOG.find((d) => d.defaultCollection === name);
  const l2 = LAYER2[name];
  let refreshError: string | undefined;
  const timed = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      refreshError = safeError(e);
      return fallback;
    }
  };
  const rows = await timed(coll.estimatedDocumentCount(), 0);
  const sample = rows
    ? await timed(
        coll.aggregate<Record<string, unknown>>([{ $sample: { size: 300 } }], { maxTimeMS: 20000 }).toArray(),
        [],
      )
    : [];
  const fields = inferFields(sample, curated);
  const names = new Set(fields.map((f) => f.name));
  const symbolField = names.has('security_id') ? 'security_id' : names.has('symbol') ? 'symbol' : undefined;
  const rule: KnownAtRule | undefined = def ? KNOWN_AT[def.id] : undefined;
  const dateField =
    l2?.dateField ??
    def?.dateField ??
    (rule && 'field' in rule ? rule.field : undefined) ??
    (names.has('date') ? 'date' : undefined);

  const coverage: CatalogEntry['coverage'] = { rows };
  if (rows && symbolField) {
    const symbols = await timed(coll.distinct(symbolField, {}, { maxTimeMS: 20000 }), [] as unknown[]);
    coverage.symbols = symbols.length;
    if (def?.perSymbol && symbolField === 'symbol' && name !== UNIVERSE_COLLECTION) {
      const universe = new Set(
        await timed(
          db.collection(UNIVERSE_COLLECTION).distinct('symbol', {}, { maxTimeMS: 20000 }),
          [] as unknown[],
        ),
      );
      if (universe.size)
        coverage.universeCoveragePct =
          Math.round((symbols.filter((s) => universe.has(s)).length / universe.size) * 1000) / 10;
    }
  }
  if (rows && dateField && names.has(dateField)) {
    const [r] = await timed(
      coll
        .aggregate<{ min: unknown; max: unknown }>(
          [
            { $match: { [dateField]: { $nin: [null, ''] } } },
            { $group: { _id: null, min: { $min: `$${dateField}` }, max: { $max: `$${dateField}` } } },
          ],
          { maxTimeMS: 30000, allowDiskUse: true },
        )
        .toArray(),
      [],
    );
    if (r)
      Object.assign(coverage, {
        dateField,
        dateMin: short(r.min) as string,
        dateMax: short(r.max) as string,
      });
  }

  const lastRun = producers.reduce<DatasetSync | undefined>(
    (best, s) => (s.lastRunAt && (!best?.lastRunAt || s.lastRunAt > best.lastRunAt) ? s : best),
    undefined,
  );
  const timeSemantics: CatalogEntry['timeSemantics'] = l2
    ? l2.static
      ? { status: 'static', text: 'Static reference data (no point-in-time filter needed).' }
      : {
          status: 'pit',
          text: '`known_at` / `as_of_date` on every row; filter `as_of_date <= D`.',
          eventDate: l2.dateField,
        }
    : rule
      ? {
          status: rule.type === 'current_only' ? 'current_only' : 'pit',
          rule,
          text: describeKnownAt(rule),
          eventDate: def?.dateField,
        }
      : { status: 'unknown', text: 'No producer declares when rows became known; do not use for backtests.' };
  const joins: CatalogEntry['joins'] = [];
  if (symbolField === 'symbol')
    joins.push({ to: 'securities', on: 'symbol → identifiers(type ticker, valid_from/valid_to)' });
  if (symbolField === 'security_id' && name !== 'securities')
    joins.push({ to: 'securities', on: 'security_id' });
  if (name !== 'prices_daily' && symbolField === 'security_id' && names.has('date'))
    joins.push({ to: 'prices_daily', on: ['security_id', 'date'] });

  const documented = fields.filter((f) => f.doc !== 'none').length;
  const entry: Omit<CatalogEntry, '_id'> = {
    ownerId,
    collection: name,
    layer: l2 ? 2 : def ? 1 : null,
    producedBy: l2
      ? [{ type: 'pipeline', name: l2.name }]
      : producers.map((s) => ({ type: 'sync' as const, name: s.name, id: s._id, dataset: s.dataset })),
    description: curated?.description ?? l2?.description ?? def?.description ?? '',
    grain: curated?.grain ?? (l2 ? l2.grain : def ? grainOf(def.keyFields) : ''),
    primaryKey: l2?.key ?? def?.keyFields ?? [],
    timeSemantics,
    fields,
    coverage,
    freshness: {
      ...(producers[0]?.schedule ? { cadence: describeSchedule(producers[0].schedule) } : {}),
      ...(lastRun?.lastRunAt
        ? { lastUpdated: lastRun.lastRunAt, lastStatus: lastRun.lastError ? 'failed' : 'ok' }
        : {}),
      ...(lastRun?.lastError ? { lastError: lastRun.lastError } : {}),
    },
    joins,
    ...(curated ? { curated } : {}),
    docCompletenessPct: fields.length ? Math.round((documented / fields.length) * 100) : 0,
    refreshedAt: new Date(),
    ...(refreshError ? { refreshError } : {}),
  };
  await catalogEntries().replaceOne(
    { _id: `${ownerId}:${name}` },
    { _id: `${ownerId}:${name}`, ...entry } as CatalogEntry,
    { upsert: true },
  );
  return { _id: `${ownerId}:${name}`, ...entry } as CatalogEntry;
}

/** Refresh every collection in the workspace plus every sync target (even if still empty). */
export async function refreshCatalog(ownerId: string) {
  const db = mongo.db(workspaceDatabase(ownerId));
  const syncs = await collection<DatasetSync>('dataset_syncs').find({ ownerId }).toArray();
  const existing = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'));
  const targets = syncs
    .map((s) => s.targetCollection || catalogById.get(s.dataset)?.defaultCollection)
    .filter(Boolean) as string[];
  const names = [...new Set([...existing, ...targets])].sort();
  for (const n of names) await refreshCatalogEntry(ownerId, n, syncs);
  // Entries for collections that no longer exist and are no sync's target are removed.
  await catalogEntries().deleteMany({ ownerId, collection: { $nin: names } });
  return names.length;
}

export async function listCatalog(ownerId: string) {
  return catalogEntries().find({ ownerId }).sort({ layer: 1, collection: 1 }).toArray();
}

/** Curated docs: description, grain, per-field description/unit. Never touched by refreshes. */
export async function patchCatalogEntry(ownerId: string, name: string, patch: CatalogCurated) {
  const id = `${ownerId}:${name}`;
  const prior = await catalogEntries().findOne({ _id: id });
  const curated: CatalogCurated = {
    ...(prior?.curated ?? {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.grain !== undefined ? { grain: patch.grain } : {}),
    fields: { ...(prior?.curated?.fields ?? {}), ...(patch.fields ?? {}) },
  };
  await catalogEntries().updateOne(
    { _id: id },
    { $set: { ownerId, collection: name, curated } },
    { upsert: true },
  );
  return refreshCatalogEntry(ownerId, name);
}

/** The compact form agents receive (describe_collection), with an approximate token count. */
export function agentView(e: CatalogEntry) {
  const lines = [
    `# ${e.collection} (layer ${e.layer ?? '?'})`,
    e.description,
    `Grain: ${e.grain || 'unknown'}. Key: ${e.primaryKey.join(', ') || 'none'}.`,
    `Point in time: ${e.timeSemantics.status === 'current_only' ? 'CURRENT ONLY (never use historically). ' : ''}${e.timeSemantics.text}`,
    `Coverage: ${e.coverage.rows.toLocaleString('en-US')} rows${e.coverage.symbols !== undefined ? `, ${e.coverage.symbols} symbols` : ''}${e.coverage.universeCoveragePct !== undefined ? ` (${e.coverage.universeCoveragePct}% of the universe)` : ''}${e.coverage.dateMin ? `, ${e.coverage.dateField} ${e.coverage.dateMin} → ${e.coverage.dateMax}` : ''}.`,
    ...(e.joins.length
      ? [
          `Joins: ${e.joins.map((j) => `${j.to} on ${Array.isArray(j.on) ? j.on.join(' + ') : j.on}`).join('; ')}.`,
        ]
      : []),
    'Fields:',
    ...e.fields.map(
      (f) =>
        `- ${f.name} (${f.type}${f.unit ? `, ${f.unit}` : ''})${f.description ? `: ${f.description}` : ''}${f.null_pct ? ` [${f.null_pct}% null]` : ''}`,
    ),
  ];
  const text = lines.join('\n');
  return { text, tokens: Math.ceil(text.length / 4) };
}

export function catalogMarkdown(entries: CatalogEntry[]) {
  return entries.map((e) => agentView(e).text).join('\n\n');
}
