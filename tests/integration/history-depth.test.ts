// #77 plan-depth probe against real MongoDB (TEST_DIRECT_MONGODB_URI); FMP is an in-process fake.
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
const { probeDatasetDepth } = await import('../../packages/core/src/datasetSync.js');

const owner = `depth-${randomUUID()}`;
const conn = randomUUID();
const realFetch = globalThis.fetch;
const requested: string[] = [];

before(async () => {
  if (!DIRECT_MONGO) return;
  await mongo.connect();
  await collection<any>('connections').insertOne({
    _id: conn,
    ownerId: owner,
    name: 'FMP',
    kind: 'mcp',
    enabled: true,
    url: 'https://fmp.example.test/mcp?apikey=K',
  });
  globalThis.fetch = (async (url: string) => {
    if (!String(url).startsWith('https://financialmodelingprep.com/')) return realFetch(url);
    requested.push(String(url));
    const u = new URL(String(url));
    if (u.pathname.endsWith('/income-statement')) {
      // The plan returns 30 of the 200 quarters asked for.
      const rows = Array.from({ length: 30 }, (_, i) => ({
        date: `${2019 + Math.floor(i / 4)}-${String(3 * (i % 4) + 3).padStart(2, '0')}-30`,
        period: `Q${(i % 4) + 1}`,
      }));
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    return new Response(
      JSON.stringify([{ date: '2021-10-25' }, { date: '2026-11-03' }, { date: '2024-01-02' }]),
      { status: 200 },
    );
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  if (!DIRECT_MONGO) return;
  await collection<any>('connections').deleteMany({ ownerId: owner });
  await mongo.close();
});

test(
  'the probe asks for maximum depth and reports what the plan returned',
  { skip: skipReason },
  async () => {
    const prices = await probeDatasetDepth(owner, { dataset: 'eod_prices', connectionId: conn });
    assert.match(requested[0], /from=1980-01-01/);
    assert.match(requested[0], /symbol=AAPL/);
    assert.deepEqual(
      [prices.rows, prices.earliest, prices.latest, prices.years],
      [3, '2021-10-25', '2026-11-03', 5],
    );
    const stmts = await probeDatasetDepth(owner, {
      dataset: 'income_statement',
      connectionId: conn,
      symbol: 'msft',
    });
    assert.match(requested[1], /limit=200/);
    assert.match(requested[1], /symbol=MSFT/);
    assert.equal(stmts.rows, 30);
    await assert.rejects(
      probeDatasetDepth(owner, { dataset: 'treasury_rates', connectionId: conn }),
      /per-symbol/,
    );
  },
);
