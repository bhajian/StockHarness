// #543: what the Research board says about each idea. Who has it now, what is happening to it, how far along the
// pipeline it is, and the cycle (C-n, like a sprint tag) that last worked on it. Pure functions plus the cycle
// numbering, so the wording is unit-tested without a database.
import { collection } from './db.js';
import type { Theory } from './theories.js';

/** The stages a card moves through, left to right; the progress bar has one segment per stage. */
export const STAGES = ['Draft', 'Pre-review', 'Coding', 'Evaluating', 'Post-review', 'Verdict'] as const;
const STAGE_OF: Record<string, number> = {
  draft: 0,
  revise: 0,
  pre_review: 1,
  approved_for_code: 2,
  coding: 2,
  code_error: 2,
  revise_code: 2,
  evaluated: 3,
  post_review: 4,
};
export const stageOf = (status: string) => STAGE_OF[status] ?? STAGES.length - 1;

/** The loop's agent steps (workflow node ids) and who they are, in words. */
export const STEP_NAMES: Record<string, string> = {
  start: 'Starting',
  theorists: 'Theorists',
  judge_pre: 'Judge (pre-code)',
  coder: 'Coder',
  judge_post: 'Judge (post-result)',
  finish: 'Finishing',
};
/** A node id to its step: the parallel Theorists report as theorist_1, theorist_2, … */
export const stepOf = (nodeId?: string | null) =>
  !nodeId ? undefined : nodeId.startsWith('theorist') ? 'theorists' : nodeId;

export type Who = 'theorist' | 'judge' | 'coder' | 'evaluator' | 'none';
export type Activity = {
  /** Who holds the idea now, or would pick it up next. */
  who: Who;
  /** One line: what is happening to it. */
  text: string;
  /** An agent (or an evaluation job) is on it right now. */
  active: boolean;
};

export type ActivityInput = {
  status: string;
  codeAttempts?: number;
  rebuild?: boolean;
  /** The running cycle's current step (stepOf its cursor), if a cycle is running. */
  step?: string;
  /** The idea the running step is looking at, from its latest tool call (T-n). */
  focusRef?: string;
  ref: string;
  /** An evaluation of this idea is queued or running, and since when. */
  evaluation?: { status: string; since?: Date | string };
  /** 1-based place in its queue (the agents take theirs in number order). */
  queuePosition?: number;
  queueSize?: number;
};

const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
const inQueue = (o: ActivityInput) =>
  o.queuePosition && o.queueSize && o.queueSize > 1 ? `, ${ordinal(o.queuePosition)} of ${o.queueSize}` : '';
const attempt = (o: ActivityInput) => `attempt ${(o.codeAttempts ?? 0) + 1}`;

/** What is happening to one idea, in a line, for its board card. */
export function activityOf(o: ActivityInput): Activity {
  const on = (step: string) => o.step === step;
  const focused = (step: string) => on(step) && o.focusRef === o.ref;
  switch (o.status) {
    case 'draft':
      return on('theorists')
        ? { who: 'theorist', text: 'The Theorists are writing this cycle', active: true }
        : { who: 'theorist', text: 'Draft, waiting for its Theorist', active: false };
    case 'revise':
      return focused('theorists')
        ? { who: 'theorist', text: 'Theorist revising it now', active: true }
        : { who: 'theorist', text: 'Sent back to the Theorist to revise', active: false };
    case 'pre_review':
      return focused('judge_pre')
        ? { who: 'judge', text: 'Judge (pre-code) reviewing it now', active: true }
        : { who: 'judge', text: `Waiting for the Judge (pre-code)${inQueue(o)}`, active: false };
    case 'approved_for_code':
      return focused('coder')
        ? { who: 'coder', text: `Coder writing code now (${attempt(o)})`, active: true }
        : {
            who: 'coder',
            text: `${o.rebuild ? 'Rebuild queued' : 'Queued'} for the Coder${inQueue(o)}`,
            active: false,
          };
    case 'coding':
    case 'code_error':
    case 'revise_code': {
      if (o.evaluation && ['queued', 'running'].includes(o.evaluation.status))
        return {
          who: 'evaluator',
          text: o.evaluation.status === 'queued' ? 'Evaluation queued' : 'Evaluation running',
          active: true,
        };
      const why =
        o.status === 'code_error'
          ? 'Code failed: back with the Coder to fix'
          : o.status === 'revise_code'
            ? 'The Judge sent the code back'
            : 'Coding';
      return focused('coder') || (o.status === 'coding' && on('coder'))
        ? { who: 'coder', text: `Coder working on it now (${attempt(o)})`, active: true }
        : { who: 'coder', text: `${why} (${attempt(o)}), continues next cycle`, active: false };
    }
    case 'evaluated':
      return { who: 'evaluator', text: 'Evaluated, moving to post-review', active: false };
    case 'post_review':
      return focused('judge_post')
        ? { who: 'judge', text: 'Judge (post-result) giving its verdict now', active: true }
        : {
            who: 'judge',
            text: `Waiting for the Judge's verdict${inQueue(o)}${on('judge_post') ? ' (the Judge is on this column now)' : ''}`,
            active: false,
          };
    default:
      return { who: 'none', text: `Verdict: ${o.status.replace(/_/g, ' ')}`, active: false };
  }
}

type HistoryEntry = Theory['history'][number];
/** The latest entry an agent of a cycle wrote (actor.runId), and the latest transition (time in stage). */
export function lastTouch(history: HistoryEntry[] = []) {
  let run: HistoryEntry | undefined;
  let moved: HistoryEntry | undefined;
  for (let i = history.length - 1; i >= 0 && (!run || !moved); i--) {
    const h = history[i];
    if (!run && (h.actor as { runId?: string } | undefined)?.runId) run = h;
    if (!moved && h.type === 'transition') moved = h;
  }
  const actor = run?.actor as { runId?: string; model?: string; role?: string } | undefined;
  return {
    runId: actor?.runId,
    role: actor?.role,
    // "Provider:model" as recorded; the board shows the model.
    model: actor?.model ? actor.model.slice(actor.model.indexOf(':') + 1) : undefined,
    stageSince: moved?.at,
  };
}

/** The T-n a tool call is about: its theory_id / id argument, or the first T-n in the arguments. */
export function refInArguments(args: unknown): string | undefined {
  const s = typeof args === 'string' ? args : JSON.stringify(args ?? '');
  const m = /"(?:theory_id|theoryId|id|ref|theory)"\s*:\s*"(T-\d+)"/.exec(s) ?? /\b(T-\d+)\b/.exec(s);
  return m?.[1];
}

/** What the running cycle is doing: its step, and the idea that step looked at last (from its latest tool call). */
export function runFocus(run: {
  checkpoint?: { cursor?: string };
  events?: { type: string; nodeId?: string; data?: { arguments?: unknown } }[];
}) {
  const step = stepOf(run.checkpoint?.cursor);
  let focusRef: string | undefined;
  const events = run.events ?? [];
  // Newest first; events are in order, so one from another step means the current step's start has passed.
  for (let i = events.length - 1; i >= 0 && step; i--) {
    const e = events[i];
    if (!e.nodeId) continue;
    if (stepOf(e.nodeId) !== step) break;
    if (e.type === 'node_started' && e.nodeId === run.checkpoint?.cursor) break;
    if (e.type === 'tool_started') {
      focusRef = refInArguments(e.data?.arguments);
      if (focusRef) break;
    }
  }
  return { step, focusRef };
}

/**
 * Cycle numbers (C-n): a cycle's place among the research loop's runs by start time, from 1. Only the runs asked
 * for are numbered, one count each.
 */
export async function cycleNumbers(ownerId: string, workflowId: string, runIds: string[]) {
  const ids = [...new Set(runIds.filter(Boolean))];
  if (!ids.length) return new Map<string, number>();
  const runs = collection<{ _id: string; createdAt: Date }>('runs');
  const found = await runs
    .find({ ownerId, workflowId, _id: { $in: ids } } as Record<string, unknown>, {
      projection: { createdAt: 1 },
    })
    .toArray();
  const out = new Map<string, number>();
  await Promise.all(
    found.map(async (r) =>
      out.set(
        r._id,
        await runs.countDocuments({ ownerId, workflowId, createdAt: { $lte: r.createdAt } } as Record<
          string,
          unknown
        >),
      ),
    ),
  );
  return out;
}
