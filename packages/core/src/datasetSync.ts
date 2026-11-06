// Config-driven FMP -> workspace-MongoDB sync. Runs entirely in the backend (no harness,
// no Python). dispatchDatasetSyncs() fires due syncs from the shared server tick loop.
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { mongo, collection } from './db.js';
import { workspaceDatabase } from './mongoMcp.js';
import { ownedConnection } from './mcp.js';
import { nextScheduledAt } from './schedule.js';
import { HttpError, safeError } from './security.js';
import { scheduleSchema, type Stored } from './schema.js';
import { catalogById, UNIVERSE_DATASET_ID, presetById, type DatasetDef } from './datasetCatalog.js';
import { catalogEntries, refreshCatalogEntry } from './schemaCatalog.js';
import { ingestChecker, recordDrift } from './ingestValidation.js';
import { emitHarnessEvent } from './harnessEvents.js';
import {
  PriorityRateLimiter,
  SyncWorkQueue,
  SYNC_PRIORITIES,
  defaultPriority,
  type LimiterPriority,
  type SyncPriority,
} from './syncScheduler.js';

// The test stack points this at its FMP fixture (#83); production uses FMP.
const FMP_BASE = process.env.FMP_BASE_URL || 'https://financialmodelingprep.com/stable';
const MAX_RPM = Number(process.env.DATASET_SYNC_RPM) || 250;
/** One FMP rate limit for every sync in the process; the highest-priority waiter gets the next slot (#78). */
export const fmpLimiter = new PriorityRateLimiter(MAX_RPM);
/** Background sync runs: priority first, never twice at once, never blocking the dispatcher tick. */
export const syncQueue = new SyncWorkQueue(Math.max(1, Number(process.env.DATASET_SYNC_CONCURRENCY) || 3));
/** The priority of the sync whose code is running, so every FMP call it makes is scheduled at that priority. */
/** Per-pull context: the limiter priority and, for sync runs, a counter of FMP calls (#76). */
export const syncContext = new AsyncLocalStorage<{ priority: LimiterPriority; calls?: { n: number } }>();

export const datasetSyncInput = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  connectionId: z.string().min(1),
  dataset: z.string().min(1),
  symbolsMode: z.enum(['universe', 'list', 'preset']).default('universe'),
  symbols: z.array(z.string().min(1).max(20)).max(5000).optional(),
  preset: z.string().min(1).max(64).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  targetCollection: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,62}$/, 'Letters, digits and underscores')
    .optional(),
  retentionDays: z.number().int().min(1).max(36500).optional(),
  params: z.record(z.unknown()).optional(),
  /** Rows per symbol for limit-based datasets (statements, metrics, estimates); default: the dataset's limit (#77). */
  historyPeriods: z.number().int().min(1).max(200).optional(),
  /** Quarterly or annual statements, for datasets with a period parameter (#77). */
  statementPeriod: z.enum(['quarter', 'annual']).optional(),
  /** P0 prices / corporate actions / calendars, P1 fundamentals / estimates, P2 news / segments / peers. */
  priority: z.enum(SYNC_PRIORITIES).optional(),
  schedule: scheduleSchema,
  /**
   * Event triggers (#82): run after other syncs/transforms complete (`dataset:<collection>`, `transform:<name>`),
   * and/or N days after each company's earnings report, for just the reporting symbols.
   */
  trigger: z
    .object({
      after: z
        .array(
          z
            .string()
            .regex(
              /^(dataset|transform):[A-Za-z][A-Za-z0-9_]{0,62}$/,
              'dataset:<collection> or transform:<name>',
            ),
        )
        .max(20)
        .default([]),
      afterEarnings: z.object({ days: z.number().int().min(0).max(60) }).optional(),
    })
    .optional(),
});
export type DatasetSyncInput = z.infer<typeof datasetSyncInput>;

export type DatasetSync = DatasetSyncInput & {
  _id: string;
  ownerId: string;
  cursor?: string; // last synced date for timeseries datasets
  nextRunAt?: Date;
  lastRunAt?: Date;
  lastError?: string;
  /** Failed runs in a row, and whether the last one hit a plan limit (#291): drives the retry backoff. */
  consecutiveFailures?: number;
  lastFailureKind?: 'plan_limit' | 'error';
  /** Set when the scheduler paused the schedule after repeated plan-limit failures (#291). */
  pausedReason?: string;
  lastRows?: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
};
export type DatasetSyncRun = {
  _id: string;
  ownerId: string;
  syncId: string;
  scheduleKey?: string;
  trigger: 'schedule' | 'manual' | 'pipeline' | 'event';
  status: 'running' | 'succeeded' | 'failed';
  rows?: number;
  /** Universe coverage of a per-symbol run (pipeline gates, #156). */
  symbolsAttempted?: number;
  symbolsCovered?: number;
  /** FMP requests made (retries included) and the first per-symbol errors (#76). */
  calls?: number;
  symbolErrors?: { symbol: string; error: string }[];
  error?: string;
  startedAt: Date;
  finishedAt?: Date;
};

/** The sync's explicit priority, else its dataset's default. */
export const effectivePriority = (s: Pick<DatasetSync, 'dataset' | 'priority'>): SyncPriority =>
  s.priority ?? defaultPriority(s.dataset);

export const datasetSyncs = () => collection<DatasetSync>('dataset_syncs');
export const datasetSyncRuns = () => collection<DatasetSyncRun>('dataset_sync_runs');

export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (iso: string, days: number) =>
  new Date(new Date(iso + 'T00:00:00Z').getTime() + days * 86400000).toISOString().slice(0, 10);
export function chunkRanges(from: string, to: string, days: number): [string, string][] {
  const out: [string, string][] = [];
  let a = from;
  while (a <= to) {
    const b = addDays(a, days);
    out.push([a, b > to ? to : b]);
    a = addDays(b, 1);
  }
  return out;
}
const isTimeseries = (def: DatasetDef) => def.incremental === 'timeseries';

export async function fmpApiKey(ownerId: string, connectionId: string) {
  const connection = await ownedConnection(ownerId, connectionId);
  let key: string | null = null;
  try {
    key = new URL(connection.url).searchParams.get('apikey');
  } catch {
    key = null;
  }
  if (!key) throw new HttpError(400, 'The selected FMP connection has no apikey in its URL');
  return key;
}

/**
 * A limit of the FMP plan, not a failure (#291): FMP answers 402 with "Premium Query Parameter / Special Endpoint /
 * Special Parameters … not available under your current subscription" when a parameter value is outside the plan
 * (page > 0 on news feeds, an old `from` on calendars, a non-US `symbol`), and "Restricted Endpoint" when the
 * endpoint itself is not included. Never retried: retrying cannot change the answer.
 */
export class FmpPlanLimit extends HttpError {
  constructor(
    readonly endpoint: string,
    readonly param: string,
    detail: string,
  ) {
    super(
      402,
      param === 'endpoint'
        ? `FMP endpoint ${endpoint} is not in the current plan`
        : `FMP plan limit on ${endpoint}: this '${param}' value is not available on the current plan${detail ? ` (${detail})` : ''}`,
    );
  }
}
/** The plan limit a 402 body describes, or undefined for a throttle mislabelled 402. */
export function planLimitOf(endpoint: string, body: string): FmpPlanLimit | undefined {
  if (/restricted endpoint/i.test(body)) return new FmpPlanLimit(endpoint, 'endpoint', '');
  if (
    !/premium query parameter|special endpoint|special parameters|not available under your current subscription/i.test(
      body,
    )
  )
    return undefined;
  const param = /(?:values? (?:set )?for|values for) '([a-zA-Z_]+)'/i.exec(body)?.[1] ?? 'parameter';
  const detail = /can only be ([^\s.]+)/i.exec(body)?.[1];
  return new FmpPlanLimit(endpoint, param, detail ? `it can only be ${detail.trim()}` : '');
}

export async function fmpGet(
  endpoint: string,
  params: Record<string, string | number>,
  apikey: string,
): Promise<unknown> {
  const query = new URLSearchParams({ ...objToStr(params), apikey });
  const url = `${FMP_BASE}/${endpoint}?${query.toString()}`;
  let lastErr: unknown;
  const priority = syncContext.getStore()?.priority ?? 'P1';
  for (let attempt = 0; attempt < 8; attempt++) {
    await fmpLimiter.acquire(priority);
    const counter = syncContext.getStore()?.calls;
    if (counter) counter.n++;
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'stockharness-dataset-sync' },
        signal: AbortSignal.timeout(120000),
      });
      if (res.ok) return await res.json();
      if (res.status === 402) {
        // A plan limit is final: no retry, and no cooldown for the other syncs (#291).
        const limit = planLimitOf(endpoint, await res.text().catch(() => ''));
        if (limit) throw limit;
      }
      // A 402 without a plan-limit message is a throttle mislabelled 402.
      if ([402, 429, 500, 502, 503, 504].includes(res.status)) {
        if (res.status === 402 && attempt >= 5)
          throw new HttpError(402, `FMP endpoint ${endpoint} is not in the current plan`);
        const backoff = Math.min(60000, 2 ** attempt * 1000) + Math.random() * 1000;
        // A throttle means FMP wants *everyone* to slow down: pause all syncs, not just this request.
        if (res.status === 429 || res.status === 402) fmpLimiter.cooldown(backoff);
        else await sleep(backoff);
        lastErr = new Error(`FMP ${res.status}`);
        continue;
      }
      throw new HttpError(res.status, `FMP ${endpoint} returned ${res.status}`);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastErr = e;
      await sleep(Math.min(30000, 2 ** attempt * 1000) + Math.random() * 1000);
    }
  }
  throw new HttpError(502, `FMP ${endpoint} failed after retries: ${safeError(lastErr)}`);
}

const objToStr = (o: Record<string, string | number>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function resolveSymbols(sync: DatasetSync, wsDb: ReturnType<typeof mongo.db>, apikey: string) {
  if (sync.symbolsMode === 'list' && sync.symbols?.length) return sync.symbols;
  if (sync.symbolsMode === 'preset' && sync.preset) {
    const preset = presetById.get(sync.preset);
    if (!preset) throw new HttpError(400, `Unknown ticker preset: ${sync.preset}`);
    const data = await fmpGet(
      'company-screener',
      { ...preset.screener, isEtf: 'false', isFund: 'false', isActivelyTrading: 'true', limit: 5000 },
      apikey,
    );
    let list = (Array.isArray(data) ? data : []).filter(
      (r): r is Record<string, unknown> => !!r && typeof r === 'object' && !!r.symbol,
    );
    list.sort((a, b) => Number(b.marketCap ?? 0) - Number(a.marketCap ?? 0));
    if (preset.take) list = list.slice(0, preset.take);
    return list.map((r) => String(r.symbol));
  }
  const rows = await wsDb
    .collection('universe')
    .find({}, { projection: { symbol: 1, _id: 0 } })
    .toArray();
  const symbols = rows.map((r) => r.symbol as string).filter(Boolean);
  if (!symbols.length)
    throw new HttpError(
      400,
      'No universe yet: sync the Universe dataset first, or use an explicit symbol list',
    );
  return symbols;
}

export async function upsertRows(
  coll: ReturnType<ReturnType<typeof mongo.db>['collection']>,
  rows: unknown[],
  keyFields: string[],
) {
  const docs = rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
  if (!docs.length) return 0;
  const now = new Date();
  const ops = docs.map((doc) => {
    const clean = { ...doc, _syncedAt: now };
    delete (clean as Record<string, unknown>)._id;
    const filter = Object.fromEntries(keyFields.map((k) => [k, (doc as Record<string, unknown>)[k] ?? null]));
    return { updateOne: { filter, update: { $set: clean }, upsert: true } };
  });
  let written = 0;
  for (let i = 0; i < ops.length; i += 1000) {
    const res = await coll.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    written += (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
  }
  return written;
}

/** Do the actual data pull for one sync and return the row count. */
/** Query parameters for one symbol: the dataset's constants, the sync's depth/period overrides, the window. */
export function perSymbolParams(
  def: DatasetDef,
  sync: Pick<DatasetSync, 'historyPeriods' | 'statementPeriod' | 'cursor' | 'from'>,
  symbol: string,
  now: string,
): Record<string, string | number> {
  const params: Record<string, string | number> = { ...(def.params ?? {}), symbol };
  if (sync.historyPeriods && typeof def.params?.limit === 'number') params.limit = sync.historyPeriods;
  if (sync.statementPeriod && def.params?.period) params.period = sync.statementPeriod;
  if (isTimeseries(def)) {
    params.from = sync.cursor || sync.from || addDays(now, -365);
    params.to = now;
  }
  return params;
}

/**
 * Plan-depth probe (#77): one FMP call for one symbol asking for as much history as possible, to see what
 * the current plan really returns before committing to a full backfill.
 */
export async function probeDatasetDepth(
  ownerId: string,
  input: { dataset: string; connectionId: string; symbol?: string; statementPeriod?: 'quarter' | 'annual' },
) {
  const def = catalogById.get(input.dataset);
  if (!def) throw new HttpError(400, `Unknown dataset: ${input.dataset}`);
  if (!def.perSymbol) throw new HttpError(400, 'The depth probe is for per-symbol datasets');
  const apikey = await fmpApiKey(ownerId, input.connectionId);
  const symbol = (input.symbol || 'AAPL').toUpperCase();
  const now = today();
  const params = perSymbolParams(
    def,
    {
      from: '1980-01-01',
      historyPeriods: typeof def.params?.limit === 'number' ? 200 : undefined,
      statementPeriod: input.statementPeriod,
    },
    symbol,
    now,
  );
  // Some endpoints refuse a large limit on the current plan (402): step down until one is accepted.
  const limits =
    typeof params.limit === 'number' ? [200, 100, 40, 20, 10, Number(def.params?.limit) || 10] : [undefined];
  let data: unknown;
  let lastError: unknown;
  for (const limit of [...new Set(limits)]) {
    if (limit !== undefined) params.limit = limit;
    try {
      data = await syncContext.run({ priority: 'P0' }, () => fmpGet(def.endpoint, params, apikey));
      lastError = undefined;
      break;
    } catch (e) {
      lastError = e;
      if (!(e instanceof HttpError && e.status === 402)) break;
    }
  }
  if (lastError) throw lastError;
  const list = (Array.isArray(data) ? data : data ? [data] : []).filter(
    (r): r is Record<string, unknown> => !!r && typeof r === 'object',
  );
  const field = def.dateField || 'date';
  const dates = list
    .map((r) => r[field])
    .filter((v): v is string => typeof v === 'string' && v.length >= 10)
    .sort();
  const years = dates.length
    ? (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / (365.25 * 86400000)
    : 0;
  return {
    dataset: def.id,
    symbol,
    requested:
      typeof params.limit === 'number'
        ? { limit: params.limit, period: params.period }
        : { from: params.from, to: params.to },
    rows: list.length,
    earliest: dates[0],
    latest: dates[dates.length - 1],
    years: Math.round(years * 10) / 10,
    probedAt: new Date().toISOString(),
  };
}

type PullStats = {
  symbolsAttempted?: number;
  symbolsCovered?: number;
  /** The first per-symbol errors of a run (#76). */
  symbolErrors?: { symbol: string; error: string }[];
  /** A plan limit the run stopped at without failing (#291), e.g. a feed's page limit. */
  planLimit?: string;
};
async function pull(
  sync: DatasetSync,
  def: DatasetDef,
  apikey: string,
  stats: PullStats = {},
): Promise<number> {
  const wsDb = mongo.db(workspaceDatabase(sync.ownerId));
  const collName = sync.targetCollection || def.defaultCollection;
  const coll = wsDb.collection(collName);
  await coll.createIndex(Object.fromEntries(def.keyFields.map((k) => [k, 1]))).catch(() => undefined);
  // #83: responses are validated against the schema the catalog knew when this pull started.
  const known = await catalogEntries()
    .findOne({ ownerId: sync.ownerId, collection: collName }, { projection: { fields: 1 } })
    .catch(() => null);
  const checker = ingestChecker(known?.fields ?? [], {
    collection: collName,
    keyFields: def.keyFields,
    dateField: def.dateField,
  });
  try {
    return await pullChecked(sync, def, apikey, stats, coll, wsDb, checker);
  } finally {
    const drift = checker.drift();
    if (drift.length) await recordDrift(sync.ownerId, collName, drift, sync).catch(() => undefined);
  }
}

async function pullChecked(
  sync: DatasetSync,
  def: DatasetDef,
  apikey: string,
  stats: PullStats,
  coll: ReturnType<ReturnType<typeof mongo.db>['collection']>,
  wsDb: ReturnType<typeof mongo.db>,
  checker: ReturnType<typeof ingestChecker>,
): Promise<number> {
  const now = today();
  const defaultFrom = sync.from || addDays(now, -365);
  let rows = 0;

  if (def.perSymbol) {
    const symbols = await resolveSymbols(sync, wsDb, apikey);
    stats.symbolsAttempted = symbols.length;
    stats.symbolsCovered = 0;
    let errors = 0;
    let lastSymbolError: string | undefined;
    for (const symbol of symbols) {
      // One symbol's transient throttle (402/429) must never fail the whole dataset.
      try {
        const params = perSymbolParams(def, sync, symbol, now);
        const list = checker.check(await fmpGet(def.endpoint, params, apikey));
        for (const r of list)
          if (r && typeof r === 'object') {
            (r as Record<string, unknown>).symbol = symbol;
            if (params.period) (r as Record<string, unknown>).period ??= params.period;
            // Append-only snapshots: stamp the sync date so each weekly pull adds rows.
            if (def.snapshotDated) (r as Record<string, unknown>).snapshot_date = now;
          }
        const n = await upsertRows(coll, list, def.keyFields);
        rows += n;
        if (list.length) stats.symbolsCovered!++;
      } catch (error) {
        errors++;
        lastSymbolError = `${symbol}: ${safeError(error)}`;
        if ((stats.symbolErrors ??= []).length < 50)
          stats.symbolErrors.push({ symbol, error: safeError(error) });
        if (errors <= 5) console.warn(`dataset ${def.id} ${symbol}: ${safeError(error)}`);
      }
    }
    // Some symbols failing is tolerated; all of them failing means the sync itself is broken (#81).
    if (symbols.length && errors === symbols.length)
      throw new HttpError(
        502,
        `All ${symbols.length} symbols failed (last: ${lastSymbolError ?? 'unknown'})`,
      );
    if (errors)
      console.warn(`dataset ${def.id}: ${errors}/${symbols.length} symbols errored (kept the rest)`);
  } else if (def.fixedSymbols) {
    for (const symbol of def.fixedSymbols) {
      try {
        const list = checker.check(
          await fmpGet(def.endpoint, { symbol, from: sync.cursor || defaultFrom, to: now }, apikey),
        );
        for (const r of list) if (r && typeof r === 'object') (r as Record<string, unknown>).symbol = symbol;
        rows += await upsertRows(coll, list, def.keyFields);
      } catch (error) {
        console.warn(`dataset ${def.id} ${symbol}: ${safeError(error)}`);
      }
    }
  } else if (def.id === UNIVERSE_DATASET_ID) {
    // Survivorship-free SYNC universe (C1 #22): active screener names UNION all delisted companies,
    // so per-symbol flows also pull the history of names that later died. The market-cap / tradeable
    // filter is a point-in-time RESEARCH universe applied later in Layer 3 (universe_daily), never here.
    const p = (sync.params ?? {}) as Record<string, unknown>;
    const screener = await fmpGet(
      'company-screener',
      {
        exchange: String(p.exchange ?? 'NASDAQ,NYSE,AMEX'),
        isEtf: 'false',
        isFund: 'false',
        isActivelyTrading: 'true',
        marketCapMoreThan: Number(p.marketCapMoreThan ?? 2_000_000_000),
        limit: Number(p.limit ?? 5000),
      },
      apikey,
    );
    const active = (Array.isArray(screener) ? screener : [])
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !!r.symbol)
      .map((r) => ({
        symbol: r.symbol,
        companyName: r.companyName,
        marketCap: r.marketCap,
        exchange: r.exchangeShortName,
        sector: r.sector,
        industry: r.industry,
        is_delisted: false,
      }));
    // Delisted companies (paginated). Non-fatal: the Premium plan only serves page 0 (page>=1 -> 402),
    // so we take what is available and never let it fail the universe build. Refreshes delisted_companies.
    const delisted: Record<string, unknown>[] = [];
    for (let page = 0; page < Number(p.delistedPages ?? 100); page++) {
      let d: unknown;
      try {
        d = await fmpGet('delisted-companies', { page, limit: 100 }, apikey);
      } catch {
        break; // plan caps delisted paging; use whatever earlier pages returned
      }
      const dl = (Array.isArray(d) ? d : []).filter(
        (r): r is Record<string, unknown> => !!r && typeof r === 'object' && !!r.symbol,
      );
      if (!dl.length) break;
      delisted.push(...dl);
    }
    if (delisted.length) {
      const dcoll = mongo.db(workspaceDatabase(sync.ownerId)).collection('delisted_companies');
      await dcoll.createIndex({ symbol: 1, delistedDate: 1 }).catch(() => undefined);
      await upsertRows(dcoll, delisted, ['symbol', 'delistedDate']);
    }
    // Merge: an active screener row overrides a delisted row for the same symbol. Delisted listings on other
    // exchanges (LSE, TSX, OTC …) are outside the plan's price data and the research universe (#291).
    const exchanges = new Set(
      String(p.exchange ?? 'NASDAQ,NYSE,AMEX')
        .split(',')
        .map((x) => x.trim().toUpperCase()),
    );
    const bySymbol = new Map<string, Record<string, unknown>>();
    for (const r of delisted.filter((x) => exchanges.has(String(x.exchange ?? '').toUpperCase())))
      bySymbol.set(String(r.symbol), {
        symbol: r.symbol,
        companyName: r.companyName,
        exchange: r.exchange,
        delisted_date: r.delistedDate,
        is_delisted: true,
      });
    for (const r of active) bySymbol.set(String(r.symbol), r);
    rows += await upsertRows(coll, [...bySymbol.values()], def.keyFields);
  } else if (def.scope === 'feed') {
    const maxPages = Number((sync.params as Record<string, unknown> | undefined)?.pages ?? 5);
    for (let page = 0; page < maxPages; page++) {
      let data: unknown;
      try {
        data = await fmpGet(def.endpoint, { page, limit: 100 }, apikey);
      } catch (e) {
        // The plan serves only the first page(s) of some feeds (#291): keep what came back.
        if (page > 0 && e instanceof FmpPlanLimit && e.param === 'page') {
          stats.planLimit = e.message;
          break;
        }
        throw e;
      }
      const list = checker.check(data);
      if (!list.length) break;
      rows += await upsertRows(coll, list, def.keyFields);
    }
  } else if (def.incremental === 'window') {
    const from = sync.from || addDays(now, -7);
    const to = sync.to || addDays(now, 14);
    for (const [a, b] of chunkRanges(from, to, 60)) {
      rows += await upsertRows(
        coll,
        checker.check(await fmpGet(def.endpoint, { from: a, to: b }, apikey)),
        def.keyFields,
      );
    }
  } else {
    const params: Record<string, string | number> = { ...(def.params ?? {}) };
    if (def.id === 'sector_performance') params.date = now;
    if (def.supportsDateRange) {
      params.from = sync.from || addDays(now, -365 * 5);
      params.to = sync.to || now;
    }
    rows += await upsertRows(coll, checker.check(await fmpGet(def.endpoint, params, apikey)), def.keyFields);
  }

  if (sync.retentionDays && def.dateField) {
    const cutoff = addDays(now, -sync.retentionDays);
    await coll.deleteMany({ [def.dateField]: { $lt: cutoff } });
  }
  return rows;
}

/** Run one sync end to end: records a run, pulls data, updates the sync's cursor/status. */
export async function runDatasetSync(
  sync: DatasetSync,
  opts: {
    trigger: 'schedule' | 'manual' | 'pipeline' | 'event';
    scheduleKey?: string;
    /** Pull only these symbols (earnings-triggered runs, #82); the cursor is left alone. */
    symbols?: string[];
  } = { trigger: 'manual' },
) {
  if (opts.scheduleKey) {
    const existing = await datasetSyncRuns().findOne({ scheduleKey: opts.scheduleKey });
    if (existing) return existing;
  }
  const def = catalogById.get(sync.dataset);
  if (!def) throw new HttpError(400, `Unknown dataset: ${sync.dataset}`);
  const run: DatasetSyncRun = {
    _id: randomUUID(),
    ownerId: sync.ownerId,
    syncId: sync._id,
    scheduleKey: opts.scheduleKey,
    trigger: opts.trigger,
    status: 'running',
    startedAt: new Date(),
  };
  await datasetSyncRuns().insertOne(run);
  const stats: PullStats = {};
  const calls = { n: 0 };
  try {
    const apikey = await fmpApiKey(sync.ownerId, sync.connectionId);
    const windowFrom = isTimeseries(def) ? sync.cursor || sync.from || addDays(today(), -365) : undefined;
    const target = opts.symbols ? { ...sync, symbolsMode: 'list' as const, symbols: opts.symbols } : sync;
    const rows = await syncContext.run({ priority: effectivePriority(sync), calls }, () =>
      pull(target, def, apikey, stats),
    );
    await datasetSyncRuns().updateOne(
      { _id: run._id },
      {
        $set: {
          status: 'succeeded',
          rows,
          finishedAt: new Date(),
          ...(stats.symbolsAttempted !== undefined
            ? { symbolsAttempted: stats.symbolsAttempted, symbolsCovered: stats.symbolsCovered }
            : {}),
          calls: calls.n,
          ...(stats.symbolErrors?.length ? { symbolErrors: stats.symbolErrors } : {}),
          ...(stats.planLimit ? { planLimit: stats.planLimit } : {}),
        },
      },
    );
    await datasetSyncs().updateOne(
      { _id: sync._id },
      {
        $set: {
          lastRunAt: new Date(),
          lastRows: rows,
          consecutiveFailures: 0,
          // A partial (earnings-triggered) run must not move the cursor past the other symbols' history.
          ...(isTimeseries(def) && !opts.symbols ? { cursor: today() } : {}),
        },
        $unset: { lastError: '', lastFailureKind: '', pausedReason: '' },
      },
    );
    // #81: downstream work (transforms, pipelines, webhooks) starts on completion, not on a timer.
    await emitHarnessEvent(sync.ownerId, 'dataset.sync.completed', {
      sync_id: sync._id,
      sync_name: sync.name,
      dataset: sync.dataset,
      collection: sync.targetCollection || def.defaultCollection,
      run_id: run._id,
      trigger: opts.trigger,
      rows,
      ...(windowFrom ? { date_from: windowFrom, date_to: today() } : {}),
      ...(stats.symbolsAttempted !== undefined
        ? { symbols_attempted: stats.symbolsAttempted, symbols_covered: stats.symbolsCovered }
        : {}),
      finished_at: new Date().toISOString(),
    });
    // Keep the Schema Catalog current (#84); never let a stats query fail the sync.
    void refreshCatalogEntry(sync.ownerId, sync.targetCollection || def.defaultCollection).catch(
      () => undefined,
    );
    return { ...run, status: 'succeeded' as const, rows };
  } catch (error) {
    const message = safeError(error);
    await datasetSyncRuns().updateOne(
      { _id: run._id },
      {
        $set: {
          status: 'failed',
          error: message,
          finishedAt: new Date(),
          calls: calls.n,
          ...(stats.symbolErrors?.length ? { symbolErrors: stats.symbolErrors } : {}),
        },
      },
    );
    await datasetSyncs().updateOne(
      { _id: sync._id },
      {
        $set: {
          lastRunAt: new Date(),
          lastError: message,
          lastFailureKind: error instanceof FmpPlanLimit ? 'plan_limit' : 'error',
        },
        $inc: { consecutiveFailures: 1 },
      },
    );
    await emitHarnessEvent(sync.ownerId, 'dataset.sync.failed', {
      sync_id: sync._id,
      sync_name: sync.name,
      dataset: sync.dataset,
      run_id: run._id,
      trigger: opts.trigger,
      error: message,
    });
    throw error;
  }
}

/**
 * Syncs run inside the API process (one replica, Recreate rollout), so at startup any run still
 * marked `running` was killed by the previous process. Fail it so it neither shows as running nor
 * blocks bulk runs. Call once after connecting, before the dispatcher starts.
 */
export async function recoverInterruptedDatasetSyncRuns() {
  const orphans = await datasetSyncRuns().find({ status: 'running' }).toArray();
  if (!orphans.length) return 0;
  const error = 'Interrupted by a server restart';
  const finishedAt = new Date();
  await datasetSyncRuns().updateMany(
    { _id: { $in: orphans.map((r) => r._id) }, status: 'running' },
    { $set: { status: 'failed', error, finishedAt } },
  );
  await datasetSyncs().updateMany(
    { _id: { $in: [...new Set(orphans.map((r) => r.syncId))] } },
    { $set: { lastError: error } },
  );
  return orphans.length;
}

/** Fired every tick: run due, enabled syncs; advance nextRunAt. Mirrors dispatchSchedules(). */
export async function dispatchDatasetSyncs() {
  const due = await datasetSyncs()
    .find({
      enabled: true,
      'schedule.enabled': true,
      $or: [{ nextRunAt: { $lte: new Date() } }, { nextRunAt: { $exists: false } }],
    })
    .limit(10)
    .toArray();
  for (const sync of due) {
    const schedule = sync.schedule;
    if (!schedule?.enabled) continue;
    // Wall-clock schedules wait for their time rather than firing when first saved.
    if (!sync.nextRunAt && schedule.at && schedule.everyMinutes >= 1440) {
      await datasetSyncs().updateOne(
        { _id: sync._id, nextRunAt: { $exists: false } },
        { $set: { nextRunAt: nextScheduledAt(schedule) } },
      );
      continue;
    }
    const dueAt = sync.nextRunAt ?? sync.createdAt;
    const filter = {
      _id: sync._id,
      ...(sync.nextRunAt ? { nextRunAt: sync.nextRunAt } : { nextRunAt: { $exists: false } }),
    };
    // Claim this slot first so a long sync doesn't get re-fired by the next tick.
    const claimed = await datasetSyncs().updateOne(filter, {
      $set: { nextRunAt: nextScheduledAt(schedule) },
    });
    if (!claimed.matchedCount) continue;
    // Enqueue, never await: a multi-hour universe sync must not stall the server's dispatcher tick (#78).
    syncQueue.enqueue(sync._id, effectivePriority(sync), async () => {
      try {
        await runDatasetSync(sync, {
          trigger: 'schedule',
          scheduleKey: `${sync._id}:${dueAt.toISOString()}`,
        });
      } catch (error) {
        // Back off instead of retrying every minute (#291): transient failures retry after 5, 15, then 60
        // minutes (never later than the next regular slot); a plan limit waits for the next regular slot, and
        // three in a row pause the schedule with the reason.
        const fresh = await datasetSyncs().findOne({ _id: sync._id });
        const failures = fresh?.consecutiveFailures ?? 1;
        const plan = error instanceof FmpPlanLimit;
        const regular = nextScheduledAt(schedule);
        const next = retryAt(failures, plan, regular);
        await datasetSyncs().updateOne(
          { _id: sync._id },
          plan && failures >= PAUSE_AFTER_PLAN_FAILURES
            ? {
                $set: {
                  'schedule.enabled': false,
                  pausedReason: `Paused after ${failures} runs in a row hit an FMP plan limit: ${safeError(error)}`,
                  lastError: safeError(error),
                },
              }
            : { $set: { nextRunAt: next, lastError: safeError(error) } },
        );
      }
    });
  }
}

export const PAUSE_AFTER_PLAN_FAILURES = 3;
const RETRY_MINUTES = [5, 15, 60];
/** When a failed scheduled sync runs again (#291). */
export function retryAt(failures: number, planLimit: boolean, regular: Date, now = Date.now()): Date {
  if (planLimit) return regular;
  const backoff = new Date(
    now + RETRY_MINUTES[Math.min(Math.max(failures, 1), RETRY_MINUTES.length) - 1]! * 60000,
  );
  return backoff < regular ? backoff : regular;
}

/** Queue a manual run (Run now, bulk Run). Returns false when the sync is already queued or running. */
export function enqueueManualRun(sync: DatasetSync) {
  return syncQueue.enqueue(sync._id, effectivePriority(sync), async () => {
    const fresh = await datasetSyncs().findOne({ _id: sync._id });
    if (!fresh) return; // deleted while queued
    await runDatasetSync(fresh, { trigger: 'manual' }).catch(() => undefined);
  });
}

export type { Stored };

// --- Bulk operations (Datasets toolbar) -------------------------------------------------------
export const DATASET_BULK_ACTIONS = [
  'run',
  'enable',
  'disable',
  'reset',
  'purge',
  'delete',
  'backfill',
] as const;
export type DatasetBulkAction = (typeof DATASET_BULK_ACTIONS)[number];
export const datasetBulkInput = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  action: z.enum(DATASET_BULK_ACTIONS),
  /** delete only: also drop each sync's collection unless a remaining sync still writes to it. */
  dropCollections: z.boolean().default(false),
});
export type DatasetBulkResult = {
  action: DatasetBulkAction;
  matched: number;
  /** Sync ids queued for a background run (run only). */
  queued?: string[];
  /** Sync ids skipped because a run is already in progress (run only). */
  alreadyRunning?: string[];
  /** Collections whose documents were removed (purge) or that were dropped (delete). */
  collections?: { name: string; deleted?: number; dropped?: boolean }[];
  /** Collections kept on delete because another sync still writes to them. */
  keptCollections?: string[];
  /** backfill: syncs whose backfill was queued, and ones skipped with the reason. */
  backfillsQueued?: string[];
  backfillsSkipped?: { id: string; reason: string }[];
};

/** The collection a sync writes to: its override, else the catalog default. */
export const syncCollection = (s: Pick<DatasetSync, 'dataset' | 'targetCollection'>) =>
  s.targetCollection || catalogById.get(s.dataset)?.defaultCollection || '';

/**
 * Split the collections of `selected` syncs into those safe to drop and those still written by a
 * sync outside the selection. Each collection appears once even if several selected syncs share it.
 */
export function collectionsToDrop(
  selected: Pick<DatasetSync, '_id' | 'dataset' | 'targetCollection'>[],
  all: Pick<DatasetSync, '_id' | 'dataset' | 'targetCollection'>[],
) {
  const selectedIds = new Set(selected.map((s) => s._id));
  const stillUsed = new Set(all.filter((s) => !selectedIds.has(s._id)).map(syncCollection));
  const names = [...new Set(selected.map(syncCollection).filter(Boolean))];
  return { drop: names.filter((n) => !stillUsed.has(n)), keep: names.filter((n) => stillUsed.has(n)) };
}

// A run row stuck in `running` longer than this (e.g. the pod restarted mid-sync) no longer blocks.
const STALE_RUN_MS = 12 * 3600 * 1000;

export async function applyDatasetSyncBulk(
  ownerId: string,
  input: z.infer<typeof datasetBulkInput>,
): Promise<DatasetBulkResult> {
  const { action } = input;
  const ids = [...new Set(input.ids)];
  const selected = await datasetSyncs()
    .find({ ownerId, _id: { $in: ids } })
    .toArray();
  const matchedIds = selected.map((s) => s._id);
  const result: DatasetBulkResult = { action, matched: selected.length };
  if (!selected.length) return result;
  const wsDb = mongo.db(workspaceDatabase(ownerId));

  switch (action) {
    case 'enable':
    case 'disable':
      await datasetSyncs().updateMany(
        { ownerId, _id: { $in: matchedIds } },
        // Re-enabling re-seeds the schedule from now instead of firing every missed slot at once.
        { $set: { enabled: action === 'enable', updatedAt: new Date() }, $unset: { nextRunAt: '' } },
      );
      break;
    case 'reset':
      await datasetSyncs().updateMany(
        { ownerId, _id: { $in: matchedIds } },
        { $unset: { cursor: '' }, $set: { updatedAt: new Date() } },
      );
      break;
    case 'purge': {
      const names = [...new Set(selected.map(syncCollection).filter(Boolean))];
      result.collections = [];
      for (const name of names) {
        const res = await wsDb.collection(name).deleteMany({});
        result.collections.push({ name, deleted: res.deletedCount });
      }
      // Every sync writing to a purged collection (selected or not) must re-pull its history.
      const all = await datasetSyncs().find({ ownerId }).toArray();
      const affected = all.filter((s) => names.includes(syncCollection(s))).map((s) => s._id);
      await datasetSyncs().updateMany(
        { ownerId, _id: { $in: affected } },
        { $unset: { cursor: '', lastRows: '' }, $set: { updatedAt: new Date() } },
      );
      break;
    }
    case 'delete': {
      const all = await datasetSyncs().find({ ownerId }).toArray();
      const { drop, keep } = collectionsToDrop(selected, all);
      await datasetSyncs().deleteMany({ ownerId, _id: { $in: matchedIds } });
      if (input.dropCollections) {
        result.collections = [];
        for (const name of drop) {
          const dropped = await wsDb
            .collection(name)
            .drop()
            .catch(() => false); // already absent
          result.collections.push({ name, dropped: !!dropped });
        }
        result.keptCollections = keep;
      }
      break;
    }
    case 'backfill': {
      // Imported lazily: datasetBackfill imports this module.
      const { createBackfill } = await import('./datasetBackfill.js');
      result.backfillsQueued = [];
      result.backfillsSkipped = [];
      for (const s of selected)
        try {
          await createBackfill(ownerId, s._id);
          result.backfillsQueued.push(s._id);
        } catch (e) {
          result.backfillsSkipped.push({ id: s._id, reason: e instanceof Error ? e.message : String(e) });
        }
      break;
    }
    case 'run': {
      const running = await datasetSyncRuns()
        .find({
          ownerId,
          syncId: { $in: matchedIds },
          status: 'running',
          startedAt: { $gt: new Date(Date.now() - STALE_RUN_MS) },
        })
        .project<{ syncId: string }>({ syncId: 1 })
        .toArray();
      const busy = new Set([
        ...running.map((r) => r.syncId),
        ...selected.filter((s) => syncQueue.has(s._id)).map((s) => s._id),
      ]);
      // Keep the table order (newest first); the queue then orders by priority and shares the FMP limit.
      const toRun = selected
        .filter((s) => !busy.has(s._id))
        .sort((a, b) => ids.indexOf(a._id) - ids.indexOf(b._id));
      result.queued = toRun.filter((s) => enqueueManualRun(s)).map((s) => s._id);
      result.alreadyRunning = [...busy];
      break;
    }
  }
  return result;
}
