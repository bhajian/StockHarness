// #108: research data tools on real MongoDB. Fuzz: with as_of = D, no tool ever returns a row known after D,
// across random tools, inputs and dates, Layer 1 collections included. Needs TEST_DIRECT_MONGODB_URI.
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
const tools = await import('../../packages/core/src/dataTools.js');
const { knownAtOf } = await import('../../packages/core/src/knownAt.js');
const { agentView } = await import('../../packages/core/src/schemaCatalog.js');
const { policyOf } = await import('../../packages/core/src/pitPolicy.js');

const OWNER = `dt-${randomUUID()}`;
const db = () => mongo.db(workspaceDatabase(OWNER));
const weekdays = (from: string, n: number) => {
  const out: string[] = [];
  for (let t = Date.parse(from); out.length < n; t += 86400000)
    if (![0, 6].includes(new Date(t).getUTCDay())) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const DAYS = weekdays('2024-01-01', 120);
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

const CATALOG: Record<string, { layer: 1 | 2; timeSemantics: any; rows: Record<string, unknown>[] }> = {
  prices_daily: {
    layer: 2,
    timeSemantics: { status: 'pit', text: 'as_of_date', eventDate: 'as_of_date' },
    rows: DAYS.flatMap((d, i) =>
      ['SEC_1', 'SEC_2'].map((s) => ({
        uid: `p${i}${s}`,
        security_id: s,
        date: d,
        as_of_date: d,
        tr_1d: i / 1000,
      })),
    ),
  },
  insider_trades: {
    layer: 1,
    timeSemantics: { status: 'pit', text: '', rule: { type: 'timestamp', field: 'filingDate' } },
    rows: DAYS.map((d, i) => ({
      uid: `i${i}`,
      symbol: i % 2 ? 'AAA' : 'BBB',
      transactionDate: d,
      filingDate: `${d} ${String(6 + (i % 14)).padStart(2, '0')}:15:00`,
      shares: i,
    })),
  },
  income_statement: {
    layer: 1,
    timeSemantics: {
      status: 'pit',
      text: '',
      rule: { type: 'statement', field: 'acceptedDate', periodField: 'date' },
    },
    rows: DAYS.filter((_, i) => i % 9 === 0).map((d, i) => ({
      uid: `s${i}`,
      symbol: 'AAA',
      date: d,
      period: i % 4 === 3 ? 'Q4' : 'Q1',
      acceptedDate: i % 3 ? `${DAYS[Math.min(119, DAYS.indexOf(d) + 25)]} 16:30:00` : `${d} 00:00:00`,
      revenue: i * 10,
    })),
  },
  eod_prices: {
    layer: 1,
    timeSemantics: { status: 'pit', text: '', rule: { type: 'eod', field: 'date' } },
    rows: DAYS.map((d, i) => ({ uid: `e${i}`, symbol: 'AAA', date: d, close: 100 + i })),
  },
  company_profiles: {
    layer: 1,
    timeSemantics: { status: 'current_only', text: '', rule: { type: 'current_only' } },
    rows: [{ uid: 'c1', symbol: 'AAA', companyName: 'Alpha' }],
  },
};

before(async () => {
  if (!DIRECT_MONGO) return;
  await mongo.connect();
  // The holdout would otherwise lock on first use (latest - 18 months); start it after the data for the fuzz.
  await collection<any>('evaluator_settings').insertOne({
    _id: OWNER,
    holdoutMonths: 18,
    holdoutStart: '2024-07-01',
  });
  for (const [name, c] of Object.entries(CATALOG)) {
    await db()
      .collection(name)
      .insertMany(c.rows.map((r) => ({ ...r })));
    await collection<any>('dataset_catalog').insertOne({
      _id: `${OWNER}:${name}`,
      ownerId: OWNER,
      collection: name,
      layer: c.layer,
      producedBy: [],
      description: `${name} rows. Second sentence.`,
      grain: 'test',
      primaryKey: ['uid'],
      timeSemantics: c.timeSemantics,
      fields: [{ name: 'uid', type: 'string', null_pct: 0, doc: 'none' }],
      coverage: { rows: c.rows.length },
      freshness: {},
      joins: [],
      caveats: [],
      docCompletenessPct: 0,
      refreshedAt: new Date(),
    });
  }
});
after(async () => {
  if (!DIRECT_MONGO) return;
  await db().dropDatabase();
  for (const c of ['dataset_catalog', 'evaluator_settings', 'connections'])
    await collection<any>(c).deleteMany({ $or: [{ ownerId: OWNER }, { _id: OWNER }] });
  await mongo.close();
});

const byUid = new Map(
  Object.entries(CATALOG).flatMap(([name, c]) => c.rows.map((r) => [r.uid as string, { name, row: r }])),
);
function assertKnownBy(rows: Record<string, unknown>[], d: string, where: string) {
  for (const r of rows) {
    const src = byUid.get(String(r.uid));
    assert.ok(src, `${where}: row without its uid ${JSON.stringify(r)}`);
    const p = policyOf({ layer: CATALOG[src.name].layer, timeSemantics: CATALOG[src.name].timeSemantics });
    if (p.mode !== 'pit') continue;
    const asOf = knownAtOf(p.rule, src.row)?.as_of_date;
    assert.ok(asOf && asOf <= d, `${where}: ${src.name} ${r.uid} known ${asOf} > as_of ${d}`);
    assert.equal(r.as_of_date, asOf, `${where}: the row carries its as_of_date`);
  }
}

test('fuzz: no tool returns a row known after the session as_of', { skip: skipReason }, async () => {
  const readableNames = ['prices_daily', 'insider_trades', 'income_statement', 'eod_prices'];
  let checked = 0;
  for (let i = 0; i < 300; i++) {
    const D = pick(DAYS);
    const s = await tools.dataSession(OWNER, D);
    assert.equal(s.asOf, D);
    const name = pick(readableNames);
    const tool = pick(['query', 'query', 'query', 'sample']);
    const dateField = {
      prices_daily: 'date',
      insider_trades: 'filingDate',
      income_statement: 'date',
      eod_prices: 'date',
    }[name]!;
    const future = DAYS[Math.min(DAYS.length - 1, DAYS.indexOf(D) + 1 + Math.floor(rnd() * 20))];
    const filters = [
      {},
      { [dateField]: { $gt: D } },
      { [dateField]: { $gte: future } },
      { $or: [{ [dateField]: { $lte: future } }, { uid: { $exists: true } }] },
      { uid: { $in: [...byUid.keys()].filter(() => rnd() < 0.3) } },
    ];
    const asOfArg = pick([undefined, future, DAYS[Math.max(0, DAYS.indexOf(D) - 5)]]);
    const fields = pick([undefined, ['uid'], ['uid', 'shares'], ['uid', 'tr_1d', 'close']]);
    const result: any =
      tool === 'sample'
        ? await tools.callDataTool(s, 'sample_collection', { collection: name, n: 20 })
        : await tools.callDataTool(s, 'query_collection', {
            collection: name,
            filter: pick(filters),
            ...(fields ? { fields } : {}),
            ...(asOfArg ? { as_of: asOfArg } : {}),
            sort: pick([undefined, { [dateField]: -1 }, { [dateField]: 1 }]),
            limit: pick([5, 50, 500]),
          });
    assert.ok(result.as_of <= D, 'as_of can only move earlier');
    assertKnownBy(result.rows, result.as_of, `#${i} ${tool} ${name}`);
    checked += result.rows.length;
  }
  assert.ok(checked > 3000, `the fuzz saw rows (${checked})`);
});

test(
  'the session as_of is capped by the holdout and refuses non-point-in-time data',
  { skip: skipReason },
  async () => {
    await collection<any>('evaluator_settings').updateOne(
      { _id: OWNER },
      { $set: { holdoutMonths: 1, holdoutStart: DAYS[100] } },
      { upsert: true },
    );
    const s = await tools.dataSession(OWNER);
    assert.equal(s.latest, DAYS[119]);
    assert.equal(
      s.asOf,
      '2024-05-19',
      'the calendar day before the holdout (DAYS[100] is Monday 2024-05-20)',
    );
    const q: any = await tools.callDataTool(s, 'query_collection', {
      collection: 'prices_daily',
      filter: { date: { $gte: DAYS[100] } },
      as_of: DAYS[119],
    });
    assert.equal(q.count, 0, 'holdout rows are blocked');
    const all: any = await tools.callDataTool(s, 'query_collection', {
      collection: 'eod_prices',
      limit: 500,
    });
    assert.equal(all.rows.length, 100);
    await assert.rejects(
      tools.callDataTool(s, 'query_collection', { collection: 'company_profiles' }),
      /current values only/,
    );
    await assert.rejects(
      tools.callDataTool(s, 'query_collection', { collection: 'prices_daily', filter: { $where: '1' } }),
      /\$where is not allowed/,
    );
    await assert.rejects(
      tools.callDataTool(s, 'query_collection', { collection: 'nope' }),
      /not in the Schema Catalog/,
    );
    const listed: any = await tools.callDataTool(s, 'list_collections');
    assert.equal(listed.holdout_from, DAYS[100]);
    assert.equal(listed.collections.find((c: any) => c.collection === 'company_profiles').readable, false);
  },
);

test('describe_collection is the Catalog agent view', { skip: skipReason }, async () => {
  const s = await tools.dataSession(OWNER);
  const d: any = await tools.callDataTool(s, 'describe_collection', { collection: 'insider_trades' });
  const entry = await collection<any>('dataset_catalog').findOne({ _id: `${OWNER}:insider_trades` });
  assert.equal(d.text, agentView(entry).text);
});

test('research tokens name their connection and workspace', { skip: skipReason }, async () => {
  const id = randomUUID();
  await collection<any>('connections').insertOne({
    _id: id,
    ownerId: OWNER,
    kind: 'research',
    enabled: true,
  });
  const token = tools.researchToken(OWNER, id);
  assert.equal((await tools.verifyResearchToken(token))?.ownerId, OWNER);
  assert.equal(await tools.verifyResearchToken(tools.researchToken('someone-else', id)), undefined);
  assert.equal(
    await tools.verifyResearchToken(token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')),
    undefined,
  );
});

test(
  'collection bindings: the strict as_of filter never lets a row through early',
  { skip: skipReason },
  async () => {
    const { strictAsOfFilter } = await import('../../packages/core/src/collectionBindings.js');
    let kept = 0;
    for (const name of ['prices_daily', 'insider_trades', 'income_statement', 'eod_prices']) {
      const p = policyOf({ layer: CATALOG[name].layer, timeSemantics: CATALOG[name].timeSemantics });
      assert.equal(p.mode, 'pit');
      if (p.mode !== 'pit') continue;
      for (const D of DAYS.filter((_, i) => i % 7 === 0)) {
        const rows = await db().collection(name).find(strictAsOfFilter(p.rule, D)).toArray();
        for (const r of rows) {
          const asOf = knownAtOf(p.rule, r)?.as_of_date;
          assert.ok(asOf && asOf <= D, `${name} ${r.uid}: known ${asOf}, let through on ${D}`);
        }
        kept += rows.length;
      }
    }
    assert.ok(kept > 500, `rows were let through (${kept})`);
  },
);
