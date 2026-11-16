// #459: the research vault's notes, links, sections and search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const V = await import('../../packages/core/src/vaultNotes.js');

const idea = (o: Record<string, unknown>) => ({
  ref: 'T-1',
  title: 'Momentum winners keep winning',
  status: 'failed',
  family: 'Momentum',
  model: 'm1',
  hypothesis: '12-1 momentum',
  signalLogic: 'rank mom_12_1',
  createdAt: '2026-11-10T00:00:00Z',
  sharpe: 0.3,
  excess: -0.02,
  dsr: 0.4,
  trades: 120,
  failingGates: ['sharpe', 'alpha_t'],
  ...o,
});
const ideas = [
  idea({}),
  idea({
    ref: 'T-2',
    title: 'Low volatility quality',
    family: 'Quality',
    status: 'promising',
    sharpe: 0.9,
    failingGates: ['deflated_sharpe'],
  }),
  idea({
    ref: 'T-3',
    title: 'Short-term reversal',
    family: 'Momentum',
    sharpe: -0.4,
    failingGates: ['sharpe'],
  }),
];

test('the vault links ideas, families and lessons', () => {
  const notes = V.buildVault(ideas);
  const by = new Map(notes.map((n: any) => [n.path, n]));
  assert.ok(by.has('index') && by.has('lessons/gates') && by.has('families/momentum') && by.has('ideas/T-3'));
  assert.ok(by.get('ideas/T-1').links.includes('families/momentum'));
  assert.ok(by.get('index').links.includes('families/quality'));
  const fam = V.sections(by.get('families/momentum').body);
  assert.match(fam.Lessons, /sharpe failed 2 times/);
  assert.match(fam.Best, /T-1/);
  assert.match(by.get('families/quality').body, /1 promising or successful · yield 100 per 100/);
  assert.match(V.sections(by.get('ideas/T-1').body)['Post-mortem'], /Failed: sharpe, alpha_t/);
});

test('search needs every word and ranks titles first', () => {
  const notes = V.buildVault(ideas);
  const r = V.search(notes, 'reversal momentum');
  const paths = r.map((x: any) => x.path);
  assert.ok(paths.includes('ideas/T-3') && paths.includes('families/momentum'), JSON.stringify(paths));
  assert.ok(!paths.includes('ideas/T-2'), 'every word must match');
  assert.deepEqual(V.search(notes, 'zz'), []);
});
