// #386 the one-time dq_issues cleanup against real MongoDB (TEST_DIRECT_MONGODB_URI): duplicates removed, issues
// whose row lost the flag resolved, the unique index created; a dry run writes nothing; a second run is a no-op.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { reconcileDqIssues } from '../../scripts/dq-reconcile.js';

const DIRECT_MONGO = process.env.TEST_DIRECT_MONGODB_URI;
const skip = DIRECT_MONGO ? undefined : 'set TEST_DIRECT_MONGODB_URI (scripts/test-stack.sh does)';
let client: MongoClient;
let db: Db;

before(async () => {
  if (skip) return;
  client = new MongoClient(DIRECT_MONGO!);
  await client.connect();
  db = client.db(`dq_reconcile_${randomUUID().slice(0, 8)}`);
  const issue = (t: string, s: string, d: string, extra: object = {}) => ({
    collection: 'prices_daily',
    issue_type: t,
    security_id: s,
    date: d,
    severity: 'warn',
    resolved: false,
    detected_at: new Date('2026-10-23'),
    ...extra,
  });
  await db.collection('prices_daily').insertMany([
    { security_id: 'S1', date: '2026-11-02', dq_flags: ['zero_volume'] },
    { security_id: 'S2', date: '2026-11-02', dq_flags: [] },
  ]);
  await db.collection('dq_issues').insertMany([
    // Still flagged, three copies: one is kept, open.
    issue('zero_volume', 'S1', '2026-11-02'),
    issue('zero_volume', 'S1', '2026-11-02', { last_seen_at: new Date('2026-11-05') }),
    issue('zero_volume', 'S1', '2026-11-02', { last_seen_at: new Date('2026-11-01') }),
    // The row no longer carries the flag, or no longer exists: resolved.
    issue('jump_no_action', 'S2', '2026-11-02'),
    issue('jump_no_action', 'S2', '2026-11-02'),
    issue('stale_price', 'S3', '2026-11-02'),
    // Not checkable (no dq_flags on fundamentals rows): deduplicated, left open.
    { ...issue('balance_sheet_identity', 'S1', '2017-12-31'), collection: 'fundamentals_pit' },
    { ...issue('balance_sheet_identity', 'S1', '2017-12-31'), collection: 'fundamentals_pit' },
  ]);
});
after(async () => {
  if (skip) return;
  await db.dropDatabase();
  await client.close();
});

test('a dry run counts and writes nothing', { skip }, async () => {
  const r = await reconcileDqIssues(db, { apply: false });
  assert.equal(r.before.total, 8);
  assert.equal(r.duplicateGroups, 3);
  assert.equal(r.duplicatesRemoved, 4);
  assert.equal(r.index, 'would create');
  assert.equal(await db.collection('dq_issues').countDocuments({}), 8);
  assert.equal(await db.collection('dq_issues').countDocuments({ resolved: true }), 0);
});

test('--apply dedupes, resolves the flags that are gone and adds the unique index', { skip }, async () => {
  const r = await reconcileDqIssues(db, { apply: true });
  assert.equal(r.duplicatesRemoved, 4);
  assert.equal(r.staleResolved, 2);
  assert.deepEqual(r.stale, { 'prices_daily jump_no_action': 1, 'prices_daily stale_price': 1 });
  assert.equal(r.index, 'created');
  const left = await db.collection('dq_issues').find({}).toArray();
  assert.equal(left.length, 4);
  const kept = left.find((d) => d.issue_type === 'zero_volume')!;
  assert.equal(kept.resolved, false);
  assert.equal(
    new Date(kept.last_seen_at).toISOString().slice(0, 10),
    '2026-11-05',
    'the newest copy is kept',
  );
  assert.equal(left.find((d) => d.issue_type === 'balance_sheet_identity')!.resolved, false);
  for (const t of ['jump_no_action', 'stale_price']) {
    const d = left.find((x) => x.issue_type === t)!;
    assert.equal(d.resolved, true, t);
    assert.equal(d.resolution, 'not re-seen (cleanup)');
  }
  assert.equal(r.after?.open, 2);
  const ix = (await db.collection('dq_issues').indexes()).find((i) => i.name === 'oh_dq_key');
  assert.equal(ix?.unique, true);
  await assert.rejects(
    db.collection('dq_issues').insertOne({
      collection: 'prices_daily',
      issue_type: 'zero_volume',
      security_id: 'S1',
      date: '2026-11-02',
    }),
    /duplicate key/,
  );
});

test('a second run changes nothing', { skip }, async () => {
  const r = await reconcileDqIssues(db, { apply: true });
  assert.equal(r.duplicatesRemoved, 0);
  assert.equal(r.staleResolved, 0);
  assert.equal(r.index, 'exists');
});
