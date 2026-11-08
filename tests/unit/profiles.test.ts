// #323: idea profiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_PROFILES,
  OPTION_STRUCTURES,
  PROFILE_IDS,
  profileOf,
  profileProblems,
  theoryProfileId,
} from '../../packages/core/src/profiles.js';

test('three equity profiles and one per options structure', () => {
  assert.equal(PROFILE_IDS.length, 3 + Object.keys(OPTION_STRUCTURES).length);
  assert.deepEqual(profileOf('equity_long_short'), {
    id: 'equity_long_short',
    label: 'Equity · long / short',
    instrument: 'equity',
    direction: 'long_short',
    available: true,
  });
  const cc = profileOf('options_covered_call');
  assert.equal(cc.label, 'Options · covered call');
  assert.equal(cc.structure, 'covered_call');
  assert.equal(cc.group, 'income');
  assert.equal(cc.available, false, 'not until the options evaluator (#329)');
  assert.equal(profileOf('options_iron_condor').direction, 'neutral');
  assert.ok(
    ALL_PROFILES.every((p) => p.label.startsWith(p.instrument === 'equity' ? 'Equity · ' : 'Options · ')),
  );
});

test("a theory's profile from its fields; old theories are equity", () => {
  assert.equal(theoryProfileId({ direction: 'long' }), 'equity_long');
  assert.equal(theoryProfileId({ direction: 'short' }), 'equity_short');
  assert.equal(theoryProfileId({ instrument: 'equity', direction: 'long_short' }), 'equity_long_short');
  assert.equal(
    theoryProfileId({ instrument: 'options', structure: 'cash_secured_put' }),
    'options_cash_secured_put',
  );
});

test('inconsistent profiles are explained', () => {
  assert.deepEqual(profileProblems({ direction: 'long' }), []);
  assert.deepEqual(profileProblems({ instrument: 'options', structure: 'collar', direction: 'long' }), []);
  assert.match(profileProblems({ instrument: 'options' })[0], /names its structure/);
  assert.match(profileProblems({ structure: 'collar' })[0], /for options ideas/);
  assert.match(profileProblems({ direction: 'neutral' })[0], /neutral is for options/);
});
