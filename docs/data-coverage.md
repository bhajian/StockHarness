# Data coverage on the current FMP plan

What the platform can get today, probed live on 2026-11-06 (#291, #300). The research scope is the S&P 500
level: prove the platform end to end there before widening the data.

## Available

| Data                                                     | Notes                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Daily prices, US common stocks (NASDAQ, NYSE, AMEX)      | 2016 onwards; delisted names included (survivorship-free universe)                         |
| Index levels (`^GSPC`, VIX) and treasury rates           | The benchmark and macro regimes (`macro_daily`)                                            |
| Quarterly income statement, balance sheet, cash flow     | ~10 years per symbol → `fundamentals_pit`                                                  |
| Annual key metrics, ratios, growth, scores               | Annual only (the plan refuses quarterly key metrics)                                       |
| Analyst estimates (annual), price-target summary, grades | Snapshots; history for estimates back to about 2022 (theories using them are forward-only) |
| Earnings history per symbol (EPS actual vs estimate)     | ~40 quarters; not synced yet (#304)                                                        |
| Dividends and splits history per symbol                  | → `corporate_actions`                                                                      |
| Insider trades, congress trades, news, movers            | Feeds                                                                                      |

## Limits of the plan

| Limit                                                             | What the platform does                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| No S&P 500 / Nasdaq / Dow constituents (current or past)          | The **S&P 500 proxy**: the 500 largest names by market cap on each date (`universe.top_by_market_cap: 500`), point in time, from `universe_daily` |
| News feeds serve `page=0` only                                    | The feed syncs keep page 0 and record the limit (#291)                                                                                            |
| Calendars (earnings, dividends, splits) serve the last ~12 months | Kept as a rolling year; history comes from the per-symbol syncs                                                                                   |
| Non-US listings (LSE, TSX, OTC …)                                 | Left out of the universe                                                                                                                          |
| Delisted-companies list: page 0 only                              | The universe takes what the plan returns                                                                                                          |

A 402 whose message names one of these limits is an `FmpPlanLimit`: final, never retried. A sync that hits plan
limits three times in a row pauses its schedule and says why.
