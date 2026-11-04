// Priority-aware scheduling for dataset syncs (#78): a shared FMP rate limiter that always serves the
// highest-priority waiter first (P2 can never starve P0), with one shared cooldown after a throttle, and a
// background work queue so long syncs never block the server's dispatcher tick.

export const SYNC_PRIORITIES = ['P0', 'P1', 'P2'] as const;
export type SyncPriority = (typeof SYNC_PRIORITIES)[number];
/** Limiter levels: the sync priorities, then BACKFILL, which always yields to scheduled work (#80). */
export const LIMITER_PRIORITIES = [...SYNC_PRIORITIES, 'BACKFILL'] as const;
export type LimiterPriority = (typeof LIMITER_PRIORITIES)[number];

const P0 = new Set([
  'universe',
  'eod_prices',
  'eod_index',
  'treasury_rates',
  'sector_performance',
  'earnings_calendar',
  'dividends_calendar',
  'splits_calendar',
  'dividends_history',
  'splits_history',
]);
const P2 = new Set([
  'news_stocks',
  'revenue_product_segmentation',
  'revenue_geo_segmentation',
  'stock_peers',
  'key_executives',
  'employee_count',
  'biggest_gainers',
  'most_actives',
  'economic_gdp',
  'economic_cpi',
]);
/** P0 prices / corporate actions / calendars; P2 news, segments, peers, movers; P1 everything else. */
export function defaultPriority(datasetId: string): SyncPriority {
  return P0.has(datasetId) ? 'P0' : P2.has(datasetId) ? 'P2' : 'P1';
}

type Timers = { now: () => number; setTimer: (fn: () => void, ms: number) => unknown };
const realTimers: Timers = { now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms) };

/**
 * One request slot every `60000 / rpm` ms, shared by every sync in the process. Slots are handed to the
 * highest-priority waiter (FIFO within a priority). `cooldown(ms)` pauses all slots, e.g. after an FMP 429.
 */
export class PriorityRateLimiter {
  private queues: Record<LimiterPriority, (() => void)[]> = { P0: [], P1: [], P2: [], BACKFILL: [] };
  private lastRelease = -Infinity;
  private cooldownUntil = 0;
  private timer: unknown = null;
  readonly interval: number;
  constructor(
    rpm: number,
    private timers: Timers = realTimers,
  ) {
    this.interval = 60000 / Math.max(1, rpm);
  }
  acquire(priority: LimiterPriority): Promise<void> {
    return new Promise((resolve) => {
      this.queues[priority].push(resolve);
      this.pump();
    });
  }
  /** Pause every slot for `ms` (the longest requested pause wins). */
  cooldown(ms: number) {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.timers.now() + ms);
  }
  waiting(): Record<LimiterPriority, number> {
    return {
      P0: this.queues.P0.length,
      P1: this.queues.P1.length,
      P2: this.queues.P2.length,
      BACKFILL: this.queues.BACKFILL.length,
    };
  }
  private pump() {
    if (this.timer !== null) return;
    if (!LIMITER_PRIORITIES.some((p) => this.queues[p].length)) return;
    const at = Math.max(this.lastRelease + this.interval, this.cooldownUntil);
    const wait = Math.max(0, at - this.timers.now());
    this.timer = this.timers.setTimer(() => {
      this.timer = null;
      // A cooldown may have been extended while waiting.
      if (this.timers.now() < this.cooldownUntil) return this.pump();
      const p = LIMITER_PRIORITIES.find((x) => this.queues[x].length);
      if (p) {
        this.lastRelease = this.timers.now();
        this.queues[p].shift()!();
      }
      this.pump();
    }, wait);
  }
}

type Job = { id: string; priority: SyncPriority; seq: number; run: () => Promise<unknown> };
/**
 * Background queue for sync runs: up to `concurrency` at once, highest priority first (FIFO within a priority),
 * and an id is never queued or running twice. Errors in one job never stop the queue.
 */
export class SyncWorkQueue {
  private queued: Job[] = [];
  private running = new Map<string, SyncPriority>();
  private seq = 0;
  constructor(private concurrency: number) {}
  /** Returns false when the id is already queued or running. */
  enqueue(id: string, priority: SyncPriority, run: () => Promise<unknown>): boolean {
    if (this.running.has(id) || this.queued.some((j) => j.id === id)) return false;
    this.queued.push({ id, priority, seq: this.seq++, run });
    this.queued.sort((a, b) => a.priority.localeCompare(b.priority) || a.seq - b.seq);
    this.drain();
    return true;
  }
  has(id: string) {
    return this.running.has(id) || this.queued.some((j) => j.id === id);
  }
  status() {
    return {
      running: [...this.running].map(([id, priority]) => ({ id, priority })),
      queued: this.queued.map(({ id, priority }) => ({ id, priority })),
    };
  }
  /** Resolves when nothing is queued or running (tests). */
  async idle(pollMs = 10) {
    while (this.running.size || this.queued.length) await new Promise((r) => setTimeout(r, pollMs));
  }
  private drain() {
    while (this.running.size < this.concurrency && this.queued.length) {
      const job = this.queued.shift()!;
      this.running.set(job.id, job.priority);
      void job
        .run()
        .catch(() => undefined)
        .finally(() => {
          this.running.delete(job.id);
          this.drain();
        });
    }
  }
}
