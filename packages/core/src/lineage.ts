// Data lineage (#97): what feeds what. Dataset syncs -> collections -> transforms -> collections (a transform can
// fan out to several outputs), with freshness per node for the Catalog > Graph view.
import { collection } from './db.js';
import { catalogById } from './datasetCatalog.js';
import { datasetSyncs } from './datasetSync.js';
import { listCatalog } from './schemaCatalog.js';

export type Freshness = 'fresh' | 'stale' | 'failed' | 'unknown';
export type LineageNode = {
  id: string; // sync:<name> | collection:<name> | transform:<name>
  kind: 'sync' | 'collection' | 'transform';
  name: string;
  layer?: 1 | 2 | null;
  freshness: Freshness;
  rows?: number;
  lastRun?: { at?: string; status?: string; rows?: number; error?: string };
  enabled?: boolean;
  version?: number;
};
export type Lineage = { nodes: LineageNode[]; edges: { from: string; to: string }[] };

/** Days a source may go without an update before it is stale: from its schedule minutes or cadence text. */
export function staleAfterDays(cadence?: string | number) {
  if (typeof cadence === 'number') return Math.max(1, Math.ceil((cadence / 1440) * 2.5));
  if (!cadence) return 8;
  const days = /every (\d+) days/i.exec(cadence);
  if (days) return Number(days[1]) * 2 + 1;
  if (/hour|minute/i.test(cadence)) return 1;
  if (/week|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(cadence)) return 10;
  if (/month/i.test(cadence)) return 40;
  return 3; // daily and "after …" triggers
}
export function freshnessOf(
  lastUpdated: Date | string | undefined,
  lastStatus: string | undefined,
  cadence?: string | number,
  now = Date.now(),
): Freshness {
  if (lastStatus === 'failed') return 'failed';
  if (!lastUpdated) return 'unknown';
  const age = (now - new Date(lastUpdated).getTime()) / 86400000;
  return age > staleAfterDays(cadence) ? 'stale' : 'fresh';
}

export async function lineage(ownerId: string): Promise<Lineage> {
  const nodes = new Map<string, LineageNode>();
  const edges: Lineage['edges'] = [];
  const entries = await listCatalog(ownerId);
  for (const e of entries)
    nodes.set(`collection:${e.collection}`, {
      id: `collection:${e.collection}`,
      kind: 'collection',
      name: e.collection,
      layer: e.layer,
      rows: e.coverage.rows,
      freshness: freshnessOf(e.freshness.lastUpdated, e.freshness.lastStatus, e.freshness.cadence),
      ...(e.freshness.lastUpdated
        ? { lastRun: { at: new Date(e.freshness.lastUpdated).toISOString(), status: e.freshness.lastStatus } }
        : {}),
    });
  const coll = (name: string, layer: 1 | 2 | null) => {
    const id = `collection:${name}`;
    if (!nodes.has(id)) nodes.set(id, { id, kind: 'collection', name, layer, freshness: 'unknown' });
    return id;
  };
  for (const s of await datasetSyncs().find({ ownerId }).toArray()) {
    const id = `sync:${s.name}`;
    nodes.set(id, {
      id,
      kind: 'sync',
      name: s.name,
      enabled: s.enabled,
      freshness: freshnessOf(
        s.lastRunAt,
        s.lastError ? 'failed' : 'ok',
        s.schedule?.enabled ? s.schedule.everyMinutes : undefined,
      ),
      ...(s.lastRunAt
        ? {
            lastRun: {
              at: s.lastRunAt.toISOString(),
              status: s.lastError ? 'failed' : 'ok',
              ...(s.lastRows !== undefined ? { rows: s.lastRows } : {}),
              ...(s.lastError ? { error: s.lastError } : {}),
            },
          }
        : {}),
    });
    const target = s.targetCollection || catalogById.get(s.dataset)?.defaultCollection;
    if (target) edges.push({ from: id, to: coll(target, 1) });
  }
  const ts = await collection<{
    _id: string;
    name: string;
    version: number;
    enabled: boolean;
    inputs: string[];
    outputs: { collection: string }[];
  }>('transforms')
    .find({ ownerId }, { projection: { name: 1, version: 1, enabled: 1, inputs: 1, outputs: 1 } })
    .toArray();
  const runs = await collection<{
    _id: string;
    transformId: string;
    status: string;
    finishedAt?: Date;
    createdAt: Date;
    error?: string;
    outputs?: Record<string, { written?: number }>;
  }>('transform_runs')
    .aggregate<{
      _id: string;
      run: {
        status: string;
        finishedAt?: Date;
        createdAt: Date;
        error?: string;
        outputs?: Record<string, { written?: number }>;
      };
    }>([
      { $match: { ownerId } },
      { $sort: { createdAt: -1 } },
      { $project: { stdout: 0, stderr: 0 } },
      { $group: { _id: '$transformId', run: { $first: '$$ROOT' } } },
    ])
    .toArray();
  const lastBy = new Map(runs.map((r) => [r._id, r.run]));
  for (const t of ts) {
    const id = `transform:${t.name}`;
    const r = lastBy.get(t._id);
    nodes.set(id, {
      id,
      kind: 'transform',
      name: t.name,
      version: t.version,
      enabled: t.enabled,
      freshness: r
        ? freshnessOf(r.finishedAt ?? r.createdAt, r.status === 'failed' ? 'failed' : 'ok')
        : 'unknown',
      ...(r
        ? {
            lastRun: {
              at: (r.finishedAt ?? r.createdAt).toISOString(),
              status: r.status,
              rows: Object.values(r.outputs ?? {}).reduce((n, o) => n + (o.written ?? 0), 0),
              ...(r.error ? { error: r.error } : {}),
            },
          }
        : {}),
    });
    for (const i of t.inputs) edges.push({ from: coll(i, null), to: id });
    for (const o of t.outputs) edges.push({ from: id, to: coll(o.collection, 2) });
  }
  return { nodes: [...nodes.values()], edges };
}
