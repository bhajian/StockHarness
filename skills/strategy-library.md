---
name: strategy-library
description: The StockHarness strategy library. 42 strategy cards, each with how it works, the exact signal, the real collections and fields it uses, default parameters, what to explore, point-in-time traps and whether it can be backtested today. Use when proposing a theory (Theorist), turning a theory into a plugin (Coder), or checking a theory for testability and novelty (Judge).
---

# StockHarness Strategy Library

This skill is the shared map of strategy ideas for the StockHarness research agents.

- **Theorist:** pick a card, then combine, condition or refine it into a _new, testable_ theory. Never resubmit a card unchanged. Check `search_theories` first.
- **Coder:** use the card's **Signal** and **Data** sections to write the plugin, using the field names exactly as listed.
- **Judge:** use **Status** and **Point-in-time traps** to decide testability and lookahead risk.

Every field name below is real. It exists in the StockHarness workspace today, or it is marked _(planned)_ with the collection that will provide it. Layer 2 tables that exist today: `securities`, `trading_calendar`, `corporate_actions`, `prices_daily`, `macro_daily`, `fundamentals_pit`, `universe_daily`, `features_daily` and `features_ranked`; call `describe_collection` for their exact fields. **Reading Layer 1 collections directly is normal.** The as_of reader applies each dataset's known-at rule (Part 1, rule 3); use a Layer 2 collection only when one exists and adds something (e.g. `security_id` joins, adjusted prices, restatement versions).

---

## Part 1. Rules that apply to every strategy

1. **Read only through `ctx.read_df` (plugins) or `query_collection` (exploration).** Both filter by `as_of` on the server. Never try to work around them.
2. **Join on `security_id`, never on the ticker.** Layer 1 rows carry `symbol`. Map them with `securities.identifiers` (type `ticker`, using `valid_from`/`valid_to`), or use Layer 2 collections that already have `security_id`.
3. **Use the moment the information became known, not the date of the event.**

   | Data                                                                                                             | Known at                                                                                                                                                          |
   | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Daily prices (`prices_daily`)                                                                                    | close of `date` (16:00 ET); trade at the **next** close                                                                                                           |
   | Statements (`income_statement`, `balance_sheet`, `cash_flow`)                                                    | `acceptedDate`. If `acceptedDate[:10] == date` (period end), the value is a placeholder (about 4% of rows): use period end + 45 days (Q1–Q3) or + 90 days (Q4/FY) |
   | Annual metrics without `acceptedDate` (`key_metrics`, `ratios`, `enterprise_values`, `owner_earnings`, segments) | join to the matching `income_statement` row on (`symbol`, `date`) for its `acceptedDate`; otherwise period end + 90 days                                          |
   | Earnings (`earnings_calendar`, legacy `earnings_surprises`)                                                      | report `date`; BMO/AMC timing is unknown, so react at the **next session close**                                                                                  |
   | Dividends (`dividends_history`)                                                                                  | `declarationDate` (empty in about 11% of rows: then use the ex-date `date`, which is conservative)                                                                |
   | Splits (`splits_history`, `corporate_actions`)                                                                   | the day before the ex-date (no announcement date)                                                                                                                 |
   | Insider trades (`insider_trades`)                                                                                | `filingDate` (never `transactionDate`)                                                                                                                            |
   | Congress (`congress_senate`, `congress_house`)                                                                   | `disclosureDate` (never `transactionDate`; the lag is often 30–45 days)                                                                                           |
   | Analyst grades and price targets                                                                                 | `publishedDate`                                                                                                                                                   |
   | Weekly snapshots (`analyst_estimates`, `grades_consensus`, `price_target_consensus`, `financial_scores`)         | `snapshot_date`                                                                                                                                                   |

4. **Never use "current-only" fields historically.** These hold today's value only and would leak the future into a backtest:
   - `company_profiles.*` (sector, industry, beta, marketCap, isActivelyTrading),
   - `shares_float.*`, `price_target_summary.*`, `stock_peers.*`, `key_executives.*`, `market_cap.*`,
   - `universe.*` (its `marketCap`),
   - and `financial_scores`, except from its `snapshot_date` onward.
5. **Market cap history:** `historical_market_cap` only starts in July 2026. For backtests compute `mcap = adj_close × weightedAverageShsOutDil`, using the latest `income_statement` known at D.
6. **Recompute valuation with the price on D.** FMP's `ratios` and `key_metrics` valuation fields (`priceToEarningsRatio`, `earningsYield`, `evToEBITDA`, …) use the price at period end. Use their accounting inputs, but rebuild the ratios with `adj_close` on D.
7. **Universe:** the evaluator's default universe is `universe_daily.in_universe` on D (`ctx.universe_ids`). For a narrower universe, include a name on D if:
   - it has a `prices_daily` row on D,
   - `adj_close ≥ 5`,
   - its 20-day mean `dollar_volume ≥ $5M`,
   - and its computed `mcap ≥ $2B` (or whatever the theory states).

   Delisted names are included up to their last bar. Delisted coverage is limited to about 100 names, so state the survivorship caveat.

8. **Sectors:** `securities.sector_history` currently holds a _backfilled current_ sector (see H5). Sector-relative results are an approximation; say so.
9. **Units:** `prices_daily.ret_1d` and `tr_1d` are decimals. Layer 1 fields such as `changePercent`, `changesPercentage`, `sector_performance.averageChange` and `dividends_*.yield` are in **percent points**. Treasury yields (`ust_10y`, `year10`) are in percent.
10. **Costs are applied by the evaluator.** Never net them out yourself. Avoid signals that need a turnover above about 20× a year unless the theory is about short-term effects.

### Status labels

- **Backtestable now:** at least 5 years of point-in-time history exists today.
- **After M1 backfill:** the logic is ready, but history is too short until the Layer 1 backfill (10y prices, 40q statements, earnings history) completes.
- **Forward-only:** FMP keeps no history (snapshot or feed data that started in Oct 2026). It skips backtesting and is paper-tracked live (Layer 5). The Judge must tag it `forward_only`.
- **Blocked:** it needs data the current plan doesn't provide.

### What history exists today (Nov 2026)

| Data                                                                                     | History                                      |
| ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| `prices_daily`, `eod_prices`, `eod_index`, `macro_daily`, `features_*`, `universe_daily` | 2016-01-04 onward (10 years)                 |
| `income_statement`, `balance_sheet`, `cash_flow` (quarterly), `fundamentals_pit`         | about 40 quarters per symbol                 |
| `key_metrics`, `ratios`, `enterprise_values` (annual, FY)                                | about 10 fiscal years                        |
| `dividends_history`                                                                      | back to 1977                                 |
| `splits_history`, `corporate_actions`                                                    | full history                                 |
| `earnings_surprises` (legacy)                                                            | long history of `epsActual` / `epsEstimated` |
| `earnings_calendar`                                                                      | about one year (the plan's limit)            |
| `analyst_estimates`, `grades_consensus`, `price_target_consensus`, `financial_scores`    | weekly since 2026-10-23                      |
| `insider_trades`, `congress_*`, `analyst_grades`, `price_target_changes`, `news_stocks`  | since 2026-10-22                             |

---

## Part 2. Plugin template

```python
META = {"side": "long", "horizon_days": 40, "rebalance": "weekly", "top_n": 30}

def universe(ctx):
    # Optional: the default is universe_daily.in_universe on ctx.date (ctx.universe_ids). A narrower one:
    px = ctx.read_df("prices_daily", {"date": {"$gte": ctx.days_ago(30)}},
                     columns=["security_id", "date", "adj_close", "dollar_volume"])
    last = px[px.date == px.date.max()]
    adv = px.groupby("security_id").dollar_volume.mean()
    ok = last[(last.adj_close >= 5) & last.security_id.map(adv).ge(5e6)]
    return ok.security_id.tolist()

def signal(ctx):
    # Return {security_id: score}; higher = more bullish. Only names to hold need a score.
    ...
```

- `ctx.date` is the rebalance date. `ctx.days_ago(n)` gives calendar days back, and `ctx.trading_days_ago(n)` trading days back.
- Return scores, not weights. The evaluator builds the portfolio from `META` (`top_n`, `side`).
- For long/short, return positive and negative scores, and set `side: "long_short"`.
- Keep `signal` deterministic. No randomness, no network, no file IO.

---

## Part 3. Strategy cards

Card IDs S01–S42 match the strategy-ideas table in `PRODUCT.md` §7.

### Momentum and trend

#### S01 · 12-1 momentum

- **How it works:** investors under-react to news, so prices trend over 3–12 months. Skipping the most recent month avoids the short-term reversal.
- **Signal:** `mom_12_1 = adj_close[t−21] / adj_close[t−252] − 1`. Long the top decile; long/short top versus bottom.
- **Data:** `prices_daily.adj_close` (or `tr_1d` compounded) · `features_daily.mom_12_1` (and `features_ranked.mom_12_1_pct`).
- **Defaults:** monthly rebalance, horizon 21–63 days, `top_n` 30–50, equal weight.
- **Explore:** a 6-1 lookback, industry-neutral ranking, volatility scaling, excluding names within 5 days of earnings.
- **Traps:** momentum crashes after sharp market rebounds (2009, Nov 2020, 2022). Report the drawdown, don't hide it. Needs 252 bars before the first signal.
- **Status:** backtestable now (from 2022); 10y after M1.

#### S02 · 52-week-high proximity

- **How it works:** investors anchor on the 52-week high and under-react to good news near it.
- **Signal:** `pct_from_52w_high = adj_close[t] / max(adj_high[t−251..t]) − 1`. Long the names closest to 0 (e.g. above −5%).
- **Data:** `prices_daily.adj_close`, `adj_high` · `features_daily.dist_52w_high`.
- **Defaults:** weekly rebalance, horizon 63–126 days, `top_n` 30.
- **Explore:** combine with S13 quality, require volume confirmation (`dollar_volume` above its 50-day mean), exclude 52-week-high breakouts on earnings day.
- **Traps:** use adjusted highs, because raw highs break across splits.
- **Status:** backtestable now.

#### S03 · Industry momentum

- **How it works:** industry-wide news diffuses slowly, so the strongest industries keep leading.
- **Signal:** the equal-weighted 6-month return per industry; long the stocks of the top 3 industries and short the bottom 3.
- **Data:** `prices_daily.tr_1d` and `securities.industry_history` (backfilled current industry, H5 caveat) · _(planned)_ `features_daily.industry_mom_6m`.
- **Defaults:** monthly rebalance, horizon 21–63 days, at least 5 names per industry.
- **Explore:** sector rather than industry level (`sector_history`), 3-month and 12-month lookbacks, value-weighting.
- **Traps:** industry labels are current, not point-in-time. A name that changed industry is misplaced historically. Note it as a caveat.
- **Status:** backtestable now (with the caveat).

#### S04 · Residual momentum

- **How it works:** momentum measured after removing market and sector moves is more persistent and crashes less.
- **Signal:** regress 36 months of monthly returns on SPX (`macro_daily.spx_ret_1d` compounded) plus the sector average. The score is the sum of residuals over months t−12..t−2, divided by the residual standard deviation.
- **Data:** `prices_daily.tr_1d`, `macro_daily.spx_ret_1d`, `securities.sector_history`.
- **Defaults:** monthly rebalance, horizon 21–63 days, long/short deciles.
- **Explore:** a 24-month regression window, daily residuals, combining with S01.
- **Traps:** needs at least 36 months of history before the first signal, so it's short until the M1 backfill.
- **Status:** after M1 backfill (needs ≥ 3y of warm-up).

#### S05 · Trend filter

- **How it works:** absolute trend following. Hold only names in an uptrend, and reduce exposure when the market is below trend.
- **Signal:** long if `adj_close > SMA200(adj_close)`. Gross exposure is 100% when `macro_daily.spx_close > SMA200(spx_close)`, else 50%. The score is `adj_close / SMA200 − 1`.
- **Data:** `prices_daily.adj_close`, `macro_daily.spx_close` · _(planned)_ `features_daily.above_sma200`, `regime_daily.trend_regime`.
- **Defaults:** weekly rebalance, horizon 5 days (rolling), `top_n` 30–50.
- **Explore:** a 100-day or 150-day average, a market filter on breadth (% of names above their 50-day) instead of SPX.
- **Traps:** whipsaws in flat markets. Report turnover.
- **Status:** backtestable now.

### Reversal

#### S06 · Short-term reversal

- **How it works:** liquidity-driven overreactions in liquid large caps partly reverse within 1–2 weeks.
- **Signal:** `ret_1w = adj_close[t]/adj_close[t−5] − 1`. Long the worst decile among names with `mcap ≥ $10B`. Exclude names with an earnings report or `news_stocks` item in the window, because news-driven moves don't revert.
- **Data:** `prices_daily.adj_close`, `dollar_volume`; `earnings_calendar.date` (or legacy `earnings_surprises.date`) for the exclusion.
- **Defaults:** weekly rebalance, horizon 5–10 days, `top_n` 20–30.
- **Explore:** a 1-month reversal, scaling by volatility, excluding the bottom 1% (likely distress).
- **Traps:** this is a high-turnover strategy, so costs dominate. The evaluator's cost model decides whether it survives. The news exclusion is forward-only before Oct 2026.
- **Status:** backtestable now (without the news filter).

#### S07 · Long-term reversal

- **How it works:** 3–5 year losers are oversold relative to fundamentals and partly mean-revert.
- **Signal:** `ret_36_12 = adj_close[t−252]/adj_close[t−1008] − 1`. Long the bottom decile, excluding names with `altman_z < 1.8` (see S16).
- **Data:** `prices_daily.adj_close`; statements for the distress screen.
- **Defaults:** annual rebalance, horizon 252 days.
- **Explore:** combine with S10 value, use a 5-year lookback.
- **Traps:** needs at least 4 years of warm-up plus the test window, so 10 years of prices are required.
- **Status:** after M1 backfill.

### Low risk

#### S08 · Low volatility

- **How it works:** investors overpay for "lottery" stocks, so low-volatility names deliver similar returns with less risk.
- **Signal:** `vol_60d = std(tr_1d over 60 days) × √252`. Long the lowest-volatility quintile.
- **Data:** `prices_daily.tr_1d` · `features_daily.vol_63d` (and `vol_21d`).
- **Defaults:** monthly rebalance, horizon 21–63 days, `top_n` 50.
- **Explore:** 252-day volatility, sector-neutral ranking, combining with quality.
- **Traps:** a big tilt toward utilities and staples, and sensitivity to rates. The Judge should check sector concentration and correlation with `ust_10y`.
- **Status:** backtestable now.

#### S09 · Betting against beta

- **How it works:** leverage-constrained investors bid up high-beta names, so low beta wins on a risk-adjusted basis.
- **Signal:** `beta_252d = cov(tr_1d, spx_ret_1d) / var(spx_ret_1d)` over 252 days. Long the low-beta quintile and short the high-beta quintile, each scaled to beta 1.
- **Data:** `prices_daily.tr_1d`, `macro_daily.spx_ret_1d` · _(planned)_ `features_daily.beta_252d`.
- **Defaults:** monthly rebalance, horizon 21 days.
- **Explore:** shrink beta toward 1 (Vasicek), use weekly returns.
- **Traps:** never use `company_profiles.beta`, which is current-only. The short leg needs borrow data (M8.05); until then test it long-only.
- **Status:** backtestable now (long-only, or long/short with the caveat).

### Value

#### S10 · Earnings yield

- **How it works:** cheap stocks relative to earnings outperform over time, as compensation for risk or because of mispricing.
- **Signal:** `earnings_yield = TTM netIncome / mcap`, where TTM is the sum of the last 4 quarterly `income_statement.netIncome` values known at D, and `mcap = adj_close × weightedAverageShsOutDil`. Rank within sector; long the top quintile, excluding negative earnings.
- **Data:** `income_statement.netIncome`, `weightedAverageShsOutDil`, `acceptedDate`; `prices_daily.adj_close` · `fundamentals_pit` (point-in-time statements by `security_id`), `features_daily.earnings_yield`.
- **Defaults:** monthly rebalance, horizon 126–252 days.
- **Explore:** use annual `key_metrics` for a longer history today (its `netIncomePerShare` and similar, lagged), normalized earnings (a 3-year average), excluding financials.
- **Traps:** use `acceptedDate` and the lag rule. Convert to USD when `reportedCurrency ≠ USD`. Only 8 quarters today means TTM history is about 1 year; use the annual path or wait for M1.
- **Status:** after M1 backfill (quarterly); backtestable now on annual data with a 90-day lag.

#### S11 · Free-cash-flow yield

- **How it works:** cash earnings are harder to manipulate than accounting earnings, and high FCF yield predicts returns.
- **Signal:** `fcf_yield = TTM cash_flow.freeCashFlow / EV`, where `EV = mcap + balance_sheet.totalDebt − balance_sheet.cashAndCashEquivalents`. Long the top quintile with FCF above 0 for 4 of 4 quarters.
- **Data:** `cash_flow.freeCashFlow` (or `operatingCashFlow + capitalExpenditure`, since capex is negative), `balance_sheet.totalDebt`, `cashAndCashEquivalents`, `acceptedDate`; `prices_daily.adj_close`; `income_statement.weightedAverageShsOutDil`.
- **Defaults:** monthly rebalance, horizon 126–252 days.
- **Explore:** subtract `stockBasedCompensation` from FCF (a stricter version), check FCF stability with the standard deviation over 8 quarters.
- **Traps:** don't use `enterprise_values.enterpriseValue`, which is annual and priced at period end. Recompute EV on D.
- **Status:** after M1 backfill.

#### S12 · Sector-relative EV/EBITDA

- **How it works:** a value measure that ignores capital structure. The cheapest names within each sector beat the most expensive.
- **Signal:** `ev_ebitda = EV / TTM income_statement.ebitda` (positive EBITDA only). Rank within sector (`securities.sector_history`); long the cheapest third and short the most expensive third.
- **Data:** `income_statement.ebitda`, `balance_sheet.totalDebt`, `cashAndCashEquivalents`, `prices_daily.adj_close`.
- **Defaults:** monthly rebalance, horizon 126 days, at least 8 names per sector.
- **Explore:** EV/sales for unprofitable sectors, a combination with S13 to avoid value traps.
- **Traps:** exclude Financial Services, where EBITDA isn't meaningful. The sector caveat (H5) applies.
- **Status:** after M1 backfill.

### Quality and investment

#### S13 · Gross profitability

- **How it works:** gross profit relative to assets is a clean measure of economic productivity and predicts returns as strongly as value does.
- **Signal:** `gp_assets = TTM income_statement.grossProfit / balance_sheet.totalAssets` (latest known). Long the top quintile.
- **Data:** `income_statement.grossProfit`, `balance_sheet.totalAssets`, `acceptedDate` · `features_daily.gross_margin` (gross profit / revenue; gross profit / assets is built from `fundamentals_pit`).
- **Defaults:** monthly rebalance, horizon 252 days.
- **Explore:** combine with S10 (quality at a reasonable price), use operating profitability (`operatingIncome / totalAssets`).
- **Traps:** banks and insurers report `grossProfit = 0` or something not comparable, so exclude them.
- **Status:** after M1 backfill; backtestable now on annual `ratios.grossProfitMargin` × `ratios.assetTurnover` with a lag.

#### S14 · Piotroski F-score

- **How it works:** nine accounting signals separate improving cheap firms from deteriorating ones.
- **Signal:** **recompute** the F-score at D from statements. Don't use `financial_scores.piotroskiScore` historically, because it's snapshot-only. The nine points:
  - ROA > 0
  - CFO > 0
  - ΔROA > 0
  - CFO > net income
  - Δleverage < 0
  - Δcurrent ratio > 0
  - no new shares issued
  - Δgross margin > 0
  - Δasset turnover > 0

  Long F ≥ 8 within the cheapest 30% (S10); short F ≤ 2.

- **Data:**
  - `income_statement`: `netIncome`, `revenue`, `grossProfit`, `weightedAverageShsOut`,
  - `balance_sheet`: `totalAssets`, `longTermDebt`, `totalCurrentAssets`, `totalCurrentLiabilities`,
  - `cash_flow`: `operatingCashFlow`,
  - all compared year over year, known at D.
- **Defaults:** quarterly rebalance, horizon 252 days.
- **Explore:** apply it to S07 losers, or use it as a filter on S21.
- **Traps:** the year-over-year comparisons need 8 quarters per point, so they're short today. `financial_scores` is usable only from 2026-10-23 onward (forward).
- **Status:** after M1 backfill (forward-only if using `financial_scores`).

#### S15 · Low accruals

- **How it works:** earnings made of accruals (not cash) mean-revert, so low-accrual firms outperform.
- **Signal:** `accruals = (TTM netIncome − TTM operatingCashFlow) / average totalAssets`. Long the lowest quintile.
- **Data:** `income_statement.netIncome`, `cash_flow.operatingCashFlow`, `balance_sheet.totalAssets`.
- **Defaults:** quarterly rebalance, horizon 252 days.
- **Explore:** add `stockBasedCompensation` back, use a sector-neutral version.
- **Status:** after M1 backfill.

#### S16 · Distress avoidance (Altman Z)

- **How it works:** distressed firms earn low returns (the "distress anomaly"). Avoiding or shorting them adds return.
- **Signal:** recompute Altman Z at D as `1.2·WC/TA + 1.4·RE/TA + 3.3·EBIT/TA + 0.6·mcap/TL + 1.0·Sales/TA`, with:
  - WC from `totalCurrentAssets − totalCurrentLiabilities`,
  - RE from `retainedEarnings`,
  - EBIT from TTM `ebit`,
  - TL from `totalLiabilities`,
  - Sales from TTM `revenue`.

  Short (or exclude) Z < 1.8.

- **Data:** `balance_sheet` and `income_statement` fields as listed; `prices_daily.adj_close` for mcap.
- **Defaults:** monthly rebalance, horizon 126 days; works best as a **filter** for other strategies.
- **Traps:** shorting needs borrow data (M8.05), and distressed names are often hard to borrow. Delisting returns matter here, and survivorship is limited (about 100 delisted names), which understates the effect.
- **Status:** after M1 backfill (best used as a filter).

#### S17 · Asset growth

- **How it works:** firms that expand assets fastest (empire building, acquisitions) subsequently underperform.
- **Signal:** `asset_growth = totalAssets[t] / totalAssets[t−4q] − 1`. Long the lowest quintile, short the highest.
- **Data:** `balance_sheet.totalAssets` (quarterly), or annual `financial_growth.assetGrowth`, joined for `acceptedDate`.
- **Defaults:** annual rebalance (July), horizon 252 days.
- **Status:** after M1 backfill; backtestable now on annual data with a lag.

### Capital actions

#### S18 · Net share buybacks

- **How it works:** managers buy back undervalued shares and issue overvalued ones, so a shrinking share count predicts outperformance.
- **Signal:** `net_issuance = weightedAverageShsOutDil[t] / weightedAverageShsOutDil[t−4q] − 1`. Long the most negative quintile (buybacks), short the most positive.
- **Data:** `income_statement.weightedAverageShsOutDil`; for confirmation, `cash_flow.commonStockRepurchased`, `commonStockIssuance`.
- **Defaults:** quarterly rebalance, horizon 252 days.
- **Explore:** buybacks combined with S11 FCF yield (funded buybacks only).
- **Traps:** splits change share counts. Adjust with `corporate_actions` (`split_ratio`) before comparing.
- **Status:** after M1 backfill.

#### S19 · Dividend initiation or increase

- **How it works:** a dividend initiation or raise signals management's confidence. Prices drift upward afterwards.
- **Signal:** the event is a `dividends_history` row whose `dividend` is above 1.1 × the prior regular dividend of the same `frequency`, or is the first dividend. Enter at the close after the known date (`declarationDate`, or the ex-date `date` if empty).
- **Data:** `dividends_history`: `date`, `declarationDate`, `dividend`, `adjDividend`, `frequency`; `corporate_actions` (`cash_dividend`, `special_dividend`); `prices_daily`.
- **Defaults:** event-driven daily rebalance, horizon 63–126 days, holding every event.
- **Explore:** larger increases, initiations only, a combination with S13 quality, excluding `special_dividend`.
- **Traps:** compare using `adjDividend` (split-adjusted). Treat `frequency = "Irregular"` separately.
- **Status:** backtestable now (dividend history back to 1977; price history is the binding constraint).

#### S20 · Post-split drift

- **How it works:** forward splits follow strong performance and signal confidence, and prices drift up after the ex-date.
- **Signal:** the event is `corporate_actions.action_type == "split"` with `split_ratio > 1`. Enter the close after `ex_date`.
- **Data:** `corporate_actions`: `ex_date`, `split_ratio`, `known_at`; `prices_daily`.
- **Defaults:** event-driven, horizon 63–252 days.
- **Traps:** there's no announcement date, so the effect at announcement can't be captured, only the drift after the ex-date. Exclude reverse splits (`split_ratio < 1`), which are often distress.
- **Status:** backtestable now.

### Growth

#### S21 · Revenue acceleration

- **How it works:** the market extrapolates past growth, so _accelerating_ growth surprises it.
- **Signal:** `rev_growth_yoy = revenue[q] / revenue[q−4] − 1`; `rev_accel = rev_growth_yoy[q] − rev_growth_yoy[q−1]`. Long the top quintile of `rev_accel` with `rev_growth_yoy > 0` and a gross margin that isn't falling.
- **Data:** `income_statement.revenue`, `grossProfit`, `acceptedDate` · `features_daily.revenue_growth_yoy` (`rev_accel` planned).
- **Defaults:** monthly rebalance, horizon 63–252 days.
- **Explore:** require two consecutive accelerating quarters, combine with S24 (a positive surprise on the same report).
- **Traps:** needs 6 quarters to compute two growth rates, so it's short today.
- **Status:** after M1 backfill.

#### S22 · Margin expansion

- **How it works:** a rising gross or operating margin signals pricing power or operating leverage that analysts under-estimate.
- **Signal:** `gm = grossProfit / revenue`; the score is `gm[q] − gm[q−4]`. Long the top quintile with `rev_growth_yoy > 0`.
- **Data:** `income_statement.grossProfit`, `revenue`, `operatingIncome`.
- **Defaults:** monthly rebalance, horizon 126 days.
- **Status:** after M1 backfill.

#### S23 · Segment concentration shift

- **How it works:** when a fast-growing segment becomes a larger share of revenue, the company's growth profile and multiple re-rate.
- **Signal:** from `revenue_product_segmentation.data` (a map of segment to revenue): find the segment with the highest YoY growth. The score is the change in its share of total revenue.
- **Data:** `revenue_product_segmentation`: `symbol`, `date`, `fiscalYear`, `period`, `data{}`; known at the matching `income_statement.acceptedDate`, or period end + 90 days · _(planned)_ `revenue_segments_pit`.
- **Defaults:** quarterly rebalance, horizon 252 days.
- **Traps:** segment names change between filings, so match them fuzzily and only count segments present in both periods. Coverage is partial.
- **Status:** backtestable now on annual (FY) rows with a lag; coverage-limited.

### Earnings

#### S24 · Post-earnings drift (PEAD)

- **How it works:** prices under-react to earnings surprises and keep drifting in the surprise's direction for about 60 days.
- **Signal:** `SUE = (epsActual − epsEstimated) / std(epsActual − epsEstimated over the prior 8 reports)`. Long SUE > 2, short SUE < −2. Enter at the **next session close** after the report `date`.
- **Data:** for backtests, legacy `earnings_surprises` (`symbol`, `date`, `epsActual`, `epsEstimated`; long history) until `earnings_calendar` is backfilled; live, `earnings_calendar` (the same fields plus `revenueActual`, `revenueEstimated`) · _(planned)_ `earnings_events.sue`, `reaction_date`, `announce_timing`.
- **Defaults:** daily event-driven rebalance, horizon 40–60 trading days.
- **Explore:** a revenue surprise as confirmation, profitability or mid-cap filters, excluding the first 2 days.
- **Traps:**
  - Skip rows with a null `epsEstimated`.
  - Timing is unknown (BMO/AMC), so entering at the next close is conservative and required.
  - Don't use `date` itself as the entry day.
  - Exact timing arrives in M8.01.
- **Status:** backtestable now (via `earnings_surprises` plus 5y of prices).

#### S25 · Surprise streaks

- **How it works:** firms that beat repeatedly tend to keep beating, partly by managing guidance, and drift after each beat.
- **Signal:** `sue_streak` = the number of consecutive reports with `epsActual > epsEstimated`. Long names with a streak ≥ 3 after a new beat.
- **Data:** `earnings_surprises` / `earnings_calendar`: `epsActual`, `epsEstimated`, `date`.
- **Defaults:** event-driven, horizon 40 days.
- **Status:** backtestable now.

#### S26 · Pre-earnings run-up

- **How it works:** attention and positioning lift high-attention names into their report dates.
- **Signal:** names with a report date 5–10 trading days ahead whose `dollar_volume` is rising. Exit the day before the report.
- **Data:** `earnings_calendar.date` (scheduled; history needs a backfill or `earnings_surprises.date` as the realized schedule), `prices_daily.dollar_volume`.
- **Defaults:** daily rebalance, horizon 5–10 days.
- **Traps:** a report date is only known in advance if it was scheduled. Using realized dates from `earnings_surprises` assumes the schedule was known about 2 weeks ahead, which is true for most large caps. State this caveat.
- **Status:** backtestable now (with the caveat).

### Estimates and analysts (mostly forward-only)

#### S27 · EPS revision momentum

- **How it works:** analysts revise slowly. Upward consensus revisions predict further revisions and returns.
- **Signal:** `eps_rev_4w = epsAvg[snapshot_date = t] / epsAvg[snapshot_date ≈ t−4w] − 1` for the next fiscal year (the earliest `date` > D). Long the top quintile with `numAnalystsEps ≥ 3`.
- **Data:** `analyst_estimates`: `symbol`, `date` (fiscal year end), `snapshot_date`, `epsAvg`, `revenueAvg`, `numAnalystsEps` · _(planned)_ `estimates_snapshots.eps_rev_4w`.
- **Defaults:** weekly rebalance, horizon 21–63 days.
- **Traps:** snapshots exist only since 2026-10-23, so it's **forward-only**. A proxy can be backtested: the count of net upgrades from history (S30), once grade history exists.
- **Status:** forward-only.

#### S28 · Estimate dispersion

- **How it works:** high analyst disagreement combined with short-sale constraints leads to overpricing and later underperformance.
- **Signal:** `dispersion = (epsHigh − epsLow) / |epsAvg|`. Avoid or short the top quintile.
- **Data:** `analyst_estimates.epsHigh`, `epsLow`, `epsAvg`, `snapshot_date`.
- **Status:** forward-only (best used as a filter).

#### S29 · Price-target upside

- **How it works:** large and _rising_ consensus price-target upside reflects analysts' private information, especially in quality names.
- **Signal:** `pt_upside = targetConsensus / adj_close − 1`; `pt_change_4w` = the change in `targetConsensus` across snapshots. Long a high upside **and** a rising target, filtered by S13.
- **Data:** `price_target_consensus`: `targetConsensus`, `targetHigh`, `targetLow`, `targetMedian`, `snapshot_date`; `prices_daily.adj_close`.
- **Traps:** a high upside alone is a value trap. Require the change to be rising. Don't use `price_target_summary` historically (current-only).
- **Status:** forward-only.

#### S30 · Upgrade drift

- **How it works:** upgrades by influential firms move prices, followed by a drift.
- **Signal:** an `analyst_grades` row with `action == "upgrade"`, or `"initialise"` with a buy-type `newGrade`. Normalize grades to −2…+2 (Strong Sell … Strong Buy), score by the change from `previousGrade` to `newGrade`, and enter at the close after `publishedDate`.
- **Data:** `analyst_grades`: `symbol`, `publishedDate`, `gradingCompany`, `previousGrade`, `newGrade`, `action`, `priceWhenPosted`; also `price_target_changes` (`priceTarget`, `priceWhenPosted`, `analystCompany`) · _(planned)_ `analyst_events`.
- **Defaults:** event-driven, horizon 21–42 days.
- **Traps:** these are feeds holding only the latest items, so history starts 2026-10-22. Backtesting needs a per-symbol historical grades dataset (not yet in the catalog).
- **Status:** forward-only.

### Insiders and Congress (forward-only until feed history builds)

#### S31 · Insider cluster buys

- **How it works:** insiders know their company. Several of them buying on the open market at once is one of the strongest insider signals, especially after a drawdown.
- **Signal:** within 30 days, at least 3 distinct `reportingCik` with `transactionType == "P-Purchase"` and `acquisitionOrDisposition == "A"`. The score is the total `securitiesTransacted × price`. Optionally require `adj_close` to be 20% or more below the 52-week high. Enter at the close after the last `filingDate`.
- **Data:** `insider_trades`: `symbol`, `filingDate`, `transactionDate`, `transactionType`, `acquisitionOrDisposition`, `securitiesTransacted`, `price`, `reportingCik`, `typeOfOwner`, `directOrIndirect`, `securitiesOwned` · _(planned)_ `insider_trades_pit`.
- **Defaults:** event-driven, horizon 63–126 days.
- **Traps:**
  - Only `P-Purchase` is an open-market buy. `A-Award`, `M-Exempt`, `F-InKind`, `G-Gift`, `X-InTheMoney` and `C-Conversion` are not signals.
  - Use `filingDate`, never `transactionDate`.
  - The feed history starts 2026-10-22.
- **Status:** forward-only.

#### S32 · CEO/CFO purchases

- **How it works:** purchases by top executives are the most informative insider trades.
- **Signal:** `P-Purchase` where `typeOfOwner` contains "Chief Executive" or "Chief Financial" (or CEO/CFO), with a value of $100k or more and a holdings increase (`securitiesTransacted / securitiesOwned`) of 10% or more.
- **Data:** `insider_trades` fields as in S31.
- **Defaults:** event-driven, horizon 126 days.
- **Status:** forward-only.

#### S33 · Congressional buys

- **How it works:** members of Congress may trade on policy information. Net purchases have been followed by outperformance, although the disclosure lag reduces it.
- **Signal:** within 60 days of `disclosureDate`, net buys = the count of `type == "Purchase"` minus `type` starting with "Sale". Weight by the midpoint of the `amount` range, e.g. "$15,001 - $50,000" → 32,500.
- **Data:** `congress_senate` and `congress_house`: `symbol`, `disclosureDate`, `transactionDate`, `type`, `amount`, `owner`, `office`, `assetType` (Stock only) · _(planned)_ `congress_trades`.
- **Defaults:** weekly rebalance, horizon 63–126 days.
- **Traps:** use `disclosureDate` only. `symbol` can be an ADR or bond, so check `assetType`. Feed history starts 2026-10-22.
- **Status:** forward-only.

### Ownership and index (blocked)

#### S34 · 13F crowding / new positions

- **How it works:** high-conviction new positions by skilled institutions, and rising institutional ownership, predict returns.
- **Signal:** the change in the number of 13F holders and in shares held, quarter over quarter. Long the top decile of new money from top-performing filers.
- **Data:** _(planned, M8.02)_ `holdings_13f`, `filers_13f`. `known_at` = the 13F filing date (up to 45 days after quarter end).
- **Status:** blocked until M8.02.

#### S35 · Index addition

- **How it works:** names added to the S&P 500 see forced buying, and predicting additions captures part of that.
- **Signal:** rank eligible non-members by market cap, profitability (4 positive quarters of GAAP earnings) and liquidity.
- **Data:** _(planned, M8.04)_ `index_membership`. Constituents return 402 on the current plan.
- **Status:** blocked.

### Size, liquidity, macro and seasonality

#### S36 · Illiquidity premium

- **How it works:** less-liquid stocks pay a premium to compensate holders, and it survives costs only for quality names with moderate turnover.
- **Signal:** `amihud = mean(|tr_1d| / dollar_volume)` over 60 days. Long the high-illiquidity quintile within `mcap ≥ $2B`, filtered by S13.
- **Data:** `prices_daily.tr_1d`, `dollar_volume`.
- **Defaults:** quarterly rebalance, horizon 126–252 days.
- **Traps:** very cost-sensitive, so check the evaluator's cost breakdown. Survivorship is worst in small, illiquid names.
- **Status:** backtestable now.

#### S37 · VIX regime overlay

- **How it works:** high-volatility regimes have worse risk-adjusted equity returns and more crashes, so scaling exposure down improves Sharpe.
- **Signal:** an overlay on another strategy. Gross is 50% when `macro_daily.vix` is above its 1-year 80th percentile, 100% otherwise.
- **Data:** `macro_daily.vix` (from `eod_index` `^VIX`) · _(planned)_ `regime_daily.vol_regime`.
- **Defaults:** daily rebalance (overlay).
- **Traps:** use the VIX close on D and act at the next close. Evaluate it as a modifier: compare the base strategy with and without it.
- **Status:** backtestable now.

#### S38 · Yield-curve regime

- **How it works:** an inverted curve precedes slowdowns, when quality and low-volatility names outperform.
- **Signal:** when `macro_daily.curve_10y_2y < 0` for 20 or more days, tilt toward S13 and S08 names; otherwise use the base mix.
- **Data:** `macro_daily.curve_10y_2y`, `curve_10y_3m`, `ust_10y` (from `treasury_rates.year10`, `year2`, `month3`).
- **Defaults:** monthly rebalance (overlay).
- **Status:** backtestable now (few regime changes in 5 years, so the evidence is thin; say so).

#### S39 · Rate-sensitive sector rotation

- **How it works:** sectors respond differently to rate moves. Rising yields favor financials and energy; falling yields favor utilities, real estate and tech.
- **Signal:** `Δust_10y` over 63 days. Rank sectors by their historical beta to rate changes (estimated over the previous 2 years) and overweight the sectors that benefit.
- **Data:** `macro_daily.ust_10y`, `sector_returns` (percent points); `prices_daily` with `securities.sector_history`.
- **Defaults:** monthly rebalance, horizon 21–63 days.
- **Traps:** `sector_returns` values are in percent points, so divide by 100.
- **Status:** backtestable now (short history).

#### S40 · Turn-of-month / January effect

- **How it works:** flows (pay cycles, fund rebalancing) concentrate returns around month turns. Small caps rebound in January after tax-loss selling.
- **Signal:** be long from the last trading day of the month to the 3rd trading day of the next (`trading_calendar`). In January, overweight the small-cap prior-year losers.
- **Data:** `trading_calendar`: `date`, `is_trading_day`, `prev_trading_day`, `next_trading_day`; `prices_daily`.
- **Defaults:** calendar-driven.
- **Traps:** few events, so be wary of overfitting. The Judge should demand stability across years.
- **Status:** backtestable now.

### Combinations and news

#### S41 · Quality + value + momentum composite

- **How it works:** the factors have low correlation with each other. A composite gives steadier excess returns than any one alone.
- **Signal:** the average of cross-sectional percentile ranks of `value_score` (S10/S11), `quality_score` (S13/S15) and `momentum_score` (S01). Long the top quintile.
- **Data:** `features_ranked.value_score`, `quality_score`, `momentum_score`, `growth_score`, `low_vol_score`, `composite_pct` and the sector-relative `*_sector_pct`.
- **Defaults:** monthly rebalance, horizon 63 days.
- **Explore:** the component weights (from walk-forward folds only, never from the full sample), sector neutrality.
- **Traps:** each weighting variant counts as a trial for deflated Sharpe. Keep variants few.
- **Status:** after M1 backfill (fundamental components).

#### S42 · Abnormal news volume

- **How it works:** a spike in news without a matching price move signals information the market hasn't priced yet.
- **Signal:** `news_count_1d` per `symbol` from `news_stocks` (by `publishedDate`), compared with its 20-day mean. Long or short in the direction of the subsequent first-day move, or use it as an attention filter.
- **Data:** `news_stocks`: `symbol`, `publishedDate`, `title`, `publisher`, `site`.
- **Traps:** the feed only has history since 2026-10-23. Crypto and other non-equity `symbol` values appear in the feed (e.g. "XRP"), so keep only symbols in `securities`.
- **Status:** forward-only.

---

## Part 4. How to make a new theory from a card

A good theory changes **one or two** things relative to a card, and says why:

- **Condition** it on another card: "S31 insider cluster buys _after_ a 20% drawdown" (S31 × S02 inverted).
- **Restrict the universe** with a reason: "S24 PEAD in mid caps ($2B–$20B), where analyst coverage is thinner".
- **Combine** with a filter that removes a known failure mode: "S10 earnings yield excluding F-score ≤ 3 (value traps)".
- **Change the horizon or entry rule** with a reason: "S19 entering at declaration instead of ex-date".

Every theory record must state:

- its hypothesis and economic rationale,
- the card(s) it builds on,
- the data (collections and fields),
- the universe, horizon, side and rebalance,
- what would falsify it,
- how it differs from the most similar existing theory, from `search_theories`.

### Anti-patterns (the Judge rejects these)

- Tuning thresholds on the full sample. Choose them inside walk-forward folds, or state a prior.
- Using a current-only field (Part 1, rule 4) or the event date instead of the known date (rule 3).
- Stacking more than 3 filters without a separate rationale for each, which is p-hacking.
- Submitting a backtest for a **forward-only** card. Tag it `forward_only` instead.
- Re-testing a failed theory with cosmetic changes (cosine similarity ≥ 0.9 with no stated difference).
