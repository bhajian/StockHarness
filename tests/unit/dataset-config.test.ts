import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { parseDatasetSyncConfig, toConfigEntry } =
  await import('../../packages/core/src/datasetSyncConfig.js');

const schedule = { enabled: true, everyMinutes: 1440, at: '18:30', input: 'daily', timezone: 'UTC' };

test('parses a `syncs:` YAML document with connection names', () => {
  const { entries, errors } = parseDatasetSyncConfig(`
apiVersion: stockharness/v1
kind: DatasetSyncs
syncs:
  - name: Daily EOD
    dataset: eod_prices
    connection: FMP
    symbolsMode: list
    symbols: [AAPL, MSFT]
    schedule: { enabled: true, everyMinutes: 1440, at: "18:30", input: daily }
  - name: Rates
    dataset: treasury_rates
    schedule: { enabled: false, everyMinutes: 1440, input: x }
`);
  assert.deepEqual(errors, []);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].connection, 'FMP');
  assert.deepEqual(entries[0].config.symbols, ['AAPL', 'MSFT']);
  assert.equal(entries[1].connection, undefined, 'no connection = workspace default on import');
  assert.equal(entries[1].config.enabled, true, 'schema defaults apply');
});

test('accepts the legacy config-io JSON export ($ref connections)', async () => {
  const text = JSON.stringify([
    {
      name: 'EOD',
      connectionId: { $ref: { type: 'connections', name: 'FMP' } },
      dataset: 'eod_prices',
      schedule: { enabled: true, everyMinutes: 1440, input: 'x' },
    },
    {
      name: 'Rates',
      connectionId: { $ref: { type: 'connections', name: 'FMP' } },
      dataset: 'treasury_rates',
      schedule: { enabled: false, everyMinutes: 1440, input: 'x' },
    },
  ]);
  const { entries, errors } = parseDatasetSyncConfig(text);
  assert.deepEqual(errors, []);
  assert.equal(entries.length, JSON.parse(text).length);
  assert.ok(entries.every((e) => e.connection === 'FMP'));
});

test('reports per-entry errors with file positions and rejects duplicates', () => {
  const { entries, errors } = parseDatasetSyncConfig(`
syncs:
  - { name: A, dataset: eod_prices, schedule: { enabled: true, everyMinutes: 1440, input: x } }
  - { name: B, dataset: no_such_dataset, schedule: { enabled: true, everyMinutes: 1440, input: x } }
  - { name: A, dataset: eod_index, schedule: { enabled: true, everyMinutes: 1440, input: x } }
  - { name: C, dataset: eod_prices }
  - just a string
`);
  assert.equal(entries.length, 1);
  assert.deepEqual(
    errors.map((e) => [e.index, e.name]),
    [
      [1, 'B'],
      [2, 'A'],
      [3, 'C'],
      [4, undefined],
    ],
  );
  assert.match(errors[0].message, /Unknown dataset/);
  assert.match(errors[1].message, /Duplicate name/);
  assert.match(errors[2].message, /^schedule/);
});

test('rejects non-YAML and documents without a sync list', () => {
  assert.throws(() => parseDatasetSyncConfig('syncs: [unclosed'), /Not valid YAML/);
  assert.throws(() => parseDatasetSyncConfig('foo: bar'), /syncs/);
});

test('export entry drops server state, names the connection, and round-trips', () => {
  const entry = toConfigEntry(
    {
      _id: 'id1',
      ownerId: 'o',
      name: 'EOD',
      enabled: false,
      connectionId: 'conn-1',
      dataset: 'eod_prices',
      symbolsMode: 'universe',
      from: '2021-01-01',
      schedule,
      cursor: '2026-11-01',
      lastRows: 5,
      lastError: 'x',
      nextRunAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    'FMP',
  );
  assert.deepEqual(Object.keys(entry), [
    'name',
    'dataset',
    'connection',
    'enabled',
    'symbolsMode',
    'from',
    'schedule',
  ]);
  const { entries, errors } = parseDatasetSyncConfig(
    `syncs:\n${JSON.stringify([entry]).slice(1, -1).replace(/^/, '  - ')}`,
  );
  assert.deepEqual(errors, []);
  assert.equal(entries[0].connection, 'FMP');
  assert.deepEqual(parse(JSON.stringify(entries[0].config)).schedule, schedule);
});
