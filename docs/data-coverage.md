# Data coverage on the FMP Premium plan

What the platform can get, probed live on 2026-11-14 after the upgrade from Starter to **Premium** (750 calls
per minute, #387). The earlier Starter probe is #291 / #300. Dataset syncs use 600 calls per minute
(`DATASET_SYNC_RPM`) and leave the rest for agents' FMP tools.

## Available

| Data                                                              | Depth and notes                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Daily prices, US common stock (NASDAQ, NYSE, AMEX)                | From 2016 (FMP serves about 20 years, 5,000 bars per call); delisted names included                                |
| Index levels (`^GSPC`, `^VIX`, `^DJI`, `^IXIC`, `^RUT`)           | From 2016 → benchmark and regimes (`macro_daily`)                                                                  |
| Treasury par yield curve                                          | From 2016, backfilled in two-month windows (FMP serves three months per call)                                      |
| Sector performance (daily average change per sector)              | From 2016, one call per sector (`historical-sector-performance`, the NASDAQ series)                                |
| US macro indicators (`economic_indicators`)                       | 14 series (GDP, CPI, inflation, unemployment, payrolls, claims, fed funds, retail sales, …), one call per year     |
| Quarterly income statement, balance sheet, cash flow, growth      | Back to the 1980s for large caps; synced 48 quarters deep → `fundamentals_pit`                                     |
| Key metrics and ratios, **quarterly and annual**                  | Quarterly back to 1996 for large caps (`key_metrics_quarterly`, `ratios_quarterly`)                                |
| Reported market cap per day (`historical_market_cap`)             | From 2016 in one call per symbol → `universe_daily` uses reported caps instead of close × shares                   |
| Index constituents and their history (S&P 500, Nasdaq-100, Dow)   | Current members, plus every change: S&P 500 since 1957, Nasdaq-100 since 1985, Dow since 1994 (`index_membership`) |
| Earnings history per symbol (EPS and revenue, actual vs estimate) | Back to the 1980s (`earnings_surprises`)                                                                           |
| Analyst grade changes per symbol, monthly grade consensus         | Grade changes since about 2012 (`analyst_grades_history`); monthly buy/hold/sell counts since 2018                 |
| Insider trades per symbol                                         | About ten years, paged 1,000 per call, into `insider_trades` with the daily feed                                   |
| Senate and House trades per symbol                                | Since about 2016, into `congress_senate` / `congress_house` with the daily feeds                                   |
| Analyst price targets per symbol                                  | The latest 100 per symbol (one to two years), into `price_target_changes`                                          |
| Delisted companies                                                | Every page (about 17,000 names, delisted since late 2020), filtered to NASDAQ/NYSE/AMEX common stock               |
| Stock list, symbol changes                                        | Every FMP symbol; ticker changes since 2004                                                                        |
| Dividends and splits per symbol                                   | Full history → `corporate_actions`                                                                                 |
| Feeds: news, insider, congress, grades, price targets, movers     | Paged until a page brings nothing new (no page cap on Premium)                                                     |

## Still limited

| Limit                                                                 | What the platform does                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| FMP's delisted list starts in late 2020                               | Companies that died in 2016–2020 are missing: backtests over those years still lean toward survivors (caveat)     |
| Calendars (earnings, dividends, splits) refuse an old `from`          | Kept as a rolling window; history comes from the per-symbol syncs                                                 |
| No history of estimate, price-target or grade **consensus** snapshots | `analyst_estimates*`, `price_target_consensus`, `grades_consensus`, `financial_scores` stay forward-only (caveat) |
| News has no per-symbol history sync                                   | `news_stocks` is forward-only from when the sync started                                                          |
| 13F institutional ownership (`institutional-ownership/*`)             | Not in Premium (Restricted Endpoint)                                                                              |
| Treasury yields as index symbols (`^TNX`)                             | Not served; `treasury_rates` covers the curve                                                                     |

## Not synced on purpose

Intraday bars, technical indicators (derived from our own daily prices instead), the custom DCF calculator, and UK
and Canada listings (other currencies and exchange calendars; the research universe is US common stock).

A 402 whose message names a plan limit is an `FmpPlanLimit`: final, never retried. A sync that hits plan limits
three times in a row pauses its schedule and says why.
