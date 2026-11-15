// #86 lag in expected sessions; #386 which collections are judged by session lag at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { lagSessions, isDailySeries } = await import('../../packages/core/src/dataHealth.js');

test('sessions after the latest date, ignoring today', () => {
  const expected = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04'];
  assert.equal(lagSessions(expected, '2026-11-03', '2026-11-04'), 0);
  assert.equal(lagSessions(expected, '2026-10-29', '2026-11-04'), 3);
  assert.equal(lagSessions(expected, undefined, '2026-11-04'), undefined);
});

const DAY = 1440;
const WEEK = 10080;
const l1 = (dataset: string) => ({
  layer: 1 as const,
  grain: '',
  timeSemantics: { status: 'pit' as const, text: '' },
  producedBy: [{ type: 'sync' as const, name: dataset, id: dataset, dataset }],
});
const l2 = (grain: string, status: 'pit' | 'static' = 'pit') => ({
  layer: 2 as const,
  grain,
  timeSemantics: { status, text: '' },
  producedBy: [{ type: 'transform' as const, name: 't' }],
});

test('daily time series synced daily are judged by session lag', () => {
  assert.equal(isDailySeries(l1('eod_prices'), DAY), true);
  assert.equal(isDailySeries(l1('eod_index'), DAY), true);
  assert.equal(isDailySeries(l1('treasury_rates'), DAY), true);
});

test('a daily series whose schedule is off or weekly is not', () => {
  assert.equal(isDailySeries(l1('eod_prices'), undefined), false);
  assert.equal(isDailySeries(l1('eod_prices'), WEEK), false);
});

test('weekly snapshots ("Every Saturday at …" contains "day") are not', () => {
  assert.equal(isDailySeries(l1('grades_consensus'), WEEK), false);
  assert.equal(isDailySeries(l1('analyst_estimates'), WEEK), false);
});

test('quarterly statements, ratios and segments (period-end dates) are not', () => {
  for (const d of ['balance_sheet', 'cash_flow', 'key_metrics', 'ratios', 'enterprise_values'])
    assert.equal(isDailySeries(l1(d), WEEK), false, d);
  assert.equal(isDailySeries(l1('revenue_geo_segmentation'), WEEK), false);
  // Even if someone schedules them daily, their latest date is a fiscal period end.
  assert.equal(isDailySeries(l1('balance_sheet'), DAY), false);
});

test('monthly and quarterly macro are not', () => {
  assert.equal(isDailySeries(l1('economic_cpi'), WEEK), false);
  assert.equal(isDailySeries(l1('economic_gdp'), DAY), false);
});

test('feeds (transaction or disclosure dates) are not', () => {
  assert.equal(isDailySeries(l1('congress_senate'), DAY), false);
  assert.equal(isDailySeries(l1('insider_trades'), DAY), false);
  assert.equal(isDailySeries(l1('news_stocks'), DAY), false);
});

test('Layer 2 tables with one row per trading day are; static and other grains are not', () => {
  assert.equal(isDailySeries(l2('security × trading day')), true);
  assert.equal(isDailySeries(l2('trading day')), true);
  assert.equal(isDailySeries(l2('one row per security_id per trading date')), true);
  assert.equal(isDailySeries(l2('trading day', 'static')), false); // trading_calendar
  assert.equal(isDailySeries(l2('security × fiscal quarter × version')), false); // fundamentals_pit
  assert.equal(isDailySeries(l2('security × action × ex-date')), false); // corporate_actions
});

test('collections with no known producer are not', () => {
  assert.equal(isDailySeries({ ...l1('x'), layer: null, producedBy: [] }, DAY), false);
});

test('gap strip: sessions before today, missing and partial ones marked (#395)', async () => {
  const { gapCells, gapSummary } = await import('../../packages/core/src/dataHealth.js');
  const expected = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16'];
  const rows = new Map<string, number | null>([
    ['2026-11-09', 3300],
    ['2026-11-10', 3310],
    ['2026-11-11', 300], // a run that only reached a tenth of the symbols
    ['2026-11-13', 3305],
  ]);
  const cells = gapCells(expected, rows, '2026-11-16');
  assert.deepEqual(
    cells.map((c) => [c.date, c.rows, Boolean(c.partial)]),
    [
      ['2026-11-09', 3300, false],
      ['2026-11-10', 3310, false],
      ['2026-11-11', 300, true],
      ['2026-11-12', 0, false],
      ['2026-11-13', 3305, false],
    ],
    "today's session is not a gap yet",
  );
  assert.deepEqual(gapSummary(cells), { missing: 1, partial: 1 });
});

test('coverage basis: listed names for current-only data, everyone for history (#395)', async () => {
  const { coverageBasis } = await import('../../packages/core/src/schemaCatalog.js');
  const { catalogById } = await import('../../packages/core/src/datasetCatalog.js');
  for (const id of [
    'company_profiles',
    'shares_float',
    'stock_peers',
    'analyst_estimates',
    'grades_consensus',
  ])
    assert.equal(coverageBasis(catalogById.get(id)!), 'active', id);
  for (const id of [
    'eod_prices',
    'historical_market_cap',
    'income_statement',
    'dividends_history',
    'key_metrics',
  ])
    assert.equal(coverageBasis(catalogById.get(id)!), 'all', id);
  assert.match(catalogById.get('dividends_history')!.sparse!, /dividend/);
  assert.equal(catalogById.get('eod_prices')!.sparse, undefined);
});

test('a Layer 2 output keyed by date is a daily series even without a grain text (#409)', () => {
  assert.equal(isDailySeries({ ...l2('one row per symbol × date'), primaryKey: ['symbol', 'date'] }), true);
  assert.equal(
    isDailySeries({ ...l2('', 'static'), primaryKey: ['symbol', 'date'] }),
    false,
    'static stays out',
  );
  assert.equal(
    isDailySeries({
      ...l2('one row per security × ex_date'),
      primaryKey: ['security_id', 'action_type', 'ex_date'],
    }),
    false,
    'corporate actions are events, not a daily series',
  );
});

test('logs are not daily series even when keyed by date (#428)', () => {
  assert.equal(
    isDailySeries({
      ...l2('one row per issue'),
      primaryKey: ['collection', 'issue_type', 'security_id', 'date'],
      collection: 'dq_issues',
    }),
    false,
  );
});

test('bond-market holidays: Columbus Day and Veterans Day (observed) are not treasury gaps (#434)', async () => {
  const { bondHolidays, gapCells } = await import('../../packages/core/src/dataHealth.js');
  const h = bondHolidays(['2026-10-01', '2027-11-01', '2029-11-01', '2028-11-01']);
  assert.ok(h.has('2026-10-12') && h.has('2026-11-11'), '2026: Mon Oct 12, Wed Nov 11');
  assert.ok(h.has('2027-10-11') && h.has('2027-11-11'));
  assert.ok(h.has('2029-11-12'), '2029: Nov 11 is a Sunday, observed Monday');
  assert.ok(!h.has('2028-11-10') && !h.has('2028-11-11'), '2028: Nov 11 is a Saturday, no close');
  const cells = gapCells(
    ['2026-11-10', '2026-11-11', '2026-11-12'],
    new Map([
      ['2026-11-10', 1],
      ['2026-11-12', 1],
    ]),
    '2026-11-13',
    h,
  );
  assert.deepEqual(
    cells.map((c) => c.date),
    ['2026-11-10', '2026-11-12'],
  );
});
