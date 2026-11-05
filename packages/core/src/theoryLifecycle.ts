// The theory lifecycle state machine (#110), pure so it is unit-tested on its own and reused by the API, the
// lifecycle MCP tools (#112) and YAML import.
//
//   draft → pre_review → (revise → pre_review)* → rejected_untestable | approved_for_code
//   approved_for_code → coding → (code_error → coding)* → evaluated → post_review → (revise_code → coding)*
//   post_review → failed | successful → (human) approved | parked
//
// Revisions (revise and revise_code together) are capped per theory (3 by default); code attempts after an error
// are capped too (5, the #153 fix loop). At a cap the way back is closed and the Judge must decide.

export const THEORY_STATES = [
  'draft',
  'pre_review',
  'revise',
  'rejected_untestable',
  'approved_for_code',
  'coding',
  'code_error',
  'evaluated',
  'post_review',
  'revise_code',
  'failed',
  'successful',
  'approved',
  'parked',
] as const;
export type TheoryState = (typeof THEORY_STATES)[number];
export const THEORY_ROLES = ['theorist', 'judge', 'coder', 'evaluator', 'human'] as const;
export type TheoryRole = (typeof THEORY_ROLES)[number];
export const TERMINAL_STATES: TheoryState[] = ['rejected_untestable', 'failed', 'approved', 'parked'];

/** Legal transitions and who may make each one. */
export const TRANSITIONS: Record<TheoryState, Partial<Record<TheoryState, TheoryRole[]>>> = {
  draft: { pre_review: ['theorist', 'human'] },
  pre_review: {
    revise: ['judge'],
    rejected_untestable: ['judge'],
    approved_for_code: ['judge'],
  },
  revise: { pre_review: ['theorist', 'human'] },
  // Humans may send any reviewed theory back to the Theorist with a comment (#122), and reject a successful one.
  rejected_untestable: { revise: ['human'] },
  approved_for_code: { coding: ['coder'] },
  coding: { code_error: ['coder', 'evaluator'], evaluated: ['evaluator', 'coder'] },
  // After the code-attempt cap, the theory goes to the Judge with the failure (#153).
  code_error: { coding: ['coder'], post_review: ['coder', 'judge', 'evaluator'] },
  evaluated: { post_review: ['evaluator', 'coder', 'judge'] },
  post_review: { revise_code: ['judge'], failed: ['judge'], successful: ['judge'], revise: ['human'] },
  revise_code: { coding: ['coder'] },
  failed: { revise: ['human'] },
  successful: { approved: ['human'], parked: ['human'], failed: ['human'], revise: ['human'] },
  approved: { parked: ['human'], failed: ['human'], revise: ['human'] },
  parked: { revise: ['human'] },
};

export type LifecycleCaps = { maxRevisions: number; maxCodeAttempts: number };
export const DEFAULT_CAPS: LifecycleCaps = { maxRevisions: 3, maxCodeAttempts: 5 };
export type LifecycleCounts = { revisions: number; codeAttempts: number };

/** Why `from → to` by `role` is not allowed (undefined when it is). */
export function transitionProblem(
  from: TheoryState,
  to: TheoryState,
  role: TheoryRole,
  counts: LifecycleCounts,
  caps: LifecycleCaps = DEFAULT_CAPS,
): string | undefined {
  if (!THEORY_STATES.includes(to)) return `Unknown state ${to}`;
  const roles = TRANSITIONS[from]?.[to];
  if (!roles) {
    const next = Object.keys(TRANSITIONS[from] ?? {});
    return `A theory in ${from} cannot move to ${to}${next.length ? ` (it can move to: ${next.join(', ')})` : ' (it is final)'}`;
  }
  if (!roles.includes(role)) return `Only the ${roles.join(' or ')} can move a theory from ${from} to ${to}`;
  // A human sending a theory back is not capped: the caps bound the agents.
  if ((to === 'revise' || to === 'revise_code') && role !== 'human' && counts.revisions >= caps.maxRevisions)
    return `This theory has used all ${caps.maxRevisions} revisions; decide instead (${to === 'revise' ? 'rejected_untestable or approved_for_code' : 'failed or successful'})`;
  if (from === 'code_error' && to === 'coding' && counts.codeAttempts >= caps.maxCodeAttempts)
    return `${caps.maxCodeAttempts} code attempts failed; hand the theory to the Judge (post_review)`;
  return undefined;
}

/** The counters after a legal transition. */
export function countsAfter(from: TheoryState, to: TheoryState, counts: LifecycleCounts): LifecycleCounts {
  return {
    revisions: counts.revisions + (to === 'revise' || to === 'revise_code' ? 1 : 0),
    // A fresh coding round (after approval or a revision) resets the attempts; each retry after an error counts.
    codeAttempts:
      to === 'coding' && from !== 'code_error'
        ? 0
        : counts.codeAttempts + (from === 'code_error' && to === 'coding' ? 1 : 0),
  };
}

/** States from which the theory's content (hypothesis, logic) may still be edited by the Theorist. */
export const EDITABLE_STATES: TheoryState[] = ['draft', 'revise'];
