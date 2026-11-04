// Backfill mode (#80): pull a sync's history in persisted, resumable batches, separately from its
// incremental run. Batches are symbol groups (one FMP call per symbol covers up to ~19 years of daily bars
// or 200 statement periods) or date windows for calendars. Progress is stored after every symbol, so a
// restart resumes where it stopped. Every FMP call runs at BACKFILL priority, below all scheduled syncs.
// The sync's incremental cursor is never touched; writes are idempotent upserts on the dataset key.
import { randomUUID } from 'node:crypto';
import { mongo, collection } from './db.js';
import { workspaceDatabase } from './mongoMcp.js';
import { HttpError, safeError } from './security.js';
import { catalogById, type DatasetDef } from './datasetCatalog.js';
import {
  addDays,
  chunkRanges,
  datasetSyncs,
  fmpApiKey,
  fmpGet,
  perSymbolParams,
  resolveSymbols,
  syncContext,
  today,
  upsertRows,
  type DatasetSync,
} from './datasetSync.js';
import { refreshCatalogEntry } from './schemaCatalog.js';
import { emitHarnessEvent } from './harnessEvents.js';

export type BackfillStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type BackfillBatch = {
  i: number;
  label: string;
  /** symbols mode: [start, end) indexes into `symbols`; window mode: the date range. */
  start?: number;
  end?: number;
  from?: string;
  to?: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  /** Next symbol index to process inside the batch (resume point). */
  next?: number;
  rows: number;
  errors: number;
  attempts: number;
  error?: string;
};
export type Backfill = {
  _id: string;
  ownerId: string;
  syncId: string;
  syncName: string;
  dataset: string;
  mode: 'symbols' | 'windows' | 'fixed' | 'single';
  status: BackfillStatus;
  from: string;
  to: string;
  symbols?: string[];
  batches: BackfillBatch[];
  rows: number;
  calls: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  lastError?: string;
  requestedBy?: string;
};
export const backfills = () => collection<Backfill>('dataset_backfills');
const ACTIVE: BackfillStatus[] = ['queued', 'running', 'paused'];
/** One request may return at most ~5,000 daily bars (FMP cap): split longer ranges. */
const MAX_YEARS_PER_REQUEST = 18;

/** Why a dataset cannot be backfilled, or undefined when it can. */
export function backfillUnsupported(def: DatasetDef): string | undefined {
  if (def.snapshotDated)
    return 'Weekly snapshot data: FMP keeps no history, so there is nothing to backfill.';
  if (def.scope === 'feed') return 'Latest-items feed: FMP serves no history for it.';
  if (
    def.perSymbol &&
    def.incremental === 'snapshot' &&
    typeof def.params?.limit !== 'number' &&
    !def.dateField
  )
    return 'Current values only: there is no history to backfill.';
  if (!def.perSymbol && !def.fixedSymbols && def.incremental !== 'window' && !def.supportsDateRange)
    return 'This market dataset has no history parameter to backfill.';
  return undefined;
}

/** Split [from, to] into ranges of at most `years` years. */
export function yearRanges(from: string, to: string, years = MAX_YEARS_PER_REQUEST): [string, string][] {
  const out: [string, string][] = [];
  let a = from;
  while (a <= to) {
    const b = addDays(a, Math.round(years * 365.25) - 1);
    out.push([a, b > to ? to : b]);
    a = addDays(b, 1);
  }
  return out;
}

/** Plan the batches for a backfill (pure; unit-tested). */
export function planBackfill(
  def: DatasetDef,
  from: string,
  to: string,
  symbols: string[] = [],
  batchSize = 25,
): Pick<Backfill, 'mode' | 'batches'> {
  const batch = (i: number, label: string, extra: Partial<BackfillBatch>): BackfillBatch => ({
    i,
    label,
    status: 'pending',
    rows: 0,
    errors: 0,
    attempts: 0,
    ...extra,
  });
  if (def.perSymbol) {
    const batches: BackfillBatch[] = [];
    for (let s = 0, i = 0; s < symbols.length; s += batchSize, i++) {
      const end = Math.min(symbols.length, s + batchSize);
      batches.push(batch(i, `${symbols[s]} – ${symbols[end - 1]} (${end - s})`, { start: s, end, next: s }));
    }
    return { mode: 'symbols', batches };
  }
  if (def.fixedSymbols) return { mode: 'fixed', batches: [batch(0, def.fixedSymbols.join(', '), {})] };
  if (def.incremental === 'window')
    return {
      mode: 'windows',
      batches: chunkRanges(from, to, 60).map(([a, b], i) => batch(i, `${a} → ${b}`, { from: a, to: b })),
    };
  return { mode: 'single', batches: [batch(0, `${from} → ${to}`, { from, to })] };
}

export async function createBackfill(
  ownerId: string,
  syncId: string,
  opts: { from?: string; to?: string; batchSize?: number; requestedBy?: string; autostart?: boolean } = {},
) {
  const sync = await datasetSyncs().findOne({ _id: syncId, ownerId });
  if (!sync) throw new HttpError(404, 'Dataset sync not found');
  const def = catalogById.get(sync.dataset);
  if (!def) throw new HttpError(400, `Unknown dataset: ${sync.dataset}`);
  const why = backfillUnsupported(def);
  if (why) throw new HttpError(400, why);
  if (await backfills().findOne({ ownerId, syncId, status: { $in: ACTIVE } }))
    throw new HttpError(409, 'A backfill for this sync is already queued, running or paused');
  const to = opts.to ?? today();
  const from = opts.from ?? sync.from ?? addDays(to, -Math.round(10 * 365.25));
  if (from > to) throw new HttpError(400, 'from must be on or before to');
  let symbols: string[] | undefined;
  if (def.perSymbol) {
    const apikey = await fmpApiKey(ownerId, sync.connectionId);
    symbols = await syncContext.run({ priority: 'BACKFILL' }, () =>
      resolveSymbols(sync, mongo.db(workspaceDatabase(ownerId)), apikey),
    );
  }
  const plan = planBackfill(def, from, to, symbols, Math.max(1, Math.min(500, opts.batchSize ?? 25)));
  const now = new Date();
  const doc: Backfill = {
    _id: randomUUID(),
    ownerId,
    syncId,
    syncName: sync.name,
    dataset: sync.dataset,
    status: 'queued',
    from,
    to,
    ...(symbols ? { symbols } : {}),
    ...plan,
    rows: 0,
    calls: 0,
    createdAt: now,
    updatedAt: now,
    ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
  };
  await backfills().insertOne(doc);
  if (opts.autostart !== false) void dispatchBackfills();
  return doc;
}

/** Progress for the UI: % of batches (symbols in progress count partly), ETA from the observed pace. */
export function backfillProgress(b: Backfill) {
  const total = b.batches.length || 1;
  let done = 0;
  for (const x of b.batches) {
    if (x.status === 'done' || x.status === 'failed') done += 1;
    else if (x.status === 'running' && x.start !== undefined && x.end !== undefined && x.next !== undefined)
      done += (x.next - x.start) / Math.max(1, x.end - x.start);
  }
  const pct = Math.round((done / total) * 1000) / 10;
  const elapsed = b.startedAt ? Date.now() - new Date(b.startedAt).getTime() : 0;
  const etaMs =
    b.status === 'running' && done > 0 ? Math.round((elapsed / done) * (total - done)) : undefined;
  return {
    pct,
    batchesDone: b.batches.filter((x) => x.status === 'done').length,
    batchesFailed: b.batches.filter((x) => x.status === 'failed').length,
    batchesTotal: b.batches.length,
    etaMs,
  };
}

export async function backfillAction(
  ownerId: string,
  syncId: string,
  action: 'pause' | 'resume' | 'cancel' | 'retry',
  opts: { autostart?: boolean } = {},
) {
  const b = await backfills().find({ ownerId, syncId }).sort({ createdAt: -1 }).limit(1).next();
  if (!b) throw new HttpError(404, 'No backfill for this sync');
  const set = (status: BackfillStatus, extra: Partial<Backfill> = {}) =>
    backfills().updateOne({ _id: b._id }, { $set: { status, updatedAt: new Date(), ...extra } });
  if (action === 'pause') {
    if (!['queued', 'running'].includes(b.status))
      throw new HttpError(409, `Cannot pause a ${b.status} backfill`);
    await set('paused');
  } else if (action === 'resume') {
    if (b.status !== 'paused') throw new HttpError(409, `Cannot resume a ${b.status} backfill`);
    await set('queued');
  } else if (action === 'cancel') {
    if (!ACTIVE.includes(b.status)) throw new HttpError(409, `Cannot cancel a ${b.status} backfill`);
    await set('cancelled', { finishedAt: new Date() });
  } else {
    if (!['failed', 'completed'].includes(b.status) || !b.batches.some((x) => x.status === 'failed'))
      throw new HttpError(409, 'Nothing to retry');
    const batches = b.batches.map((x) =>
      x.status === 'failed' ? { ...x, status: 'pending' as const, next: x.start, error: undefined } : x,
    );
    await set('queued', { batches, finishedAt: undefined });
  }
  if (opts.autostart !== false) void dispatchBackfills();
  return backfills().findOne({ _id: b._id });
}

/** After a restart, backfills that were running resume (they are persisted, not lost). */
export async function recoverBackfills() {
  const r = await backfills().updateMany(
    { status: 'running' },
    { $set: { status: 'queued', updatedAt: new Date() } },
  );
  return r.modifiedCount;
}

let working = false;
/** Called from the dispatcher tick: runs at most one backfill at a time, in the background. */
export async function dispatchBackfills() {
  if (working) return;
  const job = await backfills().findOneAndUpdate(
    { status: 'queued' },
    { $set: { status: 'running', updatedAt: new Date() } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  if (!job) return;
  working = true;
  void runBackfill(job)
    .catch(async (e) => {
      await backfills().updateOne(
        { _id: job._id },
        {
          $set: { status: 'failed', lastError: safeError(e), finishedAt: new Date(), updatedAt: new Date() },
        },
      );
    })
    .finally(() => {
      working = false;
      void dispatchBackfills();
    });
}

/** Process one backfill until done, paused or cancelled. Exported for tests. */
export async function runBackfill(job: Backfill) {
  const sync = await datasetSyncs().findOne({ _id: job.syncId, ownerId: job.ownerId });
  if (!sync) throw new Error('The dataset sync was deleted');
  const def = catalogById.get(job.dataset)!;
  const apikey = await fmpApiKey(job.ownerId, sync.connectionId);
  const coll = mongo
    .db(workspaceDatabase(job.ownerId))
    .collection(sync.targetCollection || def.defaultCollection);
  await coll.createIndex(Object.fromEntries(def.keyFields.map((k) => [k, 1]))).catch(() => undefined);
  if (!job.startedAt) await backfills().updateOne({ _id: job._id }, { $set: { startedAt: new Date() } });
  const live = async () =>
    (await backfills().findOne({ _id: job._id }, { projection: { status: 1 } }))?.status;
  const save = (i: number, batch: Partial<BackfillBatch>, inc: { rows?: number; calls?: number } = {}) =>
    backfills().updateOne(
      { _id: job._id },
      {
        $set: Object.fromEntries(Object.entries(batch).map(([k, v]) => [`batches.${i}.${k}`, v])),
        $inc: { rows: inc.rows ?? 0, calls: inc.calls ?? 0 },
        $currentDate: { updatedAt: true },
      },
    );
  const call = (params: Record<string, string | number>) =>
    syncContext.run({ priority: 'BACKFILL' }, () => fmpGet(def.endpoint, params, apikey));

  await syncContext.run({ priority: 'BACKFILL' }, async () => {
    for (const b of job.batches) {
      if (b.status === 'done' || b.status === 'failed') continue;
      const status = await live();
      if (status !== 'running') return; // paused or cancelled between batches
      await save(b.i, { status: 'running', attempts: b.attempts + 1 });
      let rows = 0;
      let errors = 0;
      let lastErr: string | undefined;
      try {
        if (job.mode === 'symbols') {
          for (let k = b.next ?? b.start!; k < b.end!; k++) {
            if (k % 5 === 0 && (await live()) !== 'running') return; // pause within a batch, resumes at k
            const symbol = job.symbols![k];
            let symRows = 0;
            let symCalls = 0;
            try {
              // Time series: split ranges beyond the per-request cap; limit-based: one call at the sync's depth.
              const ranges =
                def.incremental === 'timeseries' ? yearRanges(job.from, job.to) : [[job.from, job.to]];
              for (const [a, z] of ranges) {
                const params = perSymbolParams(def, { ...sync, cursor: undefined, from: a }, symbol, z);
                if (def.incremental === 'timeseries') Object.assign(params, { from: a, to: z });
                const data = await call(params);
                symCalls++;
                const list = Array.isArray(data) ? data : data ? [data] : [];
                for (const r of list)
                  if (r && typeof r === 'object') {
                    (r as Record<string, unknown>).symbol = symbol;
                    if (params.period) (r as Record<string, unknown>).period ??= params.period;
                  }
                symRows += await upsertRows(coll, list, def.keyFields);
              }
            } catch (e) {
              errors++;
              lastErr = `${symbol}: ${safeError(e)}`;
            }
            rows += symRows;
            await save(
              b.i,
              { next: k + 1, rows, errors, ...(lastErr ? { error: lastErr } : {}) },
              { rows: symRows, calls: symCalls },
            );
          }
        } else if (job.mode === 'fixed') {
          for (const symbol of def.fixedSymbols!) {
            for (const [a, z] of yearRanges(job.from, job.to)) {
              const data = await call({ symbol, from: a, to: z });
              const list = Array.isArray(data) ? data : [];
              for (const r of list)
                if (r && typeof r === 'object') (r as Record<string, unknown>).symbol = symbol;
              const n = await upsertRows(coll, list, def.keyFields);
              rows += n;
              await save(b.i, { rows }, { rows: n, calls: 1 });
            }
          }
        } else {
          const data = await call({ ...(def.params ?? {}), from: b.from!, to: b.to! });
          const n = await upsertRows(coll, Array.isArray(data) ? data : [], def.keyFields);
          rows += n;
          await save(b.i, { rows }, { rows: n, calls: 1 });
        }
        // A batch where most symbols failed is retried later rather than counted as done.
        const size = job.mode === 'symbols' ? b.end! - b.start! : 1;
        const failed = job.mode === 'symbols' ? errors > size / 2 : false;
        await save(b.i, {
          status: failed ? 'failed' : 'done',
          rows,
          errors,
          ...(lastErr ? { error: lastErr } : {}),
        });
      } catch (e) {
        await save(b.i, { status: 'failed', rows, errors: errors + 1, error: safeError(e) });
      }
    }
  });
  const final = await backfills().findOne({ _id: job._id });
  if (!final || final.status !== 'running') return; // paused / cancelled
  const anyFailed = final.batches.some((x) => x.status === 'failed');
  await backfills().updateOne(
    { _id: job._id },
    {
      $set: {
        status: anyFailed ? 'failed' : 'completed',
        finishedAt: new Date(),
        updatedAt: new Date(),
        ...(anyFailed
          ? {
              lastError: `${final.batches.filter((x) => x.status === 'failed').length} batch(es) failed; retry them`,
            }
          : {}),
      },
    },
  );
  const done = (await backfills().findOne({ _id: job._id }))!;
  await emitHarnessEvent(job.ownerId, anyFailed ? 'dataset.backfill.failed' : 'dataset.backfill.completed', {
    sync_id: job.syncId,
    sync_name: job.syncName,
    dataset: job.dataset,
    collection: sync.targetCollection || def.defaultCollection,
    backfill_id: job._id,
    date_from: job.from,
    date_to: job.to,
    rows: done.rows,
    calls: done.calls,
    failed_batches: done.batches.filter((x) => x.status === 'failed').length,
  });
  void refreshCatalogEntry(job.ownerId, sync.targetCollection || def.defaultCollection).catch(
    () => undefined,
  );
}
