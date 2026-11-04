import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { KNOWN_AT, knownAtOf, describeKnownAt, easternToUtc } =
  await import('../../packages/core/src/knownAt.js');
const { DATASET_CATALOG } = await import('../../packages/core/src/datasetCatalog.js');

test('every catalog dataset declares a known-at rule', () => {
  const missing = DATASET_CATALOG.map((d) => d.id).filter((id) => !KNOWN_AT[id]);
  assert.deepEqual(missing, []);
  const ids = new Set(DATASET_CATALOG.map((d) => d.id));
  assert.deepEqual(
    Object.keys(KNOWN_AT).filter((k) => !ids.has(k)),
    ['delisted_companies'],
    'only known side outputs have rules without a dataset',
  );
  for (const r of Object.values(KNOWN_AT)) assert.ok(describeKnownAt(r).length > 10);
});

test('Eastern time conversion is DST-correct', () => {
  assert.equal(easternToUtc(2026, 7, 31, 16, 0).toISOString(), '2026-07-31T20:00:00.000Z'); // EDT
  assert.equal(easternToUtc(2026, 1, 15, 16, 0).toISOString(), '2026-01-15T21:00:00.000Z'); // EST
});

test('EOD prices: known at the close, usable the same date', () => {
  assert.deepEqual(knownAtOf(KNOWN_AT.eod_prices, { date: '2026-10-23' }), {
    known_at: '2026-10-23T20:00:00.000Z',
    as_of_date: '2026-10-23',
  });
});

test('statements: real acceptance time, or the period-end placeholder lag', () => {
  // AAPL Q3 FY26 10-Q accepted 2026-07-31 06:01 ET, before the open, so usable that day.
  assert.equal(
    knownAtOf(KNOWN_AT.income_statement, {
      date: '2026-06-27',
      acceptedDate: '2026-07-31 06:01:02',
      period: 'Q3',
    })!.as_of_date,
    '2026-07-31',
  );
  // Accepted after the open: the next session.
  assert.equal(
    knownAtOf(KNOWN_AT.income_statement, {
      date: '2026-06-27',
      acceptedDate: '2026-07-31 16:05:00',
      period: 'Q3',
    })!.as_of_date,
    '2026-08-03',
  );
  // Placeholder (acceptedDate == period end): + 45 days for Q1–Q3, + 90 days for Q4.
  assert.equal(
    knownAtOf(KNOWN_AT.balance_sheet, {
      date: '2024-09-30',
      acceptedDate: '2024-09-30 00:00:00',
      period: 'Q3',
    })!.as_of_date,
    '2024-11-15',
  );
  assert.equal(
    knownAtOf(KNOWN_AT.cash_flow, { date: '2024-12-31', acceptedDate: '2024-12-31 00:00:00', period: 'Q4' })!
      .as_of_date,
    '2025-04-01',
  );
});

test('filings and feeds: date-only means end of day, so usable the next session', () => {
  // Filed Friday 2026-10-23 (time unknown): next session Monday.
  assert.equal(
    knownAtOf(KNOWN_AT.insider_trades, { filingDate: '2026-10-23', transactionDate: '2026-10-15' })!
      .as_of_date,
    '2026-10-26',
  );
  assert.equal(
    knownAtOf(KNOWN_AT.congress_house, { disclosureDate: '2026-10-09', transactionDate: '2026-09-04' })!
      .as_of_date,
    '2026-10-12',
  );
  // UTC timestamp 23:13Z = 19:13 ET, after the close: next session.
  assert.equal(
    knownAtOf(KNOWN_AT.analyst_grades, { publishedDate: '2026-10-23T23:13:09.000Z' })!.as_of_date,
    '2026-10-26',
  );
});

test('dividends use declarationDate, else the ex-date; splits the day before', () => {
  assert.equal(
    knownAtOf(KNOWN_AT.dividends_history, { date: '2026-08-10', declarationDate: '2026-07-30' })!.as_of_date,
    '2026-07-31',
  );
  assert.equal(
    knownAtOf(KNOWN_AT.dividends_history, { date: '2026-08-10', declarationDate: '' })!.as_of_date,
    '2026-08-11',
  );
  assert.equal(knownAtOf(KNOWN_AT.splits_history, { date: '2020-08-31' })!.as_of_date, '2020-08-31');
});

test('earnings react next session; snapshots on their date; current-only never', () => {
  assert.equal(knownAtOf(KNOWN_AT.earnings_calendar, { date: '2026-10-23' })!.as_of_date, '2026-10-26');
  assert.equal(
    knownAtOf(KNOWN_AT.analyst_estimates, { snapshot_date: '2026-10-31', date: '2026-09-27' })!.as_of_date,
    '2026-11-02',
  );
  assert.equal(knownAtOf(KNOWN_AT.company_profiles, { symbol: 'AAPL', sector: 'Technology' }), null);
  assert.equal(knownAtOf(KNOWN_AT.key_metrics, { date: '2024-12-31' })!.as_of_date, '2025-04-01');
});
