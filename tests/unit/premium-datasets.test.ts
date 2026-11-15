// Premium FMP plan datasets (#387): variants, rolling windows, the common-stock filter and backfill plans.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { catalogById, variantsOf, DATASET_CATALOG, ECONOMIC_INDICATORS, FMP_SECTORS, presetById } =
  await import('../../packages/core/src/datasetCatalog.js');
const { tagRows, rollingWindow, isCommonStockSymbol, perSymbolParams, chunkRanges, UNIVERSE_MIN_MARKET_CAP } =
  await import('../../packages/core/src/datasetSync.js');
const { planBackfill, backfillUnsupported } = await import('../../packages/core/src/datasetBackfill.js');
const { defaultPriority } = await import('../../packages/core/src/syncScheduler.js');
const def = (id: string) => catalogById.get(id)!;

test('variants: one call per index, sector and indicator, each tagged', () => {
  const idx = variantsOf(def('index_constituents'));
  assert.deepEqual(
    idx.map((v) => [v.endpoint, v.tag.index]),
    [
      ['sp500-constituent', 'sp500'],
      ['nasdaq-constituent', 'ndx'],
      ['dowjones-constituent', 'dji'],
    ],
  );
  assert.deepEqual(
    variantsOf(def('index_changes')).map((v) => v.endpoint),
    ['historical-sp500-constituent', 'historical-nasdaq-constituent', 'historical-dowjones-constituent'],
  );
  const sectors = variantsOf(def('sector_performance'));
  assert.equal(sectors.length, FMP_SECTORS.length);
  assert.ok(sectors.every((v) => v.endpoint === 'historical-sector-performance' && v.params.sector));
  assert.deepEqual(
    variantsOf(def('economic_indicators')).map((v) => v.params.name),
    ECONOMIC_INDICATORS,
  );
  // A dataset without variants is one call with its own endpoint and params.
  assert.deepEqual(variantsOf(def('economic_cpi')), [
    { endpoint: 'economic-indicators', params: { name: 'CPI' }, tag: {} },
  ]);
  const rows = tagRows([{ symbol: 'OKTA' }, null, { symbol: 'TWLO' }], { index: 'sp500' });
  assert.deepEqual(rows, [{ symbol: 'OKTA', index: 'sp500' }, null, { symbol: 'TWLO', index: 'sp500' }]);
});

test('rolling windows: calendars look ahead; treasury and macro look back far enough', () => {
  const now = '2026-11-14';
  assert.deepEqual(rollingWindow(def('earnings_calendar'), {}, now), {
    from: '2026-11-07',
    to: '2026-11-28',
  });
  assert.deepEqual(rollingWindow(def('treasury_rates'), {}, now), { from: '2026-10-31', to: '2026-11-14' });
  // CPI for October is dated 2026-10-01 and published mid-November; revisions reach back months: re-pull a year.
  const cpi = rollingWindow(def('economic_cpi'), {}, now);
  assert.ok(cpi.from <= '2025-11-14' && cpi.to === now, JSON.stringify(cpi));
  // Every chunk stays under FMP's per-call range: 3 months for treasury, 1 year for economic indicators.
  for (const [id, maxDays] of [
    ['treasury_rates', 90],
    ['economic_indicators', 365],
  ] as const) {
    for (const [a, b] of chunkRanges('2016-01-01', now, def(id).windowDays!))
      assert.ok((Date.parse(b) - Date.parse(a)) / 86400000 < maxDays, `${id} ${a}..${b}`);
  }
  // An explicit sync window wins.
  assert.deepEqual(rollingWindow(def('treasury_rates'), { from: '2016-01-01', to: '2016-03-31' }, now), {
    from: '2016-01-01',
    to: '2016-03-31',
  });
});

test('common stock only: warrants, units, rights and preferreds are left out of the universe', () => {
  for (const s of ['AAPL', 'BRK-B', 'BF.B', 'GOOGL', 'FOXA', 'SNOW', 'A', 'MSTR'])
    assert.ok(isCommonStockSymbol(s), s);
  for (const s of [
    'BFRIW',
    'CCXIU',
    'LTRYW',
    'ALDFU',
    'CFR-PB',
    'LXP-PC',
    'AHT-PI',
    'ACHR-WS',
    'XYZ.U',
    'ABCD-RT',
  ])
    assert.equal(isCommonStockSymbol(s), false, s);
  for (const s of ['005110.KS', '0HMG.L', '472230.KQ']) assert.equal(isCommonStockSymbol(s), false, s);
  assert.equal(UNIVERSE_MIN_MARKET_CAP, 300_000_000, "matches universe_daily's min_market_cap");
});

test('historical market cap is a time series with a date range (reported caps back to 2016)', () => {
  const d = def('historical_market_cap');
  assert.equal(d.incremental, 'timeseries');
  const p = perSymbolParams(d, { from: '2016-01-01' }, 'AAPL', '2026-11-14');
  assert.deepEqual(p, { limit: 5000, symbol: 'AAPL', from: '2016-01-01', to: '2026-11-14' });
  const plan = planBackfill(d, '2016-01-01', '2026-11-14', ['AAPL', 'MSFT'], 25);
  assert.equal(plan.mode, 'symbols');
});

test('backfills: treasury, sectors and macro in windows sized per dataset; feeds via per-symbol history', () => {
  const t = planBackfill(def('treasury_rates'), '2016-01-01', '2026-11-14');
  assert.equal(t.mode, 'windows');
  assert.ok(t.batches.length > 60, 'two-month windows over ten years');
  const s = planBackfill(def('sector_performance'), '2016-01-01', '2026-11-14');
  assert.equal(s.mode, 'windows');
  assert.equal(s.batches.length, 3, 'four-year windows, each one call per sector');
  const e = planBackfill(def('economic_indicators'), '2016-01-01', '2026-11-14');
  assert.equal(e.batches.length, 11);
  for (const id of [
    'treasury_rates',
    'sector_performance',
    'economic_indicators',
    'economic_cpi',
    'historical_market_cap',
    'key_metrics_quarterly',
    'ratios_quarterly',
    'earnings_history',
    'analyst_grades_history',
    'grades_consensus_history',
    'insider_trades_history',
    'senate_trades_history',
    'house_trades_history',
  ])
    assert.equal(backfillUnsupported(def(id)), undefined, id);
  assert.equal(def('insider_trades_history').defaultCollection, 'insider_trades');
  assert.deepEqual(
    def('insider_trades_history').keyFields,
    def('insider_trades').keyFields,
    'same key as the feed',
  );
});

test('every dataset is well formed; index presets read the constituents', () => {
  const ids = new Set<string>();
  for (const d of DATASET_CATALOG) {
    assert.ok(!ids.has(d.id), `duplicate id ${d.id}`);
    ids.add(d.id);
    assert.ok(d.keyFields.length, d.id);
    if (d.incremental === 'window') assert.ok(d.supportsDateRange, `${d.id}: windows need from/to`);
    if (d.replaceStale) assert.equal(d.incremental, 'snapshot', d.id);
    assert.match(defaultPriority(d.id), /^P[012]$/);
  }
  assert.equal(defaultPriority('historical_market_cap'), 'P0');
  assert.equal(defaultPriority('insider_trades_history'), 'P2');
  for (const id of ['sp500', 'ndx', 'dji']) assert.equal(presetById.get(id)?.index, id);
  assert.doesNotMatch(presetById.get('sp500_like')!.description, /plan upgrade/);
});
