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
import {
  catalogById,
  UNIVERSE_DATASET_ID,
  presetById,
  variantsOf,
  type DatasetDef,
} from './datasetCatalog.js';
import { catalogEntries, refreshCatalogEntry } from './schemaCatalog.js';
import { isEquity, type InstrumentFlags } from './instruments.js';
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
/** A per-symbol run saves its progress every this many symbols, or this often (#416). */
const PROGRESS_EVERY_SYMBOLS = Math.max(1, Number(process.env.SYNC_PROGRESS_EVERY) || 25);
const PROGRESS_EVERY_MS = 30_000;
/** A running run with no sign of life for this long is not in progress any more (#416). */
const HEARTBEAT_STALE_MS = 30 * 60_000;
/** The universe screener floor: the research universe's point-in-time min_market_cap (universe_daily). */
export const UNIVERSE_MIN_MARKET_CAP = 300_000_000;
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
  /** Claimed or queued but not started yet (#439): a restart re-queues it. */
  queuedAt?: Date;
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
  /**
   * Resumable runs (#416): the attempt number (a fencing token: an older attempt's writes are ignored), the
   * last sign of life, and, for per-symbol runs, where the loop is.
   */
  attempt?: number;
  heartbeatAt?: Date;
  progress?: SyncRunProgress;
  /** Restarts this run survived: when, and the symbol index it resumed at. */
  interruptions?: { at: Date; next: number }[];
};
export type SyncRunProgress = {
  /** The symbols this run iterates, fixed when it started (a resume never re-resolves the universe). */
  symbols?: string[];
  /** Index of the next symbol to pull. */
  next: number;
  /** The run's date: the window end, the snapshot_date of snapshot rows and the cursor on success. */
  runDate: string;
  /** Totals so far, carried into the resumed attempt. */
  rows: number;
  covered: number;
  errors: number;
  calls: number;
  /** An earnings-triggered run of a few symbols: never moves the cursor. */
  partial?: boolean;
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

/** Stamp a variant's tag fields (e.g. `index: 'sp500'`) on the rows it returned. */
export function tagRows(rows: unknown[], tag: Record<string, string>) {
  if (Object.keys(tag).length)
    for (const r of rows) if (r && typeof r === 'object') Object.assign(r as Record<string, unknown>, tag);
  return rows;
}

/** Tag an FMP answer's rows before the ingest check, so the tag is checked like any field (an error body is
 * left as is for the check to report). */
const tagged = (data: unknown, tag: Record<string, string>) =>
  Array.isArray(data) ? tagRows(data, tag) : data;

/** The rolling window a window dataset re-pulls each run: [today - lookback, today + lookahead]. */
export function rollingWindow(def: DatasetDef, sync: Pick<DatasetSync, 'from' | 'to'>, now: string) {
  return {
    from: sync.from || addDays(now, -(def.lookbackDays ?? 7)),
    to: sync.to || addDays(now, def.lookaheadDays ?? 14),
  };
}

/**
 * Whether a listing belongs in the sync universe (#387, #393): a US ticker (share classes such as BRK-B stay;
 * foreign suffixes such as .L or .KS do not) for common stock or an ADR, not a note, preferred, warrant,
 * unit, right, fund or ETF (packages/core/src/instruments.ts).
 */
export function isUniverseInstrument(symbol: string, name?: string | null, flags: InstrumentFlags = {}) {
  const s = symbol.toUpperCase();
  // FMP writes US share classes with a dash (BRK-B, BF-B); a dot suffix is a foreign listing (.L, .TO) or a unit.
  return /^[A-Z][A-Z0-9]{0,5}(-[A-Z])?$/.test(s) && isEquity(s, name, flags);
}
const flagsOf = (r: Record<string, unknown>): InstrumentFlags => ({
  isEtf: r.isEtf === true,
  isFund: r.isFund === true,
  isAdr: r.isAdr === true,
});

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

/** Routine runs skip names delisted more than this many days ago: they produce no new data (#398). */
export const DEAD_AFTER_DAYS = 30;

export async function resolveSymbols(
  sync: DatasetSync,
  wsDb: ReturnType<typeof mongo.db>,
  apikey: string,
  /** Backfills pass true: a dead company's history is pulled once, in full. */
  opts: { includeLongDelisted?: boolean } = {},
) {
  if (sync.symbolsMode === 'list' && sync.symbols?.length) return sync.symbols;
  if (sync.symbolsMode === 'preset' && sync.preset) {
    const preset = presetById.get(sync.preset);
    if (!preset) throw new HttpError(400, `Unknown ticker preset: ${sync.preset}`);
    // Exact index membership (#387): the current members from the index_constituents sync.
    if (preset.index) {
      const members = (await wsDb
        .collection('index_constituents')
        .distinct('symbol', { index: preset.index })) as string[];
      if (!members.length)
        throw new HttpError(400, `No ${preset.label} members yet: sync the Index constituents dataset first`);
      return members.sort();
    }
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
    .find({}, { projection: { symbol: 1, is_delisted: 1, delisted_date: 1, _id: 0 } })
    .toArray();
  const cutoff = addDays(today(), -DEAD_AFTER_DAYS);
  const symbols = rows
    .filter(
      (r) =>
        opts.includeLongDelisted ||
        !longDelisted(r as { is_delisted?: unknown; delisted_date?: unknown }, cutoff),
    )
    .map((r) => r.symbol as string)
    .filter(Boolean);
  if (!symbols.length)
    throw new HttpError(
      400,
      'No universe yet: sync the Universe dataset first, or use an explicit symbol list',
    );
  return symbols;
}

/** A universe row delisted before `cutoff` (an ISO date): no new prices, filings or estimates will come. */
export function longDelisted(r: { is_delisted?: unknown; delisted_date?: unknown }, cutoff: string) {
  const d = typeof r.delisted_date === 'string' ? r.delisted_date.slice(0, 10) : '';
  return r.is_delisted === true && /^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff;
}

export async function upsertRows(
  coll: ReturnType<ReturnType<typeof mongo.db>['collection']>,
  rows: unknown[],
  keyFields: string[],
) {
  return (await upsertRowsCounted(coll, rows, keyFields)).written;
}

/** upsertRows, also counting the rows that were new (a feed stops paging at a page with none). */
export async function upsertRowsCounted(
  coll: ReturnType<ReturnType<typeof mongo.db>['collection']>,
  rows: unknown[],
  keyFields: string[],
) {
  const docs = rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
  if (!docs.length) return { written: 0, inserted: 0 };
  const now = new Date();
  const ops = docs.map((doc) => {
    const clean = { ...doc, _syncedAt: now };
    delete (clean as Record<string, unknown>)._id;
    const filter = Object.fromEntries(keyFields.map((k) => [k, (doc as Record<string, unknown>)[k] ?? null]));
    return { updateOne: { filter, update: { $set: clean }, upsert: true } };
  });
  let written = 0;
  let inserted = 0;
  for (let i = 0; i < ops.length; i += 1000) {
    const res = await coll.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    written += (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
    inserted += res.upsertedCount ?? 0;
  }
  return { written, inserted };
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
  /** Resume a per-symbol run here (#416): its symbol list, next index and totals so far. */
  resume?: SyncRunProgress;
  /** Persist per-symbol progress (#416); called when the loop starts and every few symbols. */
  onProgress?: (p: SyncRunProgress, opts: { withSymbols: boolean }) => Promise<void>;
  /** The run's date (window end, snapshot_date); defaults to today. */
  runDate?: string;
  symbolsAttempted?: number;
  symbolsCovered?: number;
  /** The first per-symbol errors of a run (#76). */
  symbolErrors?: { symbol: string; error: string }[];
  /** A plan limit the run stopped at without failing (#291), e.g. a feed's page limit. */
  planLimit?: string;
  /** Rows a replacing snapshot deleted (universe names that no longer qualify, index members that left). */
  removed?: number;
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
  const now = stats.runDate ?? today();
  const defaultFrom = sync.from || addDays(now, -365);
  let rows = 0;

  if (def.perSymbol) {
    // A resumed run (#416) keeps the symbol list, the date and the totals of the attempt that was interrupted.
    const resume = stats.resume?.symbols ? stats.resume : undefined;
    const symbols = resume?.symbols ?? (await resolveSymbols(sync, wsDb, apikey));
    stats.symbolsAttempted = symbols.length;
    stats.symbolsCovered = resume?.covered ?? 0;
    let errors = resume?.errors ?? 0;
    rows = resume?.rows ?? 0;
    let lastSymbolError: string | undefined;
    const progress = (next: number): SyncRunProgress => ({
      next,
      runDate: now,
      rows,
      covered: stats.symbolsCovered ?? 0,
      errors,
      calls: 0, // the run adds its call counter
    });
    if (!resume) await stats.onProgress?.({ ...progress(0), symbols }, { withSymbols: true });
    let savedAt = Date.now();
    for (let i = resume?.next ?? 0; i < symbols.length; i++) {
      const symbol = symbols[i]!;
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
      // Progress every few symbols or seconds: a restart resumes after the last saved symbol (#416).
      if (
        stats.onProgress &&
        ((i + 1) % PROGRESS_EVERY_SYMBOLS === 0 || Date.now() - savedAt > PROGRESS_EVERY_MS)
      ) {
        await stats.onProgress(progress(i + 1), { withSymbols: false });
        savedAt = Date.now();
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
    // filter is a point-in-time RESEARCH universe applied later in Layer 2 (universe_daily), never here.
    const p = (sync.params ?? {}) as Record<string, unknown>;
    const screener = await fmpGet(
      'company-screener',
      {
        exchange: String(p.exchange ?? 'NASDAQ,NYSE,AMEX'),
        isEtf: 'false',
        isFund: 'false',
        isActivelyTrading: 'true',
        // The research universe's point-in-time floor (universe_daily min_market_cap): a higher floor here
        // would drop names that were above it in the past and fell below since (#387).
        marketCapMoreThan: Number(p.marketCapMoreThan ?? UNIVERSE_MIN_MARKET_CAP),
        limit: Number(p.limit ?? 10000),
      },
      apikey,
    );
    const active = (Array.isArray(screener) ? screener : [])
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !!r.symbol)
      .filter((r) => isUniverseInstrument(String(r.symbol), r.companyName as string, flagsOf(r)))
      .map((r) => ({
        symbol: r.symbol,
        companyName: r.companyName,
        marketCap: r.marketCap,
        exchange: r.exchangeShortName,
        sector: r.sector,
        industry: r.industry,
        is_delisted: false,
      }));
    // Delisted companies, every page (#387: the Premium plan serves about 170 pages, delistings since late 2020). Non-fatal: a page the
    // plan refuses ends the list, and the universe keeps what came back. Refreshes delisted_companies.
    const delisted: Record<string, unknown>[] = [];
    for (let page = 0; page < Number(p.delistedPages ?? 1000); page++) {
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
    const exchanges = new Set(
      String(p.exchange ?? 'NASDAQ,NYSE,AMEX')
        .split(',')
        .map((x) => x.trim().toUpperCase()),
    );
    // US only (owner, 2026-11-15): FMP's delisted list mixes every country; only listings on the sync's exchanges
    // are stored, so nothing downstream (securities) sees foreign names.
    const usDelisted = delisted.filter((x) => exchanges.has(String(x.exchange ?? '').toUpperCase()));
    if (usDelisted.length) {
      const dcoll = mongo.db(workspaceDatabase(sync.ownerId)).collection('delisted_companies');
      await dcoll.createIndex({ symbol: 1, delistedDate: 1 }).catch(() => undefined);
      await upsertRows(dcoll, usDelisted, ['symbol', 'delistedDate']);
    }
    // Merge: an active screener row overrides a delisted row for the same symbol. Delisted listings on other
    // exchanges (LSE, TSX, OTC …) are outside the plan's price data and the research universe (#291).
    const bySymbol = new Map<string, Record<string, unknown>>();
    for (const r of usDelisted.filter((x) => isUniverseInstrument(String(x.symbol), x.companyName as string)))
      bySymbol.set(String(r.symbol), {
        symbol: r.symbol,
        companyName: r.companyName,
        exchange: r.exchange,
        delisted_date: r.delistedDate,
        is_delisted: true,
      });
    for (const r of active) bySymbol.set(String(r.symbol), r);
    // Sticky (#393): a name stays in the sync universe once it is in, so a stock that falls below the floor (or
    // that the screener stops returning, e.g. a second share class) keeps its prices flowing; and a name we hold a
    // trading profile for comes back. Only listings that are not US common stock or ADRs, or not on the exchanges
    // (notes, preferreds, warrants, units, funds, foreign or OTC leftovers), are removed.
    const profiles = await wsDb
      .collection('company_profiles')
      .find(
        { isActivelyTrading: { $ne: false } },
        {
          projection: {
            _id: 0,
            symbol: 1,
            companyName: 1,
            exchange: 1,
            exchangeShortName: 1,
            isEtf: 1,
            isFund: 1,
            isAdr: 1,
          },
        },
      )
      .toArray();
    const profileOf = new Map(profiles.map((x) => [String(x.symbol), x as Record<string, unknown>]));
    const exchangeOf = (r: Record<string, unknown>) =>
      String(r.exchange ?? r.exchangeShortName ?? '').toUpperCase();
    const qualifies = (r: Record<string, unknown>) => {
      const prof = profileOf.get(String(r.symbol)) ?? {};
      return (
        exchanges.has(exchangeOf(r) || exchangeOf(prof)) &&
        isUniverseInstrument(String(r.symbol), (r.companyName ?? prof.companyName) as string, flagsOf(prof))
      );
    };
    const held = await coll
      .find({}, { projection: { _id: 0, symbol: 1, companyName: 1, exchange: 1 } })
      .toArray();
    const heldSymbols = new Set(held.map((r) => String(r.symbol)));
    for (const prof of profiles)
      if (!bySymbol.has(String(prof.symbol)) && !heldSymbols.has(String(prof.symbol)) && qualifies(prof))
        bySymbol.set(String(prof.symbol), {
          symbol: prof.symbol,
          companyName: prof.companyName,
          exchange: exchangeOf(prof),
          is_delisted: false,
        });
    rows += await upsertRows(coll, [...bySymbol.values()], def.keyFields);
    const junk = held.filter((r) => !bySymbol.has(String(r.symbol)) && !qualifies(r)).map((r) => r.symbol);
    if (junk.length) stats.removed = (await coll.deleteMany({ symbol: { $in: junk } })).deletedCount;
  } else if (def.scope === 'feed') {
    // Feeds are newest first: page until a page brings nothing new (or the plan's page limit, #291).
    const maxPages = Number((sync.params as Record<string, unknown> | undefined)?.pages ?? 50);
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
      const { written, inserted } = await upsertRowsCounted(coll, list, def.keyFields);
      rows += written;
      if (!inserted) break;
    }
  } else if (def.incremental === 'window') {
    const { from, to } = rollingWindow(def, sync, now);
    for (const v of variantsOf(def))
      for (const [a, b] of chunkRanges(from, to, def.windowDays ?? 60))
        rows += await upsertRows(
          coll,
          checker.check(tagged(await fmpGet(v.endpoint, { ...v.params, from: a, to: b }, apikey), v.tag)),
          def.keyFields,
        );
  } else {
    const startedAt = new Date();
    let complete = true;
    for (const v of variantsOf(def)) {
      const params: Record<string, string | number> = { ...v.params };
      if (def.supportsDateRange) {
        params.from = sync.from || addDays(now, -365 * 5);
        params.to = sync.to || now;
      }
      const list = checker.check(tagged(await fmpGet(v.endpoint, params, apikey), v.tag));
      if (!list.length) complete = false;
      rows += await upsertRows(coll, list, def.keyFields);
    }
    // Snapshot lists (index members): what a complete pull no longer returns has left the list.
    if (def.replaceStale && complete)
      stats.removed = (await coll.deleteMany({ _syncedAt: { $lt: startedAt } })).deletedCount;
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
    /** The run's date (window end, snapshot_date, cursor); today unless given (tests). */
    runDate?: string;
  } = { trigger: 'manual' },
) {
  if (opts.scheduleKey) {
    const existing = await datasetSyncRuns().findOne({ scheduleKey: opts.scheduleKey });
    if (existing) return existing;
  }
  // Never two attempts of one sync at once (#416): a run that is alive (recent heartbeat) is returned instead.
  const live = await liveRunOf(sync._id);
  if (live) return live;
  const def = catalogById.get(sync.dataset);
  if (!def) throw new HttpError(400, `Unknown dataset: ${sync.dataset}`);
  const now = new Date();
  const run: DatasetSyncRun = {
    _id: randomUUID(),
    ownerId: sync.ownerId,
    syncId: sync._id,
    scheduleKey: opts.scheduleKey,
    trigger: opts.trigger,
    status: 'running',
    startedAt: now,
    attempt: 1,
    heartbeatAt: now,
    progress: {
      next: 0,
      runDate: opts.runDate ?? today(),
      rows: 0,
      covered: 0,
      errors: 0,
      calls: 0,
      ...(opts.symbols ? { partial: true } : {}),
    },
  };
  await datasetSyncRuns().insertOne(run);
  // The run has started: it is no longer only queued (#439).
  await datasetSyncs().updateOne({ _id: sync._id }, { $unset: { queuedAt: '' } });
  return executeSyncRun(sync, def, run, opts.symbols);
}

/** A run of this sync that is in progress: `running` with a heartbeat in the last half hour (#416). */
async function liveRunOf(syncId: string) {
  return datasetSyncRuns().findOne({
    syncId,
    status: 'running',
    heartbeatAt: { $gt: new Date(Date.now() - HEARTBEAT_STALE_MS) },
  });
}

/** Thrown inside an attempt that a newer attempt of the same run has taken over (#416). */
class SupersededAttempt extends Error {}

/**
 * One attempt of a run (#416). Every write to the run is fenced on its attempt number, so an older attempt that
 * is somehow still alive can neither report progress nor finish the run. A per-symbol attempt resumes at the
 * saved symbol with the saved list, date and totals; any other attempt starts from the beginning.
 */
async function executeSyncRun(sync: DatasetSync, def: DatasetDef, run: DatasetSyncRun, symbols?: string[]) {
  const attempt = run.attempt ?? 1;
  const fence = { _id: run._id, status: 'running' as const, attempt };
  const prior = run.progress;
  const runDate = prior?.runDate ?? today();
  const priorCalls = prior?.calls ?? 0;
  const partial = Boolean(prior?.partial || symbols);
  const calls = { n: 0 };
  const stats: PullStats = {
    runDate,
    ...(def.perSymbol && prior?.symbols?.length ? { resume: prior } : {}),
    onProgress: async (p, o) => {
      const set: Record<string, unknown> = {
        heartbeatAt: new Date(),
        'progress.next': p.next,
        'progress.runDate': p.runDate,
        'progress.rows': p.rows,
        'progress.covered': p.covered,
        'progress.errors': p.errors,
        'progress.calls': priorCalls + calls.n,
      };
      if (o.withSymbols) set['progress.symbols'] = p.symbols;
      const r = await datasetSyncRuns().updateOne(fence, { $set: set });
      if (!r.matchedCount) throw new SupersededAttempt(`Run ${run._id} attempt ${attempt} was superseded`);
    },
  };
  try {
    const apikey = await fmpApiKey(sync.ownerId, sync.connectionId);
    const windowFrom = isTimeseries(def) ? sync.cursor || sync.from || addDays(runDate, -365) : undefined;
    const target = symbols ? { ...sync, symbolsMode: 'list' as const, symbols } : sync;
    const rows = await syncContext.run({ priority: effectivePriority(sync), calls }, () =>
      pull(target, def, apikey, stats),
    );
    const done = await datasetSyncRuns().updateOne(fence, {
      $set: {
        status: 'succeeded',
        rows,
        finishedAt: new Date(),
        heartbeatAt: new Date(),
        ...(stats.symbolsAttempted !== undefined
          ? {
              symbolsAttempted: stats.symbolsAttempted,
              symbolsCovered: stats.symbolsCovered,
              'progress.next': stats.symbolsAttempted,
            }
          : {}),
        calls: priorCalls + calls.n,
        'progress.calls': priorCalls + calls.n,
        ...(stats.symbolErrors?.length ? { symbolErrors: stats.symbolErrors } : {}),
        ...(stats.planLimit ? { planLimit: stats.planLimit } : {}),
        ...(stats.removed ? { removed: stats.removed } : {}),
      },
    });
    if (!done.matchedCount) return (await datasetSyncRuns().findOne({ _id: run._id }))!; // superseded
    await datasetSyncs().updateOne(
      { _id: sync._id },
      {
        $set: {
          lastRunAt: new Date(),
          lastRows: rows,
          consecutiveFailures: 0,
          // Only a whole run moves the cursor, to the date its window ended (#416); a partial
          // (earnings-triggered) run must not move it past the other symbols' history.
          ...(isTimeseries(def) && !partial ? { cursor: runDate } : {}),
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
      trigger: run.trigger,
      rows,
      ...(windowFrom ? { date_from: windowFrom, date_to: runDate } : {}),
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
    // A newer attempt owns the run: this one just stops, without failing the run or the sync.
    if (error instanceof SupersededAttempt) return (await datasetSyncRuns().findOne({ _id: run._id }))!;
    const message = safeError(error);
    const failed = await datasetSyncRuns().updateOne(fence, {
      $set: {
        status: 'failed',
        error: message,
        finishedAt: new Date(),
        calls: priorCalls + calls.n,
        ...(stats.symbolErrors?.length ? { symbolErrors: stats.symbolErrors } : {}),
      },
    });
    if (!failed.matchedCount) return (await datasetSyncRuns().findOne({ _id: run._id }))!;
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
      trigger: run.trigger,
      error: message,
    });
    throw error;
  }
}

/**
 * Syncs run inside the API process (one replica, Recreate rollout), so at startup any run still
 * marked `running` was killed by the previous process. Fail it so it neither shows as running nor
 * blocks bulk runs. The server resumes them instead (resumeInterruptedDatasetSyncRuns, #416); this is kept
 * for callers that only want them closed.
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

export type ResumePlan =
  { action: 'resume'; next: number } | { action: 'restart' } | { action: 'fail'; reason: string };

/**
 * What to do with a run a restart interrupted (pure; #416): a per-symbol run with a saved symbol list resumes at
 * its saved index; any other run (feeds, windows, market snapshots, or a per-symbol run that died before its
 * first save) starts again from the beginning; a run whose sync is gone or disabled is failed.
 */
export function planResume(
  run: Pick<DatasetSyncRun, 'progress'>,
  sync: Pick<DatasetSync, 'enabled' | 'dataset'> | null | undefined,
): ResumePlan {
  if (!sync) return { action: 'fail', reason: 'the dataset sync was deleted' };
  if (sync.enabled === false) return { action: 'fail', reason: 'the sync is disabled' };
  const def = catalogById.get(sync.dataset);
  if (!def) return { action: 'fail', reason: `unknown dataset ${sync.dataset}` };
  const p = run.progress;
  if (def.perSymbol && p?.symbols?.length)
    return { action: 'resume', next: Math.min(p.next, p.symbols.length) };
  // An earnings-triggered run that died before saving its symbols cannot be rebuilt; the next report runs it.
  if (p?.partial) return { action: 'fail', reason: 'a partial run interrupted before it saved its symbols' };
  return { action: 'restart' };
}

/**
 * At startup (#416): every run the previous process left `running` gets a new attempt, resumed where it stopped
 * (per-symbol runs) or from the start (the rest), in the background sync queue. The interruption does not count
 * as a failure. Returns what was resumed; `enqueue: false` only plans the attempts (tests run them directly).
 */
export async function resumeInterruptedDatasetSyncRuns(opts: { enqueue?: boolean } = {}) {
  const orphans = await datasetSyncRuns().find({ status: 'running' }).toArray();
  const resumed: { runId: string; syncId: string; attempt: number; next: number }[] = [];
  let failed = 0;
  for (const run of orphans) {
    const sync = await datasetSyncs().findOne({ _id: run.syncId });
    const plan = planResume(run, sync);
    const was = run.attempt ?? 1;
    const fence = { _id: run._id, status: 'running' as const, ...(run.attempt ? { attempt: was } : {}) };
    const at = new Date();
    if (plan.action === 'fail') {
      const r = await datasetSyncRuns().updateOne(fence, {
        $set: { status: 'failed', error: `Interrupted by a server restart; ${plan.reason}`, finishedAt: at },
      });
      if (r.matchedCount) failed++;
      continue;
    }
    const next = plan.action === 'resume' ? plan.next : 0;
    const attempt = was + 1;
    const r = await datasetSyncRuns().updateOne(fence, {
      $set: {
        attempt,
        heartbeatAt: at,
        ...(plan.action === 'restart'
          ? {
              progress: {
                next: 0,
                runDate: run.progress?.runDate ?? today(),
                rows: 0,
                covered: 0,
                errors: 0,
                calls: run.progress?.calls ?? run.calls ?? 0,
              },
            }
          : {}),
      },
      $push: { interruptions: { at, next } },
    });
    if (!r.matchedCount) continue;
    resumed.push({ runId: run._id, syncId: run.syncId, attempt, next });
    if (opts.enqueue !== false)
      syncQueue.enqueue(run.syncId, effectivePriority(sync!), () =>
        resumeDatasetSyncRun(run._id, attempt).catch(() => undefined),
      );
  }
  return { resumed, failed };
}

/** Run attempt `attempt` of an interrupted run (#416); a run another attempt took over is left alone. */
export async function resumeDatasetSyncRun(runId: string, attempt: number) {
  const run = await datasetSyncRuns().findOne({ _id: runId, status: 'running', attempt });
  if (!run) return null;
  const sync = await datasetSyncs().findOne({ _id: run.syncId });
  const def = sync ? catalogById.get(sync.dataset) : undefined;
  if (!sync || !def) {
    await datasetSyncRuns().updateOne(
      { _id: runId, status: 'running', attempt },
      { $set: { status: 'failed', error: 'The dataset sync was deleted', finishedAt: new Date() } },
    );
    return null;
  }
  return executeSyncRun(sync, def, run);
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
    // queuedAt marks the claimed-but-not-started run, so a restart before it starts re-queues it (#439).
    const claimed = await datasetSyncs().updateOne(filter, {
      $set: { nextRunAt: nextScheduledAt(schedule), queuedAt: new Date() },
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
  const queued = syncQueue.enqueue(sync._id, effectivePriority(sync), async () => {
    const fresh = await datasetSyncs().findOne({ _id: sync._id });
    if (!fresh) return; // deleted while queued
    await runDatasetSync(fresh, { trigger: 'manual' }).catch(() => undefined);
  });
  if (queued) void datasetSyncs().updateOne({ _id: sync._id }, { $set: { queuedAt: new Date() } });
  return queued;
}

/**
 * At startup (#439): syncs claimed or queued by the previous process but never started (queuedAt still set) are
 * due again. A sync whose run is in progress (resumed by #416) is left to that run.
 */
export async function requeueLostDatasetSyncs() {
  const lost = await datasetSyncs()
    .find({ queuedAt: { $exists: true } }, { projection: { _id: 1 } })
    .toArray();
  let n = 0;
  for (const { _id } of lost) {
    const live = await datasetSyncRuns().findOne(
      { syncId: _id, status: 'running' },
      { projection: { _id: 1 } },
    );
    const r = await datasetSyncs().updateOne(
      { _id },
      live ? { $unset: { queuedAt: '' } } : { $set: { nextRunAt: new Date() }, $unset: { queuedAt: '' } },
    );
    if (r.modifiedCount && !live) n++;
  }
  return n;
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
          $or: [
            { startedAt: { $gt: new Date(Date.now() - STALE_RUN_MS) } },
            { heartbeatAt: { $gt: new Date(Date.now() - HEARTBEAT_STALE_MS) } },
          ],
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
