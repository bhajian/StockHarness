// #110: theories on real MongoDB: lifecycle through the store, the debate history, concurrency, caps from the
// research settings, links and trials, and the Theory YAML round trip. Needs TEST_DIRECT_MONGODB_URI.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const DIRECT_MONGO = process.env.TEST_DIRECT_MONGODB_URI;
const skipReason = DIRECT_MONGO ? undefined : 'set TEST_DIRECT_MONGODB_URI (scripts/test-stack.sh does)';
if (DIRECT_MONGO) {
  process.env.MONGODB_URI = DIRECT_MONGO;
  process.env.MONGODB_DATABASE = 'agentic_direct_test';
}
process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { mongo, collection } = await import('../../packages/core/src/db.js');
const T = await import('../../packages/core/src/theories.js');
const { exportObjects, planObjectImport, applyObjectImport } = await import('../../apps/api/src/objects.js');
const { SECRET_FIELD_PATTERN } = await import('../../packages/core/src/objectEnvelope.js');

const S = `th-src-${randomUUID()}`;
const D = `th-dst-${randomUUID()}`;
const who = (tenantId: string) => ({ tenantId, user: { _id: `admin-${tenantId}`, role: 'admin' } }) as any;
const theorist = { role: 'theorist' as const, agentId: 'a-theorist', model: 'gemini-3.8-flash' };
const judge = { role: 'judge' as const, agentId: 'a-judge', model: 'claude-opus-5-5' };
const coder = { role: 'coder' as const, agentId: 'a-coder' };
const evaluator = { role: 'evaluator' as const };
const CONTENT = {
  title: 'Post-earnings drift in quality names',
  hypothesis: 'High-quality companies that beat estimates keep drifting up for 40 days after the report.',
  rationale: 'Investors under-react to persistent quality signals.',
  dataNeeded: ['features_ranked.quality_score', 'earnings_calendar.date'],
  signalLogic: 'Rank names by quality_score among those that reported in the last 5 days; long the top 10.',
  horizonDays: 40,
  falsification: 'Out-of-sample Sharpe below 0.3 or no excess over the sector benchmark.',
  family: 'event-drift',
  tags: ['earnings', 'quality'],
};

before(async () => {
  if (!DIRECT_MONGO) return;
  await mongo.connect();
});
after(async () => {
  if (!DIRECT_MONGO) return;
  for (const c of ['theories', 'theory_counters', 'research_settings', 'evaluation_trials'])
    await collection<any>(c).deleteMany({ $or: [{ ownerId: { $in: [S, D] } }, { _id: { $in: [S, D] } }] });
  await mongo.close();
});

let id = '';
test('a theory moves through the lifecycle with its debate recorded', { skip: skipReason }, async () => {
  const t = await T.createTheory(S, CONTENT, theorist, {
    submit: true,
    reasoning: 'Classic PEAD, filtered for quality',
  });
  id = t._id;
  assert.equal(t.status, 'pre_review');
  assert.equal(t.number, 1);
  await assert.rejects(
    T.transitionTheory(S, id, 'approved_for_code', theorist, 'self-approve'),
    /Only the judge/,
  );
  await assert.rejects(T.transitionTheory(S, id, 'revise', judge, '  '), /needs its reasoning/);
  await T.transitionTheory(S, id, 'revise', judge, 'Say how “beat estimates” is measured point-in-time.');
  await assert.rejects(T.editTheory(S, id, { horizonDays: 0 }, theorist), /Number must be greater/);
  await T.editTheory(
    S,
    id,
    {
      signalLogic: CONTENT.signalLogic + ' Beat = earnings_surprises.actual > estimate, known at the report.',
    },
    theorist,
    'Defined the beat',
  );
  await T.transitionTheory(S, 'T-1', 'pre_review', theorist, 'Revised');
  await assert.rejects(
    T.editTheory(S, id, { title: 'changed while in review' }, theorist),
    /content can change only in draft or revise/,
  );
  await T.transitionTheory(S, id, 'approved_for_code', judge, 'Testable, plausible, novel enough');
  await T.transitionTheory(S, id, 'coding', coder, 'Starting');
  await T.linkTheory(S, id, { pluginName: 'pead_quality', pluginVersion: 1 }, coder);
  await T.transitionTheory(S, id, 'code_error', coder, 'KeyError on line 6');
  await T.transitionTheory(S, id, 'coding', coder, 'Fixed the column name');
  await T.linkTheory(S, id, { pluginName: 'pead_quality', pluginVersion: 2, evaluationId: 'eval-1' }, coder);
  await T.transitionTheory(S, id, 'evaluated', evaluator, '');
  const done = await T.transitionTheory(S, id, 'post_review', evaluator, 'Evaluation eval-1 finished');
  assert.equal(done.revisions, 1);
  assert.equal(done.codeAttempts, 1);
  assert.deepEqual(done.plugin, { name: 'pead_quality', versions: [1, 2] });
  assert.equal(done.trials, 1);
  const transitions = done.history.filter((h) => h.type === 'transition');
  assert.deepEqual(
    transitions.map((h) => `${h.from}>${h.to}:${h.actor.role}`),
    [
      'draft>pre_review:theorist',
      'pre_review>revise:judge',
      'revise>pre_review:theorist',
      'pre_review>approved_for_code:judge',
      'approved_for_code>coding:coder',
      'coding>code_error:coder',
      'code_error>coding:coder',
      'coding>evaluated:evaluator',
      'evaluated>post_review:evaluator',
    ],
  );
  assert.equal(transitions[1].actor.model, 'claude-opus-5-5');
  assert.ok(done.history.some((h) => h.type === 'edit' && (h.data as any).fields.includes('signalLogic')));
});

test('two Judges racing: only one transition wins', { skip: skipReason }, async () => {
  const r = await Promise.allSettled([
    T.transitionTheory(S, id, 'successful', judge, 'Passes the gates'),
    T.transitionTheory(S, id, 'failed', { ...judge, agentId: 'a-judge-2' }, 'Fails the holdout'),
  ]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.match(
    String((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason),
    /moved meanwhile|cannot move/,
  );
});

test('caps come from the research settings', { skip: skipReason }, async () => {
  await collection<any>('research_settings').updateOne(
    { _id: S },
    { $set: { maxRevisions: 1 } },
    { upsert: true },
  );
  const t = await T.createTheory(S, { ...CONTENT, title: 'Second theory' }, theorist, { submit: true });
  await T.transitionTheory(S, t._id, 'revise', judge, 'One revision');
  await T.transitionTheory(S, t._id, 'pre_review', theorist, 'Revised');
  await assert.rejects(T.transitionTheory(S, t._id, 'revise', judge, 'Again'), /used all 1 revisions/);
  await T.transitionTheory(S, t._id, 'rejected_untestable', judge, 'Still not testable');
});

test(
  'Theory YAML: the record and its debate round-trip, trials carried over',
  { skip: skipReason },
  async () => {
    const { yaml, count } = await exportObjects(S, ['Theory']);
    assert.equal(count, 2);
    assert.match(yaml, /kind: Theory/);
    assert.match(yaml, /reasoning: Say how “beat estimates” is measured point-in-time\./);
    assert.ok(!SECRET_FIELD_PATTERN.test(yaml) && !/ownerId/.test(yaml));
    const plan = await planObjectImport(who(D), yaml, 'merge');
    assert.deepEqual(plan.errors, []);
    const r = await applyObjectImport(who(D), yaml, 'merge');
    assert.equal(r.applied, true, JSON.stringify(r));
    assert.equal((await exportObjects(D, ['Theory'])).yaml, yaml, 'identical round trip');
    assert.equal(
      (await collection<any>('evaluation_trials').findOne({ _id: D }))?.count,
      1,
      'imported trials keep the deflated Sharpe honest',
    );
    const t3 = await T.createTheory(D, { ...CONTENT, title: 'New after import' }, theorist);
    assert.equal(t3.number, 3, 'numbering continues after imported theories');
    assert.deepEqual(
      (await planObjectImport(who(D), yaml, 'merge')).items.map((i) => i.action),
      ['unchanged', 'unchanged'],
    );
    const edited = yaml.replace('status: rejected_untestable', 'status: approved');
    assert.match((await planObjectImport(who(D), edited, 'merge')).errors[0].message, /not overwritten/);
  },
);

test(
  'theory memory (lexical fallback): a re-submission is refused unless it says what differs',
  { skip: skipReason },
  async () => {
    const M = await import('../../packages/core/src/theoryMemory.js');
    const O = `th-mem-${randomUUID()}`;
    const a = await T.createTheory(O, CONTENT, theorist, { submit: true });
    // Failed theories stay in memory.
    await collection<any>('theories').updateOne({ _id: a._id }, { $set: { status: 'failed' } });
    await assert.rejects(
      T.createTheory(O, { ...CONTENT, title: CONTENT.title + ' (again)' }, theorist, { submit: true }),
      /near-duplicate of T-1 "Post-earnings drift in quality names" \(failed, similarity 0\.9\d+ ≥ 0\.9, lexical\)/,
    );
    const b = await T.createTheory(
      O,
      {
        ...CONTENT,
        title: CONTENT.title + ' (again)',
        differsFrom: 'Uses only Q4 reports, where the drift is strongest.',
      },
      theorist,
      { submit: true },
    );
    assert.equal(b.status, 'pre_review');
    const closest = b.history.at(-1)!.data!.closest as any;
    assert.equal(closest.ref, 'T-1');
    const found = await M.searchTheories(O, 'quality companies drifting after earnings reports');
    assert.equal(found.method, 'lexical');
    assert.deepEqual(
      found.matches
        .slice(0, 2)
        .map((m) => m.ref)
        .sort(),
      ['T-1', 'T-2'],
    );
    assert.equal(
      await collection<any>('theories').countDocuments({ ownerId: O }),
      2,
      'the refused submission created nothing',
    );
    await collection<any>('theories').deleteMany({ ownerId: O });
    await collection<any>('theory_embeddings').deleteMany({ ownerId: O });
    await collection<any>('theory_counters').deleteMany({ _id: O });
  },
);

test(
  'Gates YAML: versions round-trip, locked stays locked, a clashing number is renumbered',
  { skip: skipReason },
  async () => {
    const G = await import('../../packages/core/src/gates.js');
    const A = `gates-a-${randomUUID()}`;
    const B = `gates-b-${randomUUID()}`;
    assert.equal((await G.activeGates(A)).version, 1);
    const v2 = await G.createGatesVersion(A, { minSharpe: 0.7 }, 'u', 'Stricter Sharpe');
    await G.lockGates(v2);
    const { yaml } = await exportObjects(A, ['Gates']);
    assert.match(
      yaml,
      /kind: Gates\nmetadata:\n  name: v2\n  version: "2"\nspec:\n  gates:\n    minSharpe: 0.7/,
    );
    assert.match(yaml, /note: Stricter Sharpe\n  locked: true/);
    const r = await applyObjectImport(who(B), yaml, 'merge');
    assert.equal(r.applied, true, JSON.stringify(r));
    assert.equal((await exportObjects(B, ['Gates'])).yaml, yaml, 'identical round trip');
    assert.ok(
      (await G.gatesVersions().findOne({ ownerId: B, version: 2 }))!.lockedAt,
      'locked imports read-only',
    );
    const other = yaml.replace('minSharpe: 0.7', 'minSharpe: 0.9');
    const plan = await planObjectImport(who(B), other, 'merge');
    assert.deepEqual(
      plan.items.map((i) => `${i.name}:${i.action}`),
      ['v1:unchanged', 'v3:create'],
      'new thresholds under a taken number become a new version',
    );
    for (const o of [A, B]) {
      await G.gatesVersions().deleteMany({ ownerId: o });
      await collection<any>('research_settings').deleteMany({ _id: o });
    }
  },
);

test('seed skills import on a fresh install and export identically', { skip: skipReason }, async () => {
  const { readFile } = await import('node:fs/promises');
  const seed = await readFile('deploy/config-io/seed/skills.yaml', 'utf8');
  const F = `seed-${randomUUID()}`;
  const r = await applyObjectImport(who(F), seed, 'merge');
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal((await exportObjects(F, ['Skill'])).yaml, seed, 'identical round trip');
  assert.ok(!SECRET_FIELD_PATTERN.test(seed));
  for (const c of ['skills', 'skill_versions']) await collection<any>(c).deleteMany({ ownerId: F });
});
