// #110: the theory lifecycle. Illegal transitions are refused, roles are checked, the caps are enforced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CAPS,
  TRANSITIONS,
  THEORY_STATES,
  TERMINAL_STATES,
  countsAfter,
  transitionProblem,
  type TheoryRole,
  type TheoryState,
} from '../../packages/core/src/theoryLifecycle.js';

const zero = { revisions: 0, codeAttempts: 0 };

test('the happy path and both revision paths are legal for the right roles', () => {
  const path: [TheoryState, TheoryState, TheoryRole][] = [
    ['draft', 'pre_review', 'theorist'],
    ['pre_review', 'revise', 'judge'],
    ['revise', 'pre_review', 'theorist'],
    ['pre_review', 'approved_for_code', 'judge'],
    ['approved_for_code', 'coding', 'coder'],
    ['coding', 'code_error', 'coder'],
    ['code_error', 'coding', 'coder'],
    ['coding', 'evaluated', 'evaluator'],
    ['evaluated', 'post_review', 'evaluator'],
    ['post_review', 'revise_code', 'judge'],
    ['revise_code', 'coding', 'coder'],
    ['coding', 'evaluated', 'coder'],
    ['evaluated', 'post_review', 'coder'],
    ['post_review', 'successful', 'judge'],
    ['successful', 'approved', 'human'],
  ];
  let counts = zero;
  for (const [from, to, role] of path) {
    assert.equal(transitionProblem(from, to, role, counts), undefined, `${from} → ${to} by ${role}`);
    counts = countsAfter(from, to, counts);
  }
  assert.deepEqual(counts, { revisions: 2, codeAttempts: 0 }, 'a new coding round resets the attempts');
});

test('illegal transitions are refused with the legal next states', () => {
  assert.match(
    transitionProblem('draft', 'coding', 'coder', zero)!,
    /cannot move to coding \(it can move to: pre_review\)/,
  );
  assert.match(transitionProblem('pre_review', 'successful', 'judge', zero)!, /cannot move/);
  assert.match(transitionProblem('coding', 'successful', 'judge', zero)!, /cannot move/);
  for (const s of TERMINAL_STATES.filter((s) => s !== 'approved'))
    for (const to of THEORY_STATES)
      assert.match(transitionProblem(s, to, 'human', zero)!, /it is final|cannot move/);
  assert.match(transitionProblem('draft', 'nonsense' as TheoryState, 'theorist', zero)!, /Unknown state/);
});

test('roles: only the Judge reviews and gives verdicts, only the Coder codes, only a human approves', () => {
  assert.match(transitionProblem('pre_review', 'approved_for_code', 'theorist', zero)!, /Only the judge/);
  assert.match(transitionProblem('post_review', 'successful', 'coder', zero)!, /Only the judge/);
  assert.match(transitionProblem('approved_for_code', 'coding', 'judge', zero)!, /Only the coder/);
  assert.match(transitionProblem('successful', 'approved', 'judge', zero)!, /Only the human/);
});

test('revision and code-attempt caps', () => {
  const capped = { revisions: DEFAULT_CAPS.maxRevisions, codeAttempts: 0 };
  assert.match(transitionProblem('pre_review', 'revise', 'judge', capped)!, /used all 3 revisions/);
  assert.match(transitionProblem('post_review', 'revise_code', 'judge', capped)!, /used all 3 revisions/);
  assert.equal(transitionProblem('pre_review', 'approved_for_code', 'judge', capped), undefined);
  const tried = { revisions: 0, codeAttempts: DEFAULT_CAPS.maxCodeAttempts };
  assert.match(
    transitionProblem('code_error', 'coding', 'coder', tried)!,
    /5 code attempts failed; hand the theory to the Judge/,
  );
  assert.equal(transitionProblem('code_error', 'post_review', 'coder', tried), undefined);
  assert.equal(
    transitionProblem(
      'pre_review',
      'revise',
      'judge',
      { revisions: 1, codeAttempts: 0 },
      { maxRevisions: 1, maxCodeAttempts: 5 },
    )!.includes('1 revisions'),
    true,
  );
  assert.deepEqual(countsAfter('code_error', 'coding', { revisions: 0, codeAttempts: 2 }), {
    revisions: 0,
    codeAttempts: 3,
  });
});

test('every state appears in the table, and every target is a state', () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...THEORY_STATES].sort());
  for (const targets of Object.values(TRANSITIONS))
    for (const to of Object.keys(targets)) assert.ok(THEORY_STATES.includes(to as TheoryState), to);
});
