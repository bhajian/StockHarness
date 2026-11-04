import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { inferFields, agentView } = await import('../../packages/core/src/schemaCatalog.js');

test('field inference: types, null %, ranges, examples, and where docs come from', () => {
  const docs = [
    {
      symbol: 'AAPL',
      date: '2026-10-23',
      close: 347.73,
      volume: 39323315,
      note: '',
      customThing: 1,
      publishedDate: '2026-10-23 16:00:24',
    },
    { symbol: 'MSFT', date: '2026-10-22', close: 512.1, volume: 20000000, note: null, customThing: 2.5 },
  ];
  const f = Object.fromEntries(
    inferFields(docs, { fields: { customThing: { description: 'Curated meaning', unit: 'x' } } }).map((x) => [
      x.name,
      x,
    ]),
  );
  assert.equal(f.date.type, 'date');
  assert.deepEqual([f.date.min, f.date.max], ['2026-10-22', '2026-10-23']);
  assert.equal(f.close.type, 'number');
  assert.deepEqual([f.close.min, f.close.max], [347.73, 512.1]);
  assert.equal(f.volume.type, 'integer');
  assert.equal(f.note.null_pct, 100, 'empty strings and nulls count as missing');
  assert.equal(f.publishedDate.type, 'datetime');
  assert.equal(f.publishedDate.null_pct, 50);
  assert.equal(f.customThing.type, 'number', 'integers and floats together are numbers');
  assert.deepEqual(
    [f.customThing.doc, f.customThing.description, f.customThing.unit],
    ['curated', 'Curated meaning', 'x'],
  );
  assert.equal(f.close.doc, 'dictionary');
  assert.equal(f.close.unit, 'USD');
});

test('agent view states the point-in-time rule and warns on current-only data', () => {
  const base = {
    _id: 'o:x',
    ownerId: 'o',
    layer: 1 as const,
    producedBy: [],
    grain: 'one row per symbol',
    primaryKey: ['symbol'],
    fields: [
      {
        name: 'sector',
        type: 'string' as const,
        null_pct: 0,
        doc: 'dictionary' as const,
        description: 'Sector.',
      },
    ],
    coverage: { rows: 2189, symbols: 2189 },
    freshness: {},
    joins: [],
    docCompletenessPct: 100,
    refreshedAt: new Date(),
  };
  const v = agentView({
    ...base,
    collection: 'company_profiles',
    description: 'Company profile per symbol.',
    timeSemantics: { status: 'current_only', text: 'current value only' },
  } as any);
  assert.match(v.text, /CURRENT ONLY \(never use historically\)/);
  assert.match(v.text, /- sector \(string\): Sector\./);
  assert.ok(v.tokens > 10 && v.tokens < 400);
});
