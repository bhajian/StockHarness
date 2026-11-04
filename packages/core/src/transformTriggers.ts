// Transform dependency triggers (#92): `trigger.after: [dataset:eod_prices, transform:corporate_actions]`.
// Upstream completion events (dataset.sync.completed, dataset.backfill.completed, transform.completed) are
// consumed exactly once and recorded as pending marks on the transforms that list them. When every declared
// upstream has completed since the last triggered run, and no new upstream event arrived for the debounce
// period, the marks are cleared atomically and one run is requested. Its window is the union of the
// upstream events' date ranges. The pipeline engine (#156) reuses `upstreamKey` and `eventWindow`.
import { consumeEvents } from './eventSubscriptions.js';
import type { HarnessEvent } from './harnessEvents.js';
import { safeError } from './security.js';
import { addDays, today } from './datasetSync.js';
import { transforms, type Transform } from './transforms.js';
export { triggerCycle } from './transforms.js';
import { requestTransformRun } from './transformRunner.js';

export const TRIGGER_CONSUMER = 'transform-triggers';
export const UPSTREAM_EVENTS = [
  'dataset.sync.completed',
  'dataset.backfill.completed',
  'transform.completed',
];
const debounceMs = () => (Number(process.env.TRANSFORM_TRIGGER_DEBOUNCE_SECONDS) || 60) * 1000;

export type PendingUpstream = { at: Date; eventId: string; date_from?: string; date_to?: string };
export type TriggerState = {
  pending?: Record<string, PendingUpstream>;
  lastEventAt?: Date;
  lastFiredAt?: Date;
};
type Triggered = Transform & { triggerState?: TriggerState };

/** `dataset:<collection>` or `transform:<name>` for an upstream completion event. */
export function upstreamKey(e: Pick<HarnessEvent, 'type' | 'data'>): string | undefined {
  const p = (e.data ?? {}) as Record<string, unknown>;
  if ((e.type === 'dataset.sync.completed' || e.type === 'dataset.backfill.completed') && p.collection)
    return `dataset:${String(p.collection)}`;
  if (e.type === 'transform.completed' && p.transform) return `transform:${String(p.transform)}`;
  return undefined;
}
/** The date range an upstream event covered, when it says (a sync/backfill range or a transform window). */
export function eventWindow(e: Pick<HarnessEvent, 'data'>): { date_from?: string; date_to?: string } {
  const p = (e.data ?? {}) as Record<string, any>;
  const from = p.date_from ?? p.window?.start;
  const to = p.date_to ?? p.window?.end;
  return { ...(from ? { date_from: String(from) } : {}), ...(to ? { date_to: String(to) } : {}) };
}
/** The run window for a set of pending upstreams: min start .. max end; the last day when none say. */
export function triggeredWindow(pending: PendingUpstream[], now = today()) {
  const starts = pending.map((p) => p.date_from).filter(Boolean) as string[];
  const ends = pending.map((p) => p.date_to ?? p.date_from).filter(Boolean) as string[];
  const end = ends.length ? ends.sort().at(-1)! : now;
  const start = starts.length ? starts.sort()[0] : end;
  return { start: start > end ? end : start, end };
}

/** Record one upstream event on every enabled transform that waits for it (idempotent). */
export async function recordUpstream(e: HarnessEvent) {
  const key = upstreamKey(e);
  if (!key) return 0;
  const mark: PendingUpstream = {
    at: new Date(e.createdAt ?? Date.now()),
    eventId: e._id,
    ...eventWindow(e),
  };
  const r = await transforms().updateMany(
    { ownerId: e.ownerId, enabled: true, 'trigger.after': key } as Record<string, unknown>,
    [
      {
        $set: {
          // Keep the widest range when the same upstream completes twice before the run fires.
          [`triggerState.pending.${key}`]: {
            at: mark.at,
            eventId: mark.eventId,
            ...(mark.date_from
              ? {
                  date_from: {
                    $min: [
                      mark.date_from,
                      { $ifNull: [`$triggerState.pending.${key}.date_from`, mark.date_from] },
                    ],
                  },
                }
              : {}),
            ...(mark.date_to
              ? {
                  date_to: {
                    $max: [mark.date_to, { $ifNull: [`$triggerState.pending.${key}.date_to`, mark.date_to] }],
                  },
                }
              : {}),
          },
          'triggerState.lastEventAt': new Date(),
        },
      },
    ],
  );
  return r.modifiedCount;
}

/** Request runs for transforms whose upstreams have all completed and settled. Returns the transforms fired. */
export async function fireReadyTriggers(
  now = new Date(),
  opts: { autostart?: boolean; ownerId?: string } = {},
) {
  const candidates = (await transforms()
    .find({
      ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
      enabled: true,
      'trigger.after.0': { $exists: true },
      'triggerState.lastEventAt': { $lte: new Date(now.getTime() - debounceMs()) },
    } as Record<string, unknown>)
    .limit(50)
    .toArray()) as Triggered[];
  const fired: string[] = [];
  for (const t of candidates) {
    const pending = t.triggerState?.pending ?? {};
    if (!t.trigger.after.every((a) => pending[a])) continue;
    // Claim: clear exactly the marks we saw; a concurrent dispatcher (or a newer event) makes this a no-op.
    const claimed = await transforms().updateOne(
      { _id: t._id, 'triggerState.lastEventAt': t.triggerState!.lastEventAt } as Record<string, unknown>,
      { $unset: { 'triggerState.pending': '' }, $set: { 'triggerState.lastFiredAt': now } } as Record<
        string,
        unknown
      >,
    );
    if (!claimed.modifiedCount) continue;
    const ups = t.trigger.after.map((a) => pending[a]);
    const w = triggeredWindow(ups);
    const long = addDays(w.start, 366) < w.end;
    await requestTransformRun(t.ownerId, t._id, {
      trigger: 'event',
      range: long ? 'full' : 'custom',
      start: w.start,
      end: w.end,
      ...(opts.autostart === false ? { autostart: false } : {}),
    }).catch((e) => console.warn(`Triggered run of ${t.name} failed to queue:`, safeError(e)));
    fired.push(t.name);
  }
  return fired;
}

/** Fired every tick: consume upstream completions, then start the transforms that are ready. */
export async function dispatchTransformTriggers() {
  await consumeEvents(TRIGGER_CONSUMER, { types: UPSTREAM_EVENTS }, async (e) => {
    await recordUpstream(e);
  });
  return fireReadyTriggers();
}
