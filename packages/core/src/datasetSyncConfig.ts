// YAML export/import of dataset sync *configurations* (the rows of the Datasets table). Never data,
// never secrets: the source connection is written by name and resolved on import.
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { collection } from './db.js';
import { HttpError } from './security.js';
import { catalogById } from './datasetCatalog.js';
import { datasetSyncInput, datasetSyncs, type DatasetSync, type DatasetSyncInput } from './datasetSync.js';

export const DATASET_SYNC_CONFIG_KIND = 'DatasetSyncs';
export const DATASET_SYNC_CONFIG_VERSION = 'stockharness/v1';

/** Config fields in the order they are written; everything else on a sync is server state. */
const FIELD_ORDER = [
  'name',
  'dataset',
  'connection',
  'enabled',
  'priority',
  'symbolsMode',
  'symbols',
  'preset',
  'from',
  'to',
  'targetCollection',
  'retentionDays',
  'params',
  'schedule',
] as const;

type ConnectionLite = { _id: string; name: string; kind: string; enabled?: boolean; url?: string };
const connectionsCol = () => collection<ConnectionLite & Record<string, unknown>>('connections');

/** A parsed file entry: config fields plus the connection *name* (undefined = workspace default). */
export type DatasetSyncConfigEntry = {
  /** Position in the file (0-based), for error messages. */
  index: number;
  connection?: string;
  /** A raw `connectionId` string (id or name) when no connection name is given. */
  connectionId?: string;
  config: Omit<DatasetSyncInput, 'connectionId'>;
};
export type DatasetSyncConfigError = { index: number; name?: string; message: string };

function connectionNameOf(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.connection === 'string' && raw.connection.trim()) return raw.connection.trim();
  const id = raw.connectionId;
  // deploy/config-io JSON: {"$ref": {"type": "connections", "name": "FMP"}}
  if (id && typeof id === 'object' && '$ref' in id) {
    const ref = (id as { $ref?: { name?: unknown } }).$ref;
    if (typeof ref?.name === 'string') return ref.name;
  }
  return undefined;
}

/**
 * Parse a YAML (or JSON) document into validated entries. Accepts `{ syncs: [...] }`, a bare list,
 * or the config-io JSON export. Pure: does not touch the database.
 */
export function parseDatasetSyncConfig(text: string): {
  entries: DatasetSyncConfigEntry[];
  errors: DatasetSyncConfigError[];
} {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    throw new HttpError(400, `Not valid YAML: ${(e as Error).message.split('\n')[0]}`);
  }
  const list = Array.isArray(doc)
    ? doc
    : doc && typeof doc === 'object' && Array.isArray((doc as { syncs?: unknown }).syncs)
      ? (doc as { syncs: unknown[] }).syncs
      : null;
  if (!list) throw new HttpError(400, 'Expected a `syncs:` list (or a top-level list of dataset syncs)');

  const entries: DatasetSyncConfigEntry[] = [];
  const errors: DatasetSyncConfigError[] = [];
  const seen = new Map<string, number>();
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ index, message: 'Entry is not a mapping' });
      return;
    }
    const raw = item as Record<string, unknown>;
    const name = typeof raw.name === 'string' ? raw.name : undefined;
    // Validate with a placeholder connection; the real one is resolved against the target install.
    const parsed = datasetSyncInput.safeParse({ ...raw, connectionId: 'resolved-on-import' });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors.push({ index, name, message: `${issue.path.join('.') || 'entry'}: ${issue.message}` });
      return;
    }
    const { connectionId: _ignored, ...config } = parsed.data;
    if (!catalogById.has(config.dataset)) {
      errors.push({ index, name, message: `Unknown dataset: ${config.dataset}` });
      return;
    }
    if (seen.has(config.name)) {
      errors.push({ index, name, message: `Duplicate name (also entry ${seen.get(config.name)! + 1})` });
      return;
    }
    seen.set(config.name, index);
    entries.push({
      index,
      connection: connectionNameOf(raw),
      connectionId: typeof raw.connectionId === 'string' ? raw.connectionId : undefined,
      config,
    });
  });
  return { entries, errors };
}

/** Normalise a stored sync to the exported shape (connection by name, config fields only). */
export function toConfigEntry(sync: DatasetSync, connectionName?: string) {
  const parsed = datasetSyncInput.parse(sync); // strips server state, applies defaults
  const out: Record<string, unknown> = { ...parsed, connection: connectionName };
  delete out.connectionId;
  const ordered: Record<string, unknown> = {};
  for (const key of FIELD_ORDER) if (out[key] !== undefined) ordered[key] = out[key];
  return ordered;
}

export async function exportDatasetSyncConfig(ownerId: string, ids?: string[]) {
  const filter = ids?.length ? { ownerId, _id: { $in: ids } } : { ownerId };
  // Oldest first so a re-import recreates the table in the same order.
  const syncs = await datasetSyncs().find(filter).sort({ createdAt: 1 }).toArray();
  const conns = await connectionsCol()
    .find({ ownerId }, { projection: { _id: 1, name: 1 } })
    .toArray();
  const nameById = new Map(conns.map((c) => [c._id, c.name]));
  const doc = {
    apiVersion: DATASET_SYNC_CONFIG_VERSION,
    kind: DATASET_SYNC_CONFIG_KIND,
    exportedAt: new Date().toISOString(),
    syncs: syncs.map((s) => toConfigEntry(s, nameById.get(s.connectionId))),
  };
  return {
    count: syncs.length,
    yaml:
      '# StockHarness dataset sync configuration. Import it from Datasets -> Import YAML.\n' +
      '# The connection is matched by name on import; secrets and synced data are not included.\n' +
      stringify(doc, { lineWidth: 0 }),
  };
}

export type DatasetSyncImportMode = 'merge' | 'replace';
export type DatasetSyncImportPlan = {
  mode: DatasetSyncImportMode;
  create: { name: string; dataset: string }[];
  update: { id: string; name: string; changed: string[] }[];
  unchanged: { id: string; name: string }[];
  /** replace only: syncs not in the file. Their collections are kept. */
  remove: { id: string; name: string }[];
  errors: DatasetSyncConfigError[];
};

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The default FMP connection, using the same rule as the Datasets editor. */
function defaultFmp(conns: ConnectionLite[]) {
  const mcp = conns.filter((c) => c.kind === 'mcp' && c.enabled !== false);
  return mcp.find((c) => /financialmodelingprep|fmp/i.test(`${c.name} ${c.url ?? ''}`)) ?? mcp[0];
}

async function plan(ownerId: string, text: string, mode: DatasetSyncImportMode) {
  const { entries, errors } = parseDatasetSyncConfig(text);
  const conns = (await connectionsCol()
    .find({ ownerId }, { projection: { _id: 1, name: 1, kind: 1, enabled: 1, url: 1 } })
    .toArray()) as ConnectionLite[];
  const existing = await datasetSyncs().find({ ownerId }).toArray();
  const byName = new Map<string, DatasetSync[]>();
  for (const s of existing) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);

  const result: DatasetSyncImportPlan = { mode, create: [], update: [], unchanged: [], remove: [], errors };
  const writes: { id?: string; body: DatasetSyncInput }[] = [];
  for (const entry of entries) {
    const { config, index } = entry;
    let conn: ConnectionLite | undefined;
    if (entry.connection) {
      const matches = conns.filter((c) => c.name === entry.connection);
      if (matches.length > 1) {
        result.errors.push({
          index,
          name: config.name,
          message: `Several connections named "${entry.connection}"`,
        });
        continue;
      }
      conn = matches[0];
      if (!conn) {
        result.errors.push({
          index,
          name: config.name,
          message: `No connection named "${entry.connection}" in this workspace`,
        });
        continue;
      }
    } else {
      const rawId = entry.connectionId;
      conn = (rawId && conns.find((c) => c._id === rawId || c.name === rawId)) || defaultFmp(conns);
      if (!conn) {
        result.errors.push({ index, name: config.name, message: 'No FMP connection to sync from' });
        continue;
      }
    }
    const body: DatasetSyncInput = { ...config, connectionId: conn._id };
    const same = byName.get(config.name) ?? [];
    if (same.length > 1) {
      result.errors.push({
        index,
        name: config.name,
        message: `${same.length} existing syncs share this name; rename them first`,
      });
      continue;
    }
    const current = same[0];
    if (!current) {
      result.create.push({ name: config.name, dataset: config.dataset });
      writes.push({ body });
      continue;
    }
    const currentConfig = datasetSyncInput.parse(current) as Record<string, unknown>;
    const fields = new Set([...Object.keys(currentConfig), ...Object.keys(body)]);
    const changed = [...fields].filter(
      (k) => !sameValue(currentConfig[k], (body as Record<string, unknown>)[k]),
    );
    if (changed.length) {
      result.update.push({ id: current._id, name: config.name, changed });
      writes.push({ id: current._id, body });
    } else result.unchanged.push({ id: current._id, name: config.name });
  }
  if (mode === 'replace') {
    const inFile = new Set(entries.map((e) => e.config.name));
    result.remove = existing.filter((s) => !inFile.has(s.name)).map((s) => ({ id: s._id, name: s.name }));
  }
  return { result, writes };
}

export async function planDatasetSyncImport(ownerId: string, text: string, mode: DatasetSyncImportMode) {
  return (await plan(ownerId, text, mode)).result;
}

/** Apply an import. Refuses (400, with the plan) when any entry has an error: all or nothing. */
export async function applyDatasetSyncImport(
  ownerId: string,
  text: string,
  mode: DatasetSyncImportMode,
  userId?: string,
) {
  const { result, writes } = await plan(ownerId, text, mode);
  if (result.errors.length) return { applied: false, plan: result };
  const now = new Date();
  for (const w of writes) {
    if (w.id)
      // Same as editing in the form: keep the cursor, re-seed the schedule.
      await datasetSyncs().updateOne(
        { _id: w.id, ownerId },
        { $set: { ...w.body, updatedAt: now }, $unset: { nextRunAt: '' } },
      );
    else
      await datasetSyncs().insertOne({
        ...w.body,
        _id: randomUUID(),
        ownerId,
        createdAt: now,
        updatedAt: now,
        createdBy: userId,
      });
  }
  if (result.remove.length)
    await datasetSyncs().deleteMany({ ownerId, _id: { $in: result.remove.map((r) => r.id) } });
  return { applied: true, plan: result };
}
