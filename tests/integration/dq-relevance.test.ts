// #428: open DQ issues are stamped with whether their row was in the research universe; Health shows that part.
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
const { workspaceDatabase } = await import('../../packages/core/src/mongoMcp.js');
const { stampDqRelevance, dataHealth } = await import('../../packages/core/src/dataHealth.js');

const owner = `dqr-${randomUUID()}`;
const db = () => mongo.db(workspaceDatabase(owner));

before(async () => {
  if (!DIRECT_MONGO) return;
  await mongo.connect();
  await db()
    .collection('universe_daily')
    .insertMany([
      { security_id: 'SEC_1', date: '2026-11-10', in_universe: true },
      { security_id: 'SEC_1', date: '2026-11-11', in_universe: false },
      { security_id: 'SEC_2', date: '2026-11-10', in_universe: false },
    ]);
  await db()
    .collection('dq_issues')
    .insertMany([
      {
        collection: 'prices_daily',
        issue_type: 'zero_volume',
        severity: 'warn',
        security_id: 'SEC_1',
        date: '2026-11-10',
        resolved: false,
      },
      {
        collection: 'prices_daily',
        issue_type: 'jump_no_action',
        severity: 'warn',
        security_id: 'SEC_1',
        date: '2026-11-11',
        resolved: false,
      },
      {
        collection: 'prices_daily',
        issue_type: 'implausible_price',
        severity: 'error',
        security_id: 'SEC_2',
        date: '2026-11-10',
        resolved: false,
      },
      {
        collection: 'fundamentals_pit',
        issue_type: 'balance_sheet_identity',
        severity: 'warn',
        security_id: 'SEC_1',
        date: '2026-09-30',
        resolved: false,
      },
    ]);
  for (const name of ['universe_daily', 'prices_daily', 'fundamentals_pit'])
    await collection<any>('dataset_catalog').insertOne({
      _id: `${owner}:${name}`,
      ownerId: owner,
      collection: name,
      layer: 2,
      grain: '',
      primaryKey: [],
      fields: [],
      timeSemantics: { status: 'pit', text: '' },
      producedBy: [],
      caveats: [],
      coverage: { rows: 1 },
      freshness: { lastUpdated: new Date() },
      docCompletenessPct: 100,
      refreshedAt: new Date(),
      joins: [],
      description: '',
    });
});
after(async () => {
  if (!DIRECT_MONGO) return;
  await collection<any>('dataset_catalog').deleteMany({ ownerId: owner });
  await db().dropDatabase();
  await mongo.close();
});

test(
  'issues are stamped by the row being in the universe that day; Health shows the research part',
  { skip: skipReason },
  async () => {
    assert.equal(await stampDqRelevance(owner, 2), 4, 'in pages');
    const by = Object.fromEntries(
      (await db().collection('dq_issues').find({}).toArray()).map((i) => [i.issue_type, i.in_universe]),
    );
    assert.deepEqual(by, {
      zero_volume: true,
      jump_no_action: false,
      implausible_price: false,
      balance_sheet_identity: true,
    });
    assert.equal(await stampDqRelevance(owner), 0, 'nothing left to stamp until universe_daily changes');
    const h = await dataHealth(owner, { days: 10 });
    const p = h.collections.find((c) => c.collection === 'prices_daily')!;
    assert.deepEqual(p.dq, { error: 1, warn: 2, research: { error: 0, warn: 1 } });
    assert.equal(h.kpis.dqResearchErrors, 0);
  },
);
