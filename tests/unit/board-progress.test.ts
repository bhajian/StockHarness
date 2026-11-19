// #543: what a Research board card says about its idea: who has it, what is happening, its stage and cycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { activityOf, lastTouch, refInArguments, runFocus, stageOf, STAGES } =
  await import('../../packages/core/src/boardProgress.js');

test('stages: each status sits in one of the six stages; verdicts are the last', () => {
  assert.equal(STAGES.length, 6);
  assert.equal(stageOf('draft'), 0);
  assert.equal(stageOf('revise'), 0);
  assert.equal(stageOf('pre_review'), 1);
  for (const s of ['approved_for_code', 'coding', 'code_error', 'revise_code']) assert.equal(stageOf(s), 2);
  assert.equal(stageOf('evaluated'), 3);
  assert.equal(stageOf('post_review'), 4);
  for (const s of ['failed', 'promising', 'successful', 'parked']) assert.equal(stageOf(s), 5);
});

test('post-review: the idea the Judge is on is live; the rest wait with their place in the queue', () => {
  const base = { status: 'post_review', step: 'judge_post', focusRef: 'T-160' };
  assert.deepEqual(activityOf({ ...base, ref: 'T-160', queuePosition: 1, queueSize: 60 }), {
    who: 'judge',
    text: 'Judge (post-result) giving its verdict now',
    active: true,
  });
  const waiting = activityOf({ ...base, ref: 'T-170', queuePosition: 9, queueSize: 60 });
  assert.equal(waiting.active, false);
  assert.match(
    waiting.text,
    /^Waiting for the Judge's verdict, 9th of 60 \(the Judge is on this column now\)$/,
  );
  // No cycle running: it just waits.
  assert.equal(
    activityOf({ status: 'post_review', ref: 'T-1', queuePosition: 1, queueSize: 1 }).text,
    "Waiting for the Judge's verdict",
  );
});

test('coding: an evaluation in flight wins; otherwise the Coder and the attempt number', () => {
  assert.deepEqual(
    activityOf({ status: 'coding', ref: 'T-5', evaluation: { status: 'running' }, step: 'coder' }),
    { who: 'evaluator', text: 'Evaluation running', active: true },
  );
  assert.deepEqual(activityOf({ status: 'coding', ref: 'T-5', codeAttempts: 1, step: 'coder' }), {
    who: 'coder',
    text: 'Coder working on it now (attempt 2)',
    active: true,
  });
  assert.equal(
    activityOf({ status: 'code_error', ref: 'T-5', codeAttempts: 2 }).text,
    'Code failed: back with the Coder to fix (attempt 3), continues next cycle',
  );
  assert.equal(
    activityOf({ status: 'approved_for_code', ref: 'T-7', rebuild: true, queuePosition: 2, queueSize: 30 })
      .text,
    'Rebuild queued for the Coder, 2nd of 30',
  );
  assert.equal(
    activityOf({ status: 'approved_for_code', ref: 'T-7', step: 'coder', focusRef: 'T-7' }).active,
    true,
  );
});

test('pre-review, drafts and verdicts', () => {
  assert.equal(
    activityOf({ status: 'pre_review', ref: 'T-2', step: 'judge_pre', focusRef: 'T-2' }).active,
    true,
  );
  assert.equal(
    activityOf({ status: 'pre_review', ref: 'T-3', queuePosition: 2, queueSize: 2 }).text,
    'Waiting for the Judge (pre-code), 2nd of 2',
  );
  assert.equal(activityOf({ status: 'draft', ref: 'T-4', step: 'theorists' }).who, 'theorist');
  assert.deepEqual(activityOf({ status: 'rejected_untestable', ref: 'T-4' }), {
    who: 'none',
    text: 'Verdict: rejected untestable',
    active: false,
  });
});

test('ordinals in queue places', () => {
  const at = (n: number) =>
    activityOf({ status: 'pre_review', ref: 'T-1', queuePosition: n, queueSize: 200 }).text;
  assert.match(at(1), /1st of/);
  assert.match(at(2), /2nd of/);
  assert.match(at(3), /3rd of/);
  assert.match(at(4), /4th of/);
  assert.match(at(11), /11th of/);
  assert.match(at(12), /12th of/);
  assert.match(at(13), /13th of/);
  assert.match(at(21), /21st of/);
  assert.match(at(112), /112th of/);
});

test('lastTouch: the cycle and model of the latest agent entry; time in stage from the latest transition', () => {
  const t = lastTouch([
    {
      type: 'transition',
      to: 'coding',
      at: '2026-11-18T12:57:00Z',
      actor: { role: 'coder', runId: 'r1', model: 'Baseten-kimi-k3.1:moonshotai/Kimi-K3.1-Pro' },
    },
    {
      type: 'transition',
      to: 'post_review',
      at: '2026-11-18T12:59:00Z',
      actor: { role: 'evaluator', runId: 'r1', model: 'Baseten-kimi-k3.1:moonshotai/Kimi-K3.1-Pro' },
    },
    { type: 'comment', at: '2026-11-19T09:00:00Z', actor: { role: 'human' } },
  ] as any);
  assert.equal(t.runId, 'r1');
  assert.equal(t.model, 'moonshotai/Kimi-K3.1-Pro');
  assert.equal(t.stageSince, '2026-11-18T12:59:00Z');
  // A human rebuild has no cycle: none is shown.
  assert.equal(
    lastTouch([{ type: 'transition', to: 'approved_for_code', at: 'x', actor: { role: 'human' } }] as any)
      .runId,
    undefined,
  );
  assert.deepEqual(lastTouch(), {
    runId: undefined,
    role: undefined,
    model: undefined,
    stageSince: undefined,
  });
});

test('runFocus: the current step and the idea in its latest tool call, never one from an earlier step', () => {
  const events = [
    { type: 'node_started', nodeId: 'coder' },
    { type: 'tool_started', nodeId: 'coder', data: { arguments: '{"theory_id":"T-9"}' } },
    { type: 'node_completed', nodeId: 'coder' },
    { type: 'node_started', nodeId: 'judge_post' },
    { type: 'tool_started', nodeId: 'judge_post', data: { arguments: '{}' } },
    { type: 'tool_started', nodeId: 'judge_post', data: { arguments: '{"theory_id":"T-160"}' } },
    { type: 'model', nodeId: 'judge_post' },
  ];
  assert.deepEqual(runFocus({ checkpoint: { cursor: 'judge_post' }, events }), {
    step: 'judge_post',
    focusRef: 'T-160',
  });
  // The Judge has not looked at an idea yet: the Coder's T-9 is not used.
  assert.deepEqual(runFocus({ checkpoint: { cursor: 'judge_post' }, events: events.slice(0, 5) }), {
    step: 'judge_post',
    focusRef: undefined,
  });
  // Parallel Theorists report as theorist_n under the theorists step.
  assert.equal(
    runFocus({
      checkpoint: { cursor: 'theorists' },
      events: [{ type: 'tool_started', nodeId: 'theorist_2', data: { arguments: { id: 'T-12' } } }],
    }).focusRef,
    'T-12',
  );
  assert.deepEqual(runFocus({}), { step: undefined, focusRef: undefined });
});

test('refInArguments: a theory_id first, else any T-n', () => {
  assert.equal(refInArguments('{"theory_id":"T-42","note":"see T-7"}'), 'T-42');
  assert.equal(refInArguments('{"note":"compare with T-7"}'), 'T-7');
  assert.equal(refInArguments({ ref: 'T-3' }), 'T-3');
  assert.equal(refInArguments('{"query":"momentum"}'), undefined);
});
