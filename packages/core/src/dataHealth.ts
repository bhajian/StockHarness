// Data health (#86): freshness of every collection (cadence + trading-day lag), coverage, DQ issues, caveats,
// a gap strip of the last N expected sessions (from the cached coverage, #87), syncs and transforms that failed,
// pipelines' latest runs, and the top-bar indicator (fresh / N late / Layer 2 blocked).
import { collection, mongo } from './db.js';
import { workspaceDatabase } from './mongoMcp.js';
import { listCatalog } from './schemaCatalog.js';
import { freshnessOf, type Freshness } from './lineage.js';
import { datasetSyncs } from './datasetSync.js';

export type GapCell = { date: string; rows: number | null };
export type HealthRow = {
  collection: string;
  layer: 1 | 2 | null;
  freshness: Freshness;
  /** Expected sessions without data since the latest date (daily, dated collections). */
  lagSessions?: number;
  lastUpdated?: string;
  dateMax?: string;
  rows: number;
  coveragePct?: number;
  dq: { error: number; warn: number };
  caveats: { blocking: number; warn: number };
  producer?: { type: string; name: string };
  error?: string;
  /** null = coverage not computed yet (Catalog > Coverage computes it). */
  gaps: GapCell[] | null;
};
const iso = (d: unknown) =>
  d instanceof Date ? d.toISOString().slice(0, 10) : typeof d === 'string' ? d.slice(0, 10) : undefined;

/** Expected NYSE sessions up to today, newest last (trading_calendar), else weekdays. */
async function sessions(ownerId: string, days: number) {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - days * 1.6 * 86400000).toISOString().slice(0, 10);
  const cal = await mongo
    .db(workspaceDatabase(ownerId))
    .collection('trading_calendar')
    .find({}, { projection: { date: 1, _id: 0 } })
    .sort({ date: -1 })
    .limit(Math.ceil(days * 2) + 400)
    .toArray()
    .catch(() => []);
  let out = cal.map((r) => iso(r.date)!).filter((d) => d && d >= from && d <= today);
  if (!out.length) {
    out = [];
    for (let t = Date.now(); out.length < days; t -= 86400000) {
      const d = new Date(t);
      if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
    }
  }
  return [...new Set(out)].sort().slice(-days);
}

/** Missing sessions after the latest date: 0 when the last expected session has data. */
export function lagSessions(
  expected: string[],
  dateMax: string | undefined,
  today = new Date().toISOString().slice(0, 10),
) {
  if (!dateMax) return undefined;
  // Today's session counts only after it has closed; be lenient and ignore today.
  return expected.filter((d) => d > dateMax && d < today).length;
}

export async function dataHealth(ownerId: string, opts: { days?: number } = {}) {
  const days = opts.days ?? 60;
  const expected = await sessions(ownerId, days);
  const entries = await listCatalog(ownerId);
  const dq = await mongo
    .db(workspaceDatabase(ownerId))
    .collection('dq_issues')
    .aggregate<{ _id: { c: string; s: string }; n: number }>([
      { $match: { resolved: { $ne: true } } },
      { $group: { _id: { c: '$collection', s: '$severity' }, n: { $sum: 1 } } },
    ])
    .toArray()
    .catch(() => []);
  const dqBy = new Map<string, { error: number; warn: number }>();
  for (const d of dq) {
    const x = dqBy.get(d._id.c) ?? { error: 0, warn: 0 };
    if (d._id.s === 'error') x.error += d.n;
    else if (d._id.s === 'warn') x.warn += d.n;
    dqBy.set(d._id.c, x);
  }
  const covs = new Map(
    (
      await collection<{
        _id: string;
        collection: string;
        daily: { dates: string[]; series: Record<string, (number | null)[]> };
      }>('catalog_coverage')
        .find({ ownerId }, { projection: { collection: 1, daily: 1 } })
        .toArray()
    ).map((c) => [c.collection, c]),
  );
  const rows: HealthRow[] = entries.map((e) => {
    const cov = covs.get(e.collection);
    let gaps: GapCell[] | null = null;
    if (cov) {
      const byDate = new Map(cov.daily.dates.map((d, i) => [d, cov.daily.series.rows?.[i] ?? null]));
      gaps = expected.map((d) => ({ date: d, rows: (byDate.get(d) as number | undefined) ?? 0 }));
    }
    let freshness = freshnessOf(e.freshness.lastUpdated, e.freshness.lastStatus, e.freshness.cadence);
    const daily = /day|daily|after/i.test(e.freshness.cadence ?? '') && e.timeSemantics.status !== 'static';
    const lag = e.coverage.dateField && daily ? lagSessions(expected, e.coverage.dateMax) : undefined;
    if (freshness === 'fresh' && lag !== undefined && lag > 3) freshness = 'stale';
    return {
      collection: e.collection,
      layer: e.layer,
      freshness,
      ...(lag !== undefined ? { lagSessions: lag } : {}),
      ...(e.freshness.lastUpdated ? { lastUpdated: new Date(e.freshness.lastUpdated).toISOString() } : {}),
      ...(e.coverage.dateMax ? { dateMax: e.coverage.dateMax } : {}),
      rows: e.coverage.rows,
      ...(e.coverage.universeCoveragePct !== undefined
        ? { coveragePct: e.coverage.universeCoveragePct }
        : {}),
      dq: dqBy.get(e.collection) ?? { error: 0, warn: 0 },
      caveats: {
        blocking: e.caveats.filter((c) => c.severity === 'blocking').length,
        warn: e.caveats.filter((c) => c.severity === 'warn').length,
      },
      ...(e.producedBy[0] ? { producer: { type: e.producedBy[0].type, name: e.producedBy[0].name } } : {}),
      ...(e.freshness.lastError ? { error: e.freshness.lastError } : {}),
      gaps,
    };
  });
  const syncs = (
    await datasetSyncs()
      .find({ ownerId }, { projection: { name: 1, enabled: 1, lastError: 1, lastRunAt: 1, nextRunAt: 1 } })
      .toArray()
  ).map((s) => ({
    id: s._id,
    name: s.name,
    enabled: s.enabled,
    lastRunAt: s.lastRunAt,
    nextRunAt: s.nextRunAt,
    error: s.lastError,
  }));
  // Late = enabled with a next run more than an hour in the past (the dispatcher should have started it).
  const late = syncs.filter((s) => s.enabled && s.nextRunAt && s.nextRunAt.getTime() < Date.now() - 3600_000);
  const tRuns = await collection<{
    _id: string;
    transformName: string;
    status: string;
    error?: string;
    finishedAt?: Date;
    createdAt: Date;
    transformId: string;
  }>('transform_runs')
    .aggregate<{
      _id: string;
      run: { transformName: string; status: string; error?: string; finishedAt?: Date };
    }>([
      { $match: { ownerId, status: { $in: ['succeeded', 'failed'] } } },
      { $sort: { createdAt: -1 } },
      { $project: { stdout: 0, stderr: 0 } },
      { $group: { _id: '$transformId', run: { $first: '$$ROOT' } } },
    ])
    .toArray();
  const transforms = tRuns.map((r) => ({
    name: r.run.transformName,
    status: r.run.status,
    error: r.run.error,
    finishedAt: r.run.finishedAt,
  }));
  const pRuns = await collection<{
    _id: string;
    pipelineName: string;
    pipelineId: string;
    status: string;
    period: { id: string };
    nodes: Record<string, { status: string }>;
    createdAt: Date;
  }>('pipeline_runs')
    .aggregate<{
      _id: string;
      run: {
        _id: string;
        pipelineName: string;
        status: string;
        period: { id: string };
        nodes: Record<string, { status: string }>;
      };
    }>([
      { $match: { ownerId } },
      { $sort: { createdAt: -1 } },
      { $project: { graph: 0 } },
      { $group: { _id: '$pipelineId', run: { $first: '$$ROOT' } } },
    ])
    .toArray();
  const pipelines = pRuns.map((p) => {
    const stuck = Object.entries(p.run.nodes).find(([, n]) =>
      ['blocked', 'gate_failed', 'failed'].includes(n.status),
    );
    return {
      name: p.run.pipelineName,
      runId: p.run._id,
      period: p.run.period.id,
      status: p.run.status,
      ...(stuck ? { blockedAt: stuck[0], blockedStatus: stuck[1].status } : {}),
    };
  });
  const blocked = pipelines.filter((p) => p.blockedAt) as { name: string; blockedAt: string }[];
  const failedTransforms = transforms.filter((t) => t.status === 'failed');
  const kpis = {
    fresh: rows.filter((r) => r.freshness === 'fresh').length,
    stale: rows.filter((r) => r.freshness === 'stale').length,
    failed: rows.filter((r) => r.freshness === 'failed').length + failedTransforms.length,
    drift: 0, // schema drift detection: #83
  };
  const eod =
    rows.find((r) => r.collection === 'prices_daily' && r.dateMax) ??
    rows.find((r) => r.collection === 'eod_prices' && r.dateMax);
  const indicator =
    blocked.length || failedTransforms.length
      ? {
          level: 'red' as const,
          text: blocked.length
            ? `Layer 2 blocked at ${blocked[0].name} › ${blocked[0].blockedAt}`
            : `Layer 2 blocked: ${failedTransforms[0].name} failed`,
        }
      : late.length || kpis.stale
        ? {
            level: 'amber' as const,
            text: late.length
              ? `${late.length} sync${late.length === 1 ? '' : 's'} late`
              : `${kpis.stale} collection${kpis.stale === 1 ? '' : 's'} stale`,
          }
        : {
            level: 'green' as const,
            text: eod?.dateMax ? `Data fresh as of ${eod.dateMax.slice(0, 10)} close` : 'Data fresh',
          };
  return {
    kpis,
    indicator,
    expected,
    collections: rows,
    syncs: {
      total: syncs.length,
      late: late.map((s) => s.name),
      failed: syncs.filter((s) => s.error).map((s) => ({ name: s.name, error: s.error })),
    },
    transforms,
    pipelines,
  };
}
