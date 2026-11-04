// Event subscriptions (#81): consumers (transforms, pipelines, live runs) act on events such as
// `dataset.sync.completed` instead of timers. Each consumer keeps a high-water mark over the time-ordered
// harness event feed, and claims every event with a unique (consumer, event) record, so an event is
// handled once per consumer even across restarts and concurrent pollers. A handler that crashes leaves its
// claim to expire and the event is redelivered, so handlers should be idempotent.
import { collection } from './db.js';
import { safeError } from './security.js';
import type { HarnessEvent } from './harnessEvents.js';

type Consumer = { _id: string; after?: string; updatedAt: Date };
type Claim = {
  _id: string; // `${consumerId}:${eventId}`
  consumerId: string;
  eventId: string;
  status: 'claimed' | 'done' | 'failed';
  attempts: number;
  leaseUntil: Date;
  error?: string;
  updatedAt: Date;
};
const feed = () => collection<HarnessEvent>('harness_events');
const consumers = () => collection<Consumer>('event_consumers');
const claims = () => collection<Claim>('event_claims');
const LEASE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export type EventFilter = { types: string[]; ownerId?: string; match?: (e: HarnessEvent) => boolean };

/**
 * Process new events for `consumerId`. Returns the number handled. Safe to call from every tick: events
 * already claimed (by this or another process) are skipped; expired claims of crashed handlers are retried.
 */
export async function consumeEvents(
  consumerId: string,
  filter: EventFilter,
  handler: (e: HarnessEvent) => Promise<void>,
  opts: { batch?: number; now?: () => Date } = {},
) {
  const now = opts.now ?? (() => new Date());
  const state = (await consumers().findOne({ _id: consumerId })) ?? { _id: consumerId, updatedAt: now() };
  const q: Record<string, unknown> = { type: { $in: filter.types } };
  if (filter.ownerId) q.ownerId = filter.ownerId;
  // New events after the high-water mark, plus any whose claim expired (a crashed handler).
  const expired = await claims()
    .find({ consumerId, status: 'claimed', leaseUntil: { $lt: now() }, attempts: { $lt: MAX_ATTEMPTS } })
    .project<{ eventId: string }>({ eventId: 1 })
    .toArray();
  const fresh = await feed()
    .find({ ...q, ...(state.after ? { _id: { $gt: state.after } } : {}) })
    .sort({ _id: 1 })
    .limit(opts.batch ?? 200)
    .toArray();
  const retry = expired.length
    ? await feed()
        .find({ ...q, _id: { $in: expired.map((x) => x.eventId) } })
        .toArray()
    : [];
  let handled = 0;
  let mark = state.after;
  for (const e of [...retry, ...fresh]) {
    const isFresh = !mark || e._id > mark;
    if (filter.match && !filter.match(e)) {
      if (isFresh) mark = e._id;
      continue;
    }
    const id = `${consumerId}:${e._id}`;
    // Exactly-once claim: insert succeeds for one claimant; a retry takes over only an expired lease.
    let claimed = false;
    try {
      await claims().insertOne({
        _id: id,
        consumerId,
        eventId: e._id,
        status: 'claimed',
        attempts: 1,
        leaseUntil: new Date(now().getTime() + LEASE_MS),
        updatedAt: now(),
      });
      claimed = true;
    } catch {
      const r = await claims().updateOne(
        { _id: id, status: 'claimed', leaseUntil: { $lt: now() }, attempts: { $lt: MAX_ATTEMPTS } },
        {
          $set: { leaseUntil: new Date(now().getTime() + LEASE_MS), updatedAt: now() },
          $inc: { attempts: 1 },
        },
      );
      claimed = r.modifiedCount === 1;
    }
    if (claimed) {
      try {
        await handler(e);
        await claims().updateOne(
          { _id: id },
          { $set: { status: 'done', updatedAt: now() }, $unset: { error: '' } },
        );
        handled++;
      } catch (error) {
        // Leave the claim to expire so the event is redelivered; give up after MAX_ATTEMPTS.
        const c = await claims().findOne({ _id: id });
        await claims().updateOne(
          { _id: id },
          {
            $set: {
              error: safeError(error),
              updatedAt: now(),
              ...(c && c.attempts >= MAX_ATTEMPTS
                ? { status: 'failed' as const }
                : { leaseUntil: new Date(now().getTime() + 1000) }),
            },
          },
        );
      }
    }
    if (isFresh) mark = e._id;
  }
  if (mark && mark !== state.after)
    await consumers().updateOne(
      { _id: consumerId },
      { $set: { after: mark, updatedAt: now() } },
      { upsert: true },
    );
  return handled;
}

/** Recent dataset events for one sync (newest first), for its Runs view. */
export async function syncEvents(ownerId: string, syncId: string, limit = 50) {
  return feed()
    .find({ ownerId, type: { $regex: '^dataset\\.' }, 'data.sync_id': syncId })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();
}
