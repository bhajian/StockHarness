import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { perSymbolParams } = await import('../../packages/core/src/datasetSync.js');
const { catalogById } = await import('../../packages/core/src/datasetCatalog.js');
const def = (id: string) => catalogById.get(id)!;

test('statements: the sync depth replaces the fixed limit, and the period can be annual', () => {
  assert.deepEqual(perSymbolParams(def('income_statement'), {}, 'AAPL', '2026-11-04'), {
    period: 'quarter',
    limit: 8,
    symbol: 'AAPL',
  });
  assert.deepEqual(perSymbolParams(def('income_statement'), { historyPeriods: 40 }, 'AAPL', '2026-11-04'), {
    period: 'quarter',
    limit: 40,
    symbol: 'AAPL',
  });
  assert.equal(
    perSymbolParams(def('balance_sheet'), { statementPeriod: 'annual' }, 'AAPL', '2026-11-04').period,
    'annual',
  );
  assert.ok(
    def('income_statement').keyFields.includes('period'),
    'FY and Q4 rows with the same date never collide',
  );
});

test('time series: cursor, then the sync start date, then one year', () => {
  const eod = def('eod_prices');
  assert.equal(perSymbolParams(eod, { from: '2016-01-01' }, 'AAPL', '2026-11-04').from, '2016-01-01');
  assert.equal(
    perSymbolParams(eod, { from: '2016-01-01', cursor: '2026-10-23' }, 'AAPL', '2026-11-04').from,
    '2026-10-23',
  );
  assert.equal(perSymbolParams(eod, {}, 'AAPL', '2026-11-04').from, '2025-11-04');
  assert.equal(
    perSymbolParams(eod, { historyPeriods: 40 }, 'AAPL', '2026-11-04').limit,
    undefined,
    'no limit on time series',
  );
});
