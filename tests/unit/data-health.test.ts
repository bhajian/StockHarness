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
