// #386 the dq_issues cleanup keeps the most recently seen member of a duplicate group.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { duplicatesToDrop } from '../../scripts/dq-reconcile.js';

test('keeps the most recently seen issue, falling back to detected_at', () => {
  const [a, b, c] = [new ObjectId(), new ObjectId(), new ObjectId()];
  const drop = duplicatesToDrop([
    { _id: a, detected_at: new Date('2026-10-23') }, // legacy row: no last_seen_at
    { _id: b, last_seen_at: new Date('2026-11-05') },
    { _id: c, last_seen_at: new Date('2026-11-01') },
  ]);
  assert.deepEqual(drop.map(String).sort(), [a, c].map(String).sort());
});

test('a single issue is never dropped', () => {
  assert.deepEqual(duplicatesToDrop([{ _id: new ObjectId() }]), []);
});
