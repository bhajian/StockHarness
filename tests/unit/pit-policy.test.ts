// #103: point-in-time policy per collection, and knownAt.ts parity with pipeline/strategy/known_at.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { knownAtOf, type KnownAtRule } from '../../packages/core/src/knownAt.js';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { coarseFilter, policyOf, ruleFields, visibleAt } =
  await import('../../packages/core/src/pitPolicy.js');
const { codeHash, pluginProblems } = await import('../../packages/core/src/strategyPlugins.js');

const VECTORS = JSON.parse(
  readFileSync(new URL('../../pipeline/tests/fixtures/known_at_vectors.json', import.meta.url), 'utf8'),
) as { rule: KnownAtRule; row: Record<string, unknown>; as_of_date: string | null }[];

test('knownAtOf matches the shared vectors (the Python port asserts the same file)', () => {
  assert.ok(VECTORS.length >= 30);
  for (const c of VECTORS)
    assert.equal(knownAtOf(c.rule, c.row)?.as_of_date ?? null, c.as_of_date, JSON.stringify(c));
});

test('visibleAt is as_of_date <= D', () => {
  const rule: KnownAtRule = { type: 'timestamp', field: 'filingDate' };
  assert.equal(visibleAt(rule, { filingDate: '2024-03-08 09:45:00' }, '2024-03-08'), false);
  assert.equal(visibleAt(rule, { filingDate: '2024-03-08 09:45:00' }, '2024-03-11'), true);
  assert.equal(visibleAt({ type: 'current_only' }, { x: 1 }, '2030-01-01'), false);
});

test('policies follow the catalog time semantics', () => {
  const l2 = (eventDate: string) =>
    policyOf({ layer: 2, timeSemantics: { status: 'pit', text: '', eventDate } });
  assert.deepEqual(l2('as_of_date'), { mode: 'pit', rule: { type: 'asOf', field: 'as_of_date' } });
  assert.deepEqual(l2('known_at'), { mode: 'pit', rule: { type: 'timestamp', field: 'known_at' } });
  assert.deepEqual(policyOf({ layer: 2, timeSemantics: { status: 'static', text: '' } }), {
    mode: 'static',
  });
  const rule: KnownAtRule = { type: 'timestamp', field: 'filingDate' };
  assert.deepEqual(policyOf({ layer: 1, timeSemantics: { status: 'pit', text: '', rule } }), {
    mode: 'pit',
    rule,
  });
  assert.equal(
    policyOf({
      layer: 1,
      timeSemantics: { status: 'current_only', text: '', rule: { type: 'current_only' } },
    }).mode,
    'refuse',
  );
  assert.equal(policyOf({ layer: null, timeSemantics: { status: 'unknown', text: '' } }).mode, 'refuse');
});

test('coarse filters bound the rule field and fetch the fields the rule reads', () => {
  assert.deepEqual(coarseFilter({ type: 'asOf', field: 'as_of_date' }, '2024-03-08'), {
    as_of_date: { $lte: '2024-03-08' },
  });
  const f = coarseFilter({ type: 'eod', field: 'date' }, '2024-03-08') as any;
  assert.equal(f.$or[0].date.$lte, '2024-03-08~');
  assert.deepEqual(ruleFields({ type: 'statement', field: 'acceptedDate', periodField: 'date' }), [
    'acceptedDate',
    'date',
    'period',
  ]);
  assert.deepEqual(ruleFields({ type: 'timestamp', field: 'declarationDate', fallback: 'date' }), [
    'declarationDate',
    'date',
  ]);
});

test('plugin save checks and the code hash format shared with contract.py', () => {
  const ok = 'import numpy as np\nMETA = {"side": "long"}\n\ndef signal(ctx):\n    return {}\n';
  assert.deepEqual(pluginProblems({ name: 'p', code: ok, evaluatorVersion: '1' }), []);
  const bad = pluginProblems({ name: 'p', code: 'import os\nx = 1\n', evaluatorVersion: '2' });
  assert.ok(bad.some((p) => p.includes('signal(ctx)')));
  assert.ok(bad.some((p) => p.includes('META')));
  assert.ok(bad.some((p) => p === 'line 1: import os is not allowed'));
  assert.ok(bad.some((p) => p.includes('evaluatorVersion 2')));
  // sha256("abc")
  assert.equal(codeHash('abc'), 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
