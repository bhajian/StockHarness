// #450: a comment or whitespace edit is the same code for the one-shot holdout key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { normalizedCode, normalizedCodeHash } = await import('../../packages/core/src/codeNormalize.js');

const base = 'META = {"side": "long"}\n\ndef signal(ctx):\n    return {"A": 1.0}\n';
test('comments, blank lines and trailing spaces do not change the hash', () => {
  const edited =
    '# my idea\nMETA = {"side": "long"}   # side\n\n\ndef signal(ctx):  \n    # score\n    return {"A": 1.0}\n';
  assert.equal(normalizedCodeHash(edited), normalizedCodeHash(base));
  assert.notEqual(normalizedCodeHash(base.replace('1.0', '2.0')), normalizedCodeHash(base));
});
test('a # inside a string is code', () => {
  assert.equal(normalizedCode('x = "a # b"  # note'), 'x = "a # b"');
  assert.equal(normalizedCode("y = 'c#d'"), "y = 'c#d'");
});
