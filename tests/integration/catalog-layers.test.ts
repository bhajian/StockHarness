// #386 simulation outputs are Layer 4 in the catalog (not "Other"); an unknown collection still is. Real MongoDB
// (TEST_DIRECT_MONGODB_URI).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const DIRECT_MONGO = process.env.TEST_DIRECT_MONGODB_URI;
const skip = DIRECT_MONGO ? undefined : 'set TEST_DIRECT_MONGODB_URI (scripts/test-stack.sh does)';
if (DIRECT_MONGO) {
  process.env.MONGODB_URI = DIRECT_MONGO;
  process.env.MONGODB_DATABASE = 'agentic_direct_test';
}
process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { mongo, collection } = await import('../../packages/core/src/db.js');
const { workspaceDatabase } = await import('../../packages/core/src/mongoMcp.js');
const { refreshCatalogEntry } = await import('../../packages/core/src/schemaCatalog.js');

const owner = `layers-${randomUUID()}`;
before(async () => {
  if (skip) return;
  await mongo.connect();
  const db = mongo.db(workspaceDatabase(owner));
  await db.collection('sim_portfolio_daily').insertOne({ simulation_id: 's1', date: '2026-11-02', nav: 1e6 });
  await db.collection('scratch_notes').insertOne({ note: 'x' });
});
after(async () => {
  if (skip) return;
  await collection<any>('dataset_catalog').deleteMany({ ownerId: owner });
  await mongo.db(workspaceDatabase(owner)).dropDatabase();
  await mongo.close();
});

test('simulation outputs are registered as Layer 4', { skip }, async () => {
  const e = await refreshCatalogEntry(owner, 'sim_portfolio_daily');
  assert.equal(e.layer, 4);
  assert.deepEqual(e.producedBy, [{ type: 'simulation', name: 'Simulations' }]);
  assert.deepEqual(e.primaryKey, ['simulation_id', 'date']);
  assert.match(e.description, /NAV/);
  assert.equal(e.timeSemantics.status, 'static');
});

test('a collection nobody produces is still "Other" (layer null)', { skip }, async () => {
  const e = await refreshCatalogEntry(owner, 'scratch_notes');
  assert.equal(e.layer, null);
  assert.deepEqual(e.producedBy, []);
});
