// Every field of every collection is documented (#394): agents read these docs through the Schema Catalog.
// tests/fixtures/catalog-field-names.json is a snapshot of the live field list; a field resolves the way the
// catalog resolves it (curated > declared by its transform > the built-in dictionary).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseAllDocuments } from 'yaml';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { resolveFieldDoc } = await import('../../packages/core/src/schemaCatalog.js');
const { builtinFieldDoc } = await import('../../packages/core/src/fieldDocs.js');

type Snapshot = {
  collections: Record<string, { layer: number | null; fields: string[]; curated: string[] }>;
};
const snapshot = JSON.parse(await readFile('tests/fixtures/catalog-field-names.json', 'utf8')) as Snapshot;
// Fields a transform declares for its outputs (the committed copy of the live Transform objects).
const declared: Record<string, Record<string, { description?: string; unit?: string }>> = {};
for (const d of parseAllDocuments(await readFile('deploy/config-io/exports/transforms.yaml', 'utf8'))) {
  const t = d.toJS() as { spec?: { outputs?: { collection: string; fields?: Record<string, unknown> }[] } };
  for (const o of t.spec?.outputs ?? [])
    declared[o.collection] = Object.fromEntries(
      Object.entries(o.fields ?? {}).map(([k, v]) => [k, v as { description?: string; unit?: string }]),
    );
}

test('every live field has a doc: curated, declared by its transform, or built in', () => {
  const missing: string[] = [];
  let total = 0;
  for (const [collection, { fields, curated }] of Object.entries(snapshot.collections))
    for (const name of fields) {
      total++;
      // Curated docs (oh.describe or an edit) live in the catalog itself and survive every refresh.
      if (curated.includes(name)) continue;
      if (!resolveFieldDoc(name, { collection, declared: declared[collection] }))
        missing.push(`${collection}.${name}`);
    }
  assert.ok(total > 1000, `the snapshot covers the live catalog (${total} fields)`);
  assert.deepEqual(missing, [], `${missing.length} undocumented fields`);
});

test('a name means what it means in its collection', () => {
  assert.match(builtinFieldDoc('cash_flow', 'inventory')!.description, /^Change in inventory/);
  assert.match(builtinFieldDoc('balance_sheet', 'inventory')!.description, /^Inventories/);
  assert.match(builtinFieldDoc('index_changes', 'symbol')!.description, /removed ticker on removals/);
  assert.match(
    builtinFieldDoc('eod_prices', 'symbol')!.description,
    /FMP ticker/,
    'falls back to the shared doc',
  );
  assert.match(builtinFieldDoc('economic_cpi', 'value')!.unit!, /index/);
  assert.equal(builtinFieldDoc('nowhere', 'not_a_field'), undefined);
  // Curated beats declared beats built in.
  assert.equal(
    resolveFieldDoc('close', {
      collection: 'prices_daily',
      curated: { fields: { close: { description: 'Edited.' } } },
      declared: { close: { description: 'Declared.' } },
    })!.description,
    'Edited.',
  );
  assert.equal(
    resolveFieldDoc('close', { declared: { close: { description: 'Declared.' } } })!.description,
    'Declared.',
  );
  assert.equal(resolveFieldDoc('close')!.doc, 'dictionary');
});

test('units are spelled consistently', () => {
  const units = new Set<string>();
  for (const [collection, { fields }] of Object.entries(snapshot.collections))
    for (const name of fields) {
      const u = builtinFieldDoc(collection, name)?.unit;
      if (u) units.add(u);
    }
  const allowed = [
    /^USD$/,
    /^USD\/share$/,
    /^reportedCurrency(\/share)?$/,
    /^shares$/,
    /^percent points$/,
    /^ratio( \(×\))?$/,
    /^fraction \(0\.25 = 25%\)$/,
    /^days$/,
    /^count$/,
    /^index/,
    /^billions of USD$/,
  ];
  for (const u of units)
    assert.ok(
      allowed.some((r) => r.test(u)),
      `unit "${u}"`,
    );
});
