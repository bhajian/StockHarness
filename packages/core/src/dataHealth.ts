// Data health (#86): freshness of every collection (cadence + trading-day lag), coverage, DQ issues, caveats,
// a gap strip of the last N expected sessions (from the cached coverage, #87), syncs and transforms that failed,
// pipelines' latest runs, and the top-bar indicator (fresh / N late / Layer 2 blocked).
import { collection, mongo } from './db.js';
import { workspaceDatabase } from './mongoMcp.js';
import { catalogEntries, listCatalog, type CatalogEntry, type CatalogLayer } from './schemaCatalog.js';
import { freshnessOf, type Freshness } from './lineage.js';
import { datasetSyncs } from './datasetSync.js';
import { catalogById } from './datasetCatalog.js';

/** One expected session: its row count; `partial` when far below the usual count (#395). */
export type GapCell = { date: string; rows: number | null; partial?: boolean };
/** Logs written by the platform itself: not data with a cadence, sessions or gaps (#428). */
const LOGS = new Set(['dq_issues']);
/** A session with fewer rows than this share of the window's median is a partial gap (#395). */
const PARTIAL_SHARE = 0.5;
export type HealthRow = {
  collection: string;
  layer: CatalogLayer;
  freshness: Freshness;
  /** Expected sessions without data since the latest date (daily, dated collections). */
  lagSessions?: number;
  lastUpdated?: string;
  dateMax?: string;
  rows: number;
  coveragePct?: number;
  /** Open DQ issues; `research`: the part on rows in the research universe (#428). */
  dq: { error: number; warn: number; research?: { error: number; warn: number } };
  caveats: { blocking: number; warn: number };
  producer?: { type: string; name: string };
  error?: string;
  /** null = not computed yet (a daily series is computed in the background, #395). */
  gaps: GapCell[] | null;
  /** Whether a gap strip applies: daily observation series only (#395). */
  gapsApplicable: boolean;
  /** Missing (no rows) and partial sessions in the strip. */
  gapSummary?: { missing: number; partial: number };
  /** What coveragePct is measured against (#395). */
  coverageBasis?: 'active' | 'all';
  coverageSparse?: string;
};

/** The gap strip of one collection: sessions before today, with partial ones marked (pure; tested). */
export function gapCells(
  expected: string[],
  rowsByDate: Map<string, number | null>,
  today: string,
): GapCell[] {
  const cells = expected
    .filter((d) => d < today)
    .map((d) => ({ date: d, rows: (rowsByDate.get(d) as number | undefined) ?? 0 }));
  const counts = cells
    .map((c) => c.rows ?? 0)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  return cells.map((c) => (c.rows && c.rows < median * PARTIAL_SHARE ? { ...c, partial: true } : c));
}
export const gapSummary = (cells: GapCell[]) => ({
  missing: cells.filter((c) => !c.rows).length,
  partial: cells.filter((c) => c.partial).length,
});
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

/** Daily market series that are not `timeseries` datasets but still carry one row per business day. */
const DAILY_MARKET_SERIES = new Set(['treasury_rates', 'sector_performance']);

/**
 * Whether a collection is a daily observation series, the only kind judged by trading-session lag (#386):
 * Layer 1 time series (prices, index levels, rates) synced at least daily, and Layer 2 tables with one row per
 * trading day. Period-end data (statements, ratios, segments), monthly or quarterly macro, feeds (transaction or
 * disclosure dates) and weekly snapshots are not: their latest date says nothing about whether the sync is late,
 * so they are fresh when their producer last succeeded within its cadence.
 */
export function isDailySeries(
  e: Pick<CatalogEntry, 'layer' | 'grain' | 'timeSemantics' | 'producedBy'> & {
    primaryKey?: string[];
    collection?: string;
  },
  /** The producing sync's schedule interval (minutes), when it has an enabled schedule. */
  everyMinutes?: number,
) {
  if (e.collection && LOGS.has(e.collection)) return false;
  // Layer 2: documented as one row per trading day, or keyed by `date` (a user transform may not say, #409).
  if (e.layer === 2)
    return (
      e.timeSemantics.status !== 'static' &&
      (/trading (day|date)/i.test(e.grain) || Boolean(e.primaryKey?.includes('date')))
    );
  const def = catalogById.get(e.producedBy[0]?.dataset ?? '');
  if (!def || def.snapshotDated || def.scope === 'feed') return false;
  if (def.incremental !== 'timeseries' && !DAILY_MARKET_SERIES.has(def.id)) return false;
  return everyMinutes !== undefined && everyMinutes <= 1440;
}

export async function dataHealth(ownerId: string, opts: { days?: number } = {}) {
  const days = opts.days ?? 60;
  const expected = await sessions(ownerId, days);
  const entries = await listCatalog(ownerId);
  const dq = await mongo
    .db(workspaceDatabase(ownerId))
    .collection('dq_issues')
    .aggregate<{ _id: { c: string; s: string; u: boolean }; n: number }>([
      { $match: { resolved: { $ne: true } } },
      {
        $group: {
          _id: { c: '$collection', s: '$severity', u: { $eq: ['$in_universe', true] } },
          n: { $sum: 1 },
        },
      },
    ])
    .toArray()
    .catch(() => []);
  const dqBy = new Map<string, HealthRow['dq']>();
  for (const d of dq) {
    const x = dqBy.get(d._id.c) ?? { error: 0, warn: 0, research: { error: 0, warn: 0 } };
    const sev = d._id.s === 'error' ? 'error' : d._id.s === 'warn' ? 'warn' : undefined;
    if (sev) {
      x[sev] += d.n;
      if (d._id.u) x.research![sev] += d.n;
    }
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
  const syncDocs = await datasetSyncs()
    .find(
      { ownerId },
      { projection: { name: 1, enabled: 1, lastError: 1, lastRunAt: 1, nextRunAt: 1, schedule: 1 } },
    )
    .toArray();
  const everyMinutesOf = new Map(
    syncDocs.map((s) => [s._id, s.enabled && s.schedule?.enabled ? s.schedule.everyMinutes : undefined]),
  );
  const today = new Date().toISOString().slice(0, 10);
  const rows: HealthRow[] = entries.map((e) => {
    const cov = covs.get(e.collection);
    const producerId = e.producedBy[0]?.type === 'sync' ? e.producedBy[0].id : undefined;
    const daily = isDailySeries(e, producerId ? everyMinutesOf.get(producerId) : undefined);
    let gaps: GapCell[] | null = null;
    if (cov && daily && e.coverage.dateField) {
      const byDate = new Map(cov.daily.dates.map((d, i) => [d, cov.daily.series.rows?.[i] ?? null]));
      gaps = gapCells(expected, byDate, today);
    }
    let freshness = freshnessOf(e.freshness.lastUpdated, e.freshness.lastStatus, e.freshness.cadence);
    // Logs and on-demand outputs (DQ issues, simulation ledgers) have no schedule to be late on (#428).
    if (freshness === 'unknown' && (e.layer === 4 || LOGS.has(e.collection)) && e.coverage.rows)
      freshness = 'fresh';
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
      dq: dqBy.get(e.collection) ?? { error: 0, warn: 0, research: { error: 0, warn: 0 } },
      caveats: {
        blocking: e.caveats.filter((c) => c.severity === 'blocking').length,
        warn: e.caveats.filter((c) => c.severity === 'warn').length,
      },
      ...(e.producedBy[0] ? { producer: { type: e.producedBy[0].type, name: e.producedBy[0].name } } : {}),
      ...(e.freshness.lastError ? { error: e.freshness.lastError } : {}),
      gaps,
      gapsApplicable: Boolean(daily && e.coverage.dateField),
      ...(gaps ? { gapSummary: gapSummary(gaps) } : {}),
      ...(e.coverage.universeBasis ? { coverageBasis: e.coverage.universeBasis } : {}),
      ...(e.coverage.sparse ? { coverageSparse: e.coverage.sparse } : {}),
    };
  });
  const syncs = syncDocs.map((s) => ({
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
  const drift = await collection<{
    _id: string;
    collection: string;
    kind: string;
    field: string;
    detail: string;
    breaking: boolean;
    count: number;
    lastSeenAt: Date;
    syncName?: string;
  }>('schema_drift')
    .find({ ownerId, resolved: false })
    .sort({ lastSeenAt: -1 })
    .limit(100)
    .toArray();
  const kpis = {
    fresh: rows.filter((r) => r.freshness === 'fresh').length,
    stale: rows.filter((r) => r.freshness === 'stale').length,
    failed: rows.filter((r) => r.freshness === 'failed').length + failedTransforms.length,
    drift: drift.length,
    /** Open DQ errors on rows in the research universe (#428): what a strategy could actually read. */
    dqResearchErrors: rows.reduce((n, r) => n + (r.dq.research?.error ?? 0), 0),
    /** Daily series with a missing or partial session in the strip (#395). */
    gaps: rows.filter((r) => r.gapSummary && (r.gapSummary.missing || r.gapSummary.partial)).length,
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
    drift: drift.map(({ _id, ...d }) => ({ id: _id, ...d })),
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

/**
 * Keeps every daily series' gap strip current (#395): on the dispatcher tick, at most every few minutes, recompute
 * the coverage of daily observation series whose data changed since it was last computed (or that have none),
 * one collection at a time, at most every two hours each (a daily series changes once a day).
 */
const SWEEP_EVERY_MS = 5 * 60_000;
const RECOMPUTE_AFTER_MS = 2 * 3600_000;
let sweeping = false;
let lastSweep = 0;
export async function dispatchDailyCoverage(now = Date.now()) {
  if (sweeping || now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  sweeping = true;
  void sweepDailyCoverage()
    .catch((e) => console.warn('Coverage sweep will retry:', e instanceof Error ? e.message : e))
    .finally(() => {
      sweeping = false;
    });
}

/** The daily series of one workspace whose gap strip is missing or out of date (exported for tests). */
export async function staleDailyCoverage(ownerId: string, now = Date.now()) {
  const entries = await listCatalog(ownerId);
  const syncDocs = await datasetSyncs()
    .find({ ownerId }, { projection: { enabled: 1, schedule: 1 } })
    .toArray();
  const everyMinutesOf = new Map(
    syncDocs.map((s) => [s._id, s.enabled && s.schedule?.enabled ? s.schedule.everyMinutes : undefined]),
  );
  const computed = new Map(
    (
      await collection<{ _id: string; collection: string; computedAt: Date }>('catalog_coverage')
        .find({ ownerId }, { projection: { collection: 1, computedAt: 1 } })
        .toArray()
    ).map((c) => [c.collection, c.computedAt]),
  );
  return entries
    .filter((e) => {
      if (!e.coverage.dateField || !e.coverage.rows) return false;
      const producerId = e.producedBy[0]?.type === 'sync' ? e.producedBy[0].id : undefined;
      if (!isDailySeries(e, producerId ? everyMinutesOf.get(producerId) : undefined)) return false;
      const at = computed.get(e.collection);
      if (!at) return true;
      const updated = e.freshness.lastUpdated ? new Date(e.freshness.lastUpdated).getTime() : 0;
      return updated > at.getTime() && now - at.getTime() > RECOMPUTE_AFTER_MS;
    })
    .map((e) => e.collection);
}

async function sweepDailyCoverage() {
  const { collectionCoverage, coverageSettled } = await import('./catalogCoverage.js');
  const owners = (await collection('dataset_catalog').distinct('ownerId')) as string[];
  for (const ownerId of owners)
    await stampDqRelevance(ownerId).catch((e) => console.warn('DQ relevance:', e));
  for (const ownerId of owners)
    for (const name of await staleDailyCoverage(ownerId)) {
      await collectionCoverage(ownerId, name, { refresh: true });
      await coverageSettled(ownerId, name);
    }
}

/**
 * Stamps open DQ issues with `in_universe` (#428): for prices_daily, whether the security was in the research
 * universe on that date; for other security-keyed outputs, whether it ever was. Unstamped issues are done first;
 * everything is re-stamped once universe_daily has been rebuilt since the last stamp.
 */
export async function stampDqRelevance(ownerId: string, batch = 5000) {
  const db = mongo.db(workspaceDatabase(ownerId));
  const issues = db.collection('dq_issues');
  const universe = await catalogEntryUpdatedAt(ownerId, 'universe_daily');
  if (!universe) return 0;
  const stale = {
    resolved: { $ne: true },
    security_id: { $type: 'string' },
    $or: [{ in_universe_at: { $exists: false } }, { in_universe_at: { $lt: universe } }],
  };
  const ever = new Set(
    (await db.collection('universe_daily').distinct('security_id', { in_universe: true })) as string[],
  );
  let stamped = 0;
  for (;;) {
    const page = await issues
      .find(stale, { projection: { _id: 1, collection: 1, security_id: 1, date: 1 } })
      .limit(batch)
      .toArray();
    if (!page.length) break;
    const daily = page.filter((i) => i.collection === 'prices_daily' && typeof i.date === 'string');
    const members = new Set<string>();
    if (daily.length) {
      const found = await db
        .collection('universe_daily')
        .find(
          { $or: daily.map((i) => ({ security_id: i.security_id, date: i.date })), in_universe: true },
          { projection: { _id: 0, security_id: 1, date: 1 } },
        )
        .toArray();
      for (const f of found) members.add(`${f.security_id}|${f.date}`);
    }
    const now = new Date();
    const ops = page.map((i) => ({
      updateOne: {
        filter: { _id: i._id },
        update: {
          $set: {
            in_universe:
              i.collection === 'prices_daily' && typeof i.date === 'string'
                ? members.has(`${i.security_id}|${i.date}`)
                : ever.has(String(i.security_id)),
            in_universe_at: now,
          },
        },
      },
    }));
    await issues.bulkWrite(ops, { ordered: false });
    stamped += page.length;
  }
  return stamped;
}

async function catalogEntryUpdatedAt(ownerId: string, name: string) {
  const e = await catalogEntries().findOne(
    { ownerId, collection: name },
    { projection: { 'freshness.lastUpdated': 1 } },
  );
  return e?.freshness?.lastUpdated ? new Date(e.freshness.lastUpdated) : undefined;
}
