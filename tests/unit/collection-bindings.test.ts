// #148: collection-scoped MongoDB tools. Offered tools, the collection enum, permission and join checks, and the
// fixed filter / projection / row cap / as_of cut on the wire.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const B = await import('../../packages/core/src/collectionBindings.js');

const bindings = [
  {
    name: 'prices_daily',
    permissions: ['read'] as const,
    maxRows: 100,
    filter: { symbol: { $in: ['AAPL'] } },
  },
  { name: 'features_daily', permissions: ['read'] as const },
  { name: 'watchlist', permissions: ['read', 'insert'] as const, approval: 'always' as const },
  { name: 'scratch', permissions: ['read', 'insert', 'update', 'delete'] as const, fields: ['a', 'b'] },
].map((b) => ({ ...b, permissions: [...b.permissions] }));
const ALL = [
  'find',
  'aggregate',
  'count',
  'collection-schema',
  'insert-many',
  'update-many',
  'delete-many',
  'drop-collection',
  'create-index',
  'rename-collection',
  'list-collections',
  'db-stats',
];

test('only granted, non-admin, single-collection tools are offered', () => {
  assert.deepEqual(B.scopedToolNames(ALL, bindings), [
    'find',
    'aggregate',
    'count',
    'collection-schema',
    'insert-many',
    'update-many',
    'delete-many',
  ]);
  assert.deepEqual(B.scopedToolNames(ALL, [bindings[0]]), [
    'find',
    'aggregate',
    'count',
    'collection-schema',
  ]);
});

test('collection becomes an enum of the collections bound for the operation; fields in the description', () => {
  const s = B.scopeToolSchema(
    'insert-many',
    { type: 'object', properties: { collection: { type: 'string' }, documents: { type: 'array' } } },
    'Mongo / insert-many: Insert',
    bindings,
    (c) => (c === 'watchlist' ? ['symbol', 'note'] : undefined),
  );
  assert.deepEqual(s.inputSchema.properties.collection.enum, ['watchlist', 'scratch']);
  assert.match(s.description, /- watchlist \(read, insert\): symbol, note/);
  assert.match(s.description, /- scratch \(read, insert, update, delete\): a, b/);
});

test('unbound collections, missing permissions and cross-collection stages are refused', () => {
  assert.match(B.bindingProblem('find', { collection: 'eod_prices' }, bindings)!, /not bound to this agent/);
  assert.match(B.bindingProblem('delete-many', { collection: 'prices_daily' }, bindings)!, /needs delete/);
  assert.match(B.bindingProblem('delete-many', { collection: 'watchlist' }, bindings)!, /needs delete/);
  assert.match(B.bindingProblem('drop-collection', { collection: 'scratch' }, bindings)!, /not available/);
  assert.match(
    B.bindingProblem('update-many', { collection: 'scratch', filter: {}, update: {}, upsert: true }, [
      { name: 'scratch', permissions: ['update'] },
    ])!,
    /upsert .* needs insert/,
  );
  const lookup = (from: string) => ({
    collection: 'features_daily',
    pipeline: [{ $lookup: { from, localField: 'a', foreignField: 'a', as: 'x' } }],
  });
  assert.match(B.bindingProblem('aggregate', lookup('eod_prices'), bindings)!, /reaches eod_prices/);
  assert.match(B.bindingProblem('aggregate', lookup('prices_daily'), bindings)!, /cannot be joined into/);
  assert.equal(B.bindingProblem('aggregate', lookup('scratch'), bindings), undefined);
  const nested = {
    collection: 'features_daily',
    pipeline: [{ $facet: { a: [{ $unionWith: { coll: 'secrets' } }] } }],
  };
  assert.match(B.bindingProblem('aggregate', nested, bindings)!, /reaches secrets/);
  assert.match(
    B.bindingProblem(
      'aggregate',
      { collection: 'scratch', pipeline: [{ $out: 'features_daily' }] },
      bindings,
    )!,
    /needs insert or update/,
  );
  assert.equal(
    B.bindingProblem(
      'aggregate',
      { collection: 'features_daily', pipeline: [{ $merge: { into: 'scratch' } }] },
      bindings,
    ),
    undefined,
  );
  assert.equal(B.bindingProblem('find', { collection: 'prices_daily' }, bindings), undefined);
});

test('approval applies to writes on bindings that ask for it', () => {
  assert.equal(B.needsBindingApproval('insert-many', { collection: 'watchlist' }, bindings), true);
  assert.equal(B.needsBindingApproval('find', { collection: 'watchlist' }, bindings), false);
  assert.equal(B.needsBindingApproval('insert-many', { collection: 'scratch' }, bindings), false);
  assert.equal(
    B.needsBindingApproval(
      'aggregate',
      { collection: 'scratch', pipeline: [{ $out: 'watchlist' }] },
      bindings,
    ),
    true,
  );
});

test('the fixed filter, projection and row cap are always applied', () => {
  const find = B.applyBinding(
    'find',
    { collection: 'prices_daily', filter: { date: '2024-01-02' }, limit: 5000 },
    bindings,
  );
  assert.deepEqual(find.filter, { $and: [{ date: '2024-01-02' }, { symbol: { $in: ['AAPL'] } }] });
  assert.equal(find.limit, 100);
  const count = B.applyBinding('count', { collection: 'prices_daily' }, bindings);
  assert.deepEqual(count.query, { $and: [{ symbol: { $in: ['AAPL'] } }] });
  const agg = B.applyBinding(
    'aggregate',
    { collection: 'prices_daily', pipeline: [{ $group: { _id: null } }] },
    bindings,
  );
  assert.deepEqual(agg.pipeline, [
    { $match: { symbol: { $in: ['AAPL'] } } },
    { $group: { _id: null } },
    { $limit: 100 },
  ]);
  const projected = B.applyBinding(
    'find',
    { collection: 'scratch', projection: { a: 1, secret: 1 } },
    bindings,
  );
  assert.deepEqual(projected.projection, { a: 1, _id: 0 });
  const del = B.applyBinding('delete-many', { collection: 'scratch', filter: { a: 1 } }, [
    { name: 'scratch', permissions: ['delete'], filter: { owner: 'me' } },
  ]);
  assert.deepEqual(del.filter, { $and: [{ a: 1 }, { owner: 'me' }] });
});

test('enforce as_of cuts reads with the collection rule, and blocks collections without one', () => {
  const asOf = [{ name: 'insider_trades', permissions: ['read' as const], enforceAsOf: true }];
  const session = {
    asOf: '2024-03-08',
    ruleOf: (c: string) =>
      c === 'insider_trades' ? { type: 'timestamp' as const, field: 'filingDate' } : undefined,
  };
  const f = B.applyBinding('find', { collection: 'insider_trades' }, asOf, session);
  assert.deepEqual(f.filter, { $and: [{ filingDate: { $lt: '2024-03-08', $type: 'string', $ne: '' } }] });
  assert.throws(
    () =>
      B.applyBinding('find', { collection: 'insider_trades' }, asOf, { ...session, ruleOf: () => undefined }),
    /no known point-in-time rule/,
  );
  assert.deepEqual(
    B.strictAsOfFilter({ type: 'periodLag', periodField: 'date', lagDays: 90 }, '2024-04-01'),
    {
      date: { $lte: '2024-01-01', $type: 'string', $ne: '' },
    },
  );
});

test('bindings travel from canvas resources to the agent, and the data chatbot starter binds read-only', async () => {
  const { agentWithResources } = await import('../../packages/core/src/workflow.js');
  const { makeStarter, DATA_CHATBOT_COLLECTIONS } = await import('../../packages/core/src/starters.js');
  const { agentSchema, workflowSchema } = await import('../../packages/core/src/schema.js');
  const wf = workflowSchema.parse(
    makeStarter({
      kind: 'data-chatbot',
      providerId: '00000000-0000-4000-8000-000000000001',
      connectionId: '00000000-0000-4000-8000-000000000002',
      tools: ['find', 'aggregate'],
    }),
  );
  const node = wf.nodes.find((n) => n.type === 'agent')!;
  const agent = agentWithResources(wf, node.id, agentSchema.parse((node as any).config));
  assert.deepEqual(agent.connections, [
    {
      connectionId: '00000000-0000-4000-8000-000000000002',
      tools: ['find', 'aggregate'],
      collections: DATA_CHATBOT_COLLECTIONS.map((name) => ({ name, permissions: ['read'], maxRows: 200 })),
    },
  ]);
});
