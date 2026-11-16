// #413: each Theorist can run on its own model; missing entries use the Theorist role's model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { makeResearchLoop, theoristProvider, researchSettingsSchema } =
  await import('../../packages/core/src/researchLoop.js');
const { agentLabel } = await import('../../packages/core/src/ideas.js');

const ID = Object.fromEntries(
  ['p-role', 'p-judge', 'p-coder', 'c-t', 'c-j', 'c-c', 'p-a', 'p-c'].map((k) => [k, randomUUID()]),
);
const base = {
  providers: { theorist: ID['p-role'], judge: ID['p-judge'], coder: ID['p-coder'] },
  connections: { theorist: ID['c-t'], judge: ID['c-j'], coder: ID['c-c'] },
  skills: {},
};
const theoristModels = (w: ReturnType<typeof makeResearchLoop>) =>
  w.nodes.filter((n: any) => /^theorist_\d+$/.test(n.id)).map((n: any) => [n.name, n.config.providerId]);

test('one Theorist step per Theorist, each with its own model or the role model', () => {
  const w = makeResearchLoop({ ...base, theorists: 3, theoristProviders: [ID['p-a'], '', ID['p-c']] });
  assert.deepEqual(theoristModels(w), [
    ['Theorist 1', ID['p-a']],
    ['Theorist 2', ID['p-role']],
    ['Theorist 3', ID['p-c']],
  ]);
  const parallel = w.nodes.find((n: any) => n.id === 'theorists') as any;
  assert.deepEqual(parallel.agentNodeIds, ['theorist_1', 'theorist_2', 'theorist_3']);
  // Judge and Coder keep their role models.
  assert.equal((w.nodes.find((n: any) => n.id === 'coder') as any).config.providerId, ID['p-coder']);
});

test('settings from before #413 (no per-Theorist models) keep every Theorist on the role model', () => {
  const s = researchSettingsSchema.parse({ theoristsPerCycle: 2 });
  assert.deepEqual(s.theoristProviders, []);
  const w = makeResearchLoop({ ...base, theorists: 2, theoristProviders: s.theoristProviders });
  assert.deepEqual(theoristModels(w), [
    ['Theorist 1', ID['p-role']],
    ['Theorist 2', ID['p-role']],
  ]);
  // A list shorter than the Theorists: the rest use the role model.
  assert.equal(
    theoristProvider({ providers: base.providers, theoristProviders: [ID['p-a']] }, 4),
    ID['p-role'],
  );
  assert.throws(() => researchSettingsSchema.parse({ theoristProviders: Array(9).fill('p') }), 'at most 8');
});

test('ideas name the Theorist that proposed them', () => {
  assert.equal(agentLabel('theorist_2'), 'Theorist 2');
  assert.equal(agentLabel('judge_pre'), undefined);
  assert.equal(agentLabel(undefined), undefined);
});

test('#462: step mode gives each Theorist the step prompt and the scratch-note tool; single mode is unchanged', () => {
  const theorists = (w: ReturnType<typeof makeResearchLoop>) =>
    w.nodes.filter((n: any) => /^theorist_\d+$/.test(n.id)).map((n: any) => n.config);
  const single = theorists(makeResearchLoop({ ...base, theorists: 2 }));
  const steps = theorists(makeResearchLoop({ ...base, theorists: 2, theoristMode: 'steps' }));
  for (const c of single) {
    assert.doesNotMatch(c.systemPrompt, /Step 1 \(orient\)/);
    assert.ok(!c.connections[0].tools.includes('vault_scratch'));
  }
  for (const c of steps) {
    assert.match(c.systemPrompt, /Step 1 \(orient\)[\s\S]*Step 5 \(decide\)/);
    assert.ok(c.connections[0].tools.includes('vault_scratch'));
    assert.ok(c.connections[0].tools.includes('submit_theory'));
  }
  assert.equal(researchSettingsSchema.parse({}).theoristMode, 'single');
});
