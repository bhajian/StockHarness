// Event-driven dataset syncs (#82). `trigger.after: [dataset:X, transform:Y]` runs a sync once all of them have
// completed since its last triggered run (the same exactly-once consumer and debounce as transform triggers, #92).
// `trigger.afterEarnings: { days: N }` runs it once a day for just the companies that reported N days ago
// (earnings_calendar), e.g. statements and estimates two days after each report.
import { consumeEvents } from './eventSubscriptions.js';
import type { HarnessEvent } from './harnessEvents.js';
import { mongo } from './db.js';
import { HttpError, safeError } from './security.js';
import { workspaceDatabase } from './mongoMcp.js';
import { catalogById } from './datasetCatalog.js';
import {
  addDays,
  datasetSyncs,
  effectivePriority,
  runDatasetSync,
  syncQueue,
  type DatasetSync,
} from './datasetSync.js';
import { UPSTREAM_EVENTS, upstreamKey } from './transformTriggers.js';
import { transforms } from './transforms.js';

export const SYNC_TRIGGER_CONSUMER = 'sync-triggers';
const debounceMs = () => (Number(process.env.TRANSFORM_TRIGGER_DEBOUNCE_SECONDS) || 60) * 1000;
type Triggered = DatasetSync & {
  triggerState?: {
    pending?: Record<string, { at: Date }>;
    lastEventAt?: Date;
    lastFiredAt?: Date;
    earningsCheckedOn?: string;
  };
};
const target = (s: Pick<DatasetSync, 'dataset' | 'targetCollection'>) =>
  s.targetCollection || catalogById.get(s.dataset)?.defaultCollection || '';

/** Problems with a sync's triggers: unknown upstreams, a sync triggering itself, earnings without a calendar. */
export async function syncTriggerProblems(
  ownerId: string,
  s: Pick<DatasetSync, 'dataset' | 'targetCollection' | 'trigger'>,
  selfId?: string,
) {
  const problems: string[] = [];
  if (!s.trigger) return problems;
  const syncs = await datasetSyncs()
    .find({ ownerId }, { projection: { dataset: 1, targetCollection: 1 } })
    .toArray();
  const targets = new Set(syncs.filter((x) => x._id !== selfId).map(target));
  for (const a of s.trigger.after ?? []) {
    const [kind, ref] = a.split(':');
    if (kind === 'dataset' && ref === target(s))
      problems.push(`Trigger ${a}: a sync cannot run after itself`);
    else if (kind === 'dataset' && !targets.has(ref))
      problems.push(`Trigger ${a}: no other dataset sync writes ${ref}`);
    if (
      kind === 'transform' &&
      !(await transforms().findOne({ ownerId, name: ref }, { projection: { _id: 1 } }))
    )
      problems.push(`Trigger ${a}: no transform named ${ref}`);
  }
  if (s.trigger.afterEarnings && !syncs.some((x) => x.dataset === 'earnings_calendar'))
    problems.push('After earnings needs an earnings calendar sync (dataset earnings_calendar)');
  return problems;
}
export async function assertSyncTriggers(
  ownerId: string,
  s: Pick<DatasetSync, 'dataset' | 'targetCollection' | 'trigger'>,
  selfId?: string,
) {
  const p = await syncTriggerProblems(ownerId, s, selfId);
  if (p.length) throw new HttpError(400, p.join('; '));
}

/** Record one upstream completion on every enabled sync that waits for it. */
export async function recordSyncUpstream(e: HarnessEvent) {
  const key = upstreamKey(e);
  if (!key) return 0;
  const r = await datasetSyncs().updateMany(
    { ownerId: e.ownerId, enabled: true, 'trigger.after': key } as Record<string, unknown>,
    {
      $set: {
        [`triggerState.pending.${key}`]: { at: new Date(e.createdAt ?? Date.now()) },
        'triggerState.lastEventAt': new Date(),
      },
    } as Record<string, unknown>,
  );
  return r.modifiedCount;
}

function enqueue(sync: DatasetSync, opts: { scheduleKey: string; symbols?: string[] }) {
  return syncQueue.enqueue(`${sync._id}:${opts.scheduleKey}`, effectivePriority(sync), async () => {
    const fresh = await datasetSyncs().findOne({ _id: sync._id });
    if (!fresh?.enabled) return;
    await runDatasetSync(fresh, { trigger: 'event', ...opts }).catch((e) =>
      console.warn(`Triggered sync ${sync.name} failed:`, safeError(e)),
    );
  });
}

/** Start syncs whose upstreams all completed and settled. Returns the names started. */
export async function fireReadySyncTriggers(now = new Date(), opts: { ownerId?: string } = {}) {
  const ready = (await datasetSyncs()
    .find({
      ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
      enabled: true,
      'trigger.after.0': { $exists: true },
      'triggerState.lastEventAt': { $lte: new Date(now.getTime() - debounceMs()) },
    } as Record<string, unknown>)
    .limit(50)
    .toArray()) as Triggered[];
  const fired: string[] = [];
  for (const s of ready) {
    const pending = s.triggerState?.pending ?? {};
    if (!s.trigger!.after.every((a) => pending[a])) continue;
    const claimed = await datasetSyncs().updateOne(
      { _id: s._id, 'triggerState.lastEventAt': s.triggerState!.lastEventAt } as Record<string, unknown>,
      { $unset: { 'triggerState.pending': '' }, $set: { 'triggerState.lastFiredAt': now } } as Record<
        string,
        unknown
      >,
    );
    if (!claimed.modifiedCount) continue;
    enqueue(s, { scheduleKey: `after:${s._id}:${now.toISOString()}` });
    fired.push(s.name);
  }
  return fired;
}

/** Once a day per sync: the symbols that reported earnings `days` ago, within the sync's own symbol scope. */
export async function fireEarningsTriggers(now = new Date(), opts: { ownerId?: string } = {}) {
  const day = now.toISOString().slice(0, 10);
  const due = (await datasetSyncs()
    .find({
      ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
      enabled: true,
      'trigger.afterEarnings': { $exists: true },
      'triggerState.earningsCheckedOn': { $ne: day },
    } as Record<string, unknown>)
    .limit(50)
    .toArray()) as Triggered[];
  const fired: { name: string; symbols: string[] }[] = [];
  for (const s of due) {
    const claimed = await datasetSyncs().updateOne(
      { _id: s._id, 'triggerState.earningsCheckedOn': { $ne: day } } as Record<string, unknown>,
      { $set: { 'triggerState.earningsCheckedOn': day } } as Record<string, unknown>,
    );
    if (!claimed.modifiedCount) continue;
    const cal = await datasetSyncs().findOne({ ownerId: s.ownerId, dataset: 'earnings_calendar' });
    const db = mongo.db(workspaceDatabase(s.ownerId));
    const reported = addDays(day, -s.trigger!.afterEarnings!.days);
    const rows = await db
      .collection(cal ? target(cal) : 'earnings_calendar')
      .find({ date: reported }, { projection: { symbol: 1, _id: 0 } })
      .toArray();
    let symbols = [...new Set(rows.map((r) => String(r.symbol)).filter(Boolean))];
    if (s.symbolsMode === 'list') symbols = symbols.filter((x) => s.symbols?.includes(x));
    else if (s.symbolsMode === 'universe') {
      const uni = new Set(
        (await db.collection('universe').distinct('symbol', { symbol: { $in: symbols } })) as string[],
      );
      symbols = symbols.filter((x) => uni.has(x));
    }
    if (!symbols.length) continue;
    enqueue(s, { scheduleKey: `earnings:${s._id}:${day}`, symbols: symbols.sort() });
    fired.push({ name: s.name, symbols });
  }
  return fired;
}

/** Fired every tick. */
export async function dispatchSyncTriggers(now = new Date()) {
  await consumeEvents(SYNC_TRIGGER_CONSUMER, { types: UPSTREAM_EVENTS }, async (e) => {
    await recordSyncUpstream(e);
  });
  await fireReadySyncTriggers(now);
  await fireEarningsTriggers(now);
}
