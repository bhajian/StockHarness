# 2026-11-14/15: FMP Premium rollout, data quality and MongoDB (epic #389)

The FMP plan moved from Starter to **Premium** on 2026-11-14. The owner asked for everything Premium adds to be
downloaded, with at least 10 years of history, scheduled, used by Layer 2, and for Health to be clean and stay
clean. US only (NASDAQ, NYSE, AMEX).

## What changed (PRs)

| Area                                                                                          | Issue → PR                               |
| --------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Health: stale false positives, DQ issues that never reconciled, simulation outputs as Layer 4 | #386 → #390                              |
| Premium datasets, 10+ years, survivorship-free universe, 600 calls/min                        | #387 → #392                              |
| Layer 2: macro history, point-in-time index membership, index flags in `universe_daily`       | #388 → #391                              |
| Equity-only instrument classifier, sticky universe, US-only delisted list                     | #393 → #397                              |
| Concurrent backfills; routine syncs skip names delisted long ago                              | #398 → #399                              |
| MongoDB memory (4 GiB)                                                                        | #403 → #404                              |
| Every catalog field documented                                                                | #394 → #400                              |
| Gaps for every daily series; coverage measured against the names a dataset serves             | #395 → #405                              |
| Layer 2 outputs keyed by date are daily series                                                | #409 → #410                              |
| MongoDB on a dedicated r7i.xlarge node, 18 GB cache, gp3 6,000 IOPS                           | #415 → #417                              |
| Interrupted sync runs resume where they stopped                                               | #416 → #421                              |
| Sync rate 700/min                                                                             | #425 → #426                              |
| DQ counts show the research-relevant part                                                     | #428 → #429                              |
| Listed and delisted coverage shown separately                                                 | #431 → #432                              |
| Treasury gaps skip bond-market holidays                                                       | #434 → #435                              |
| Funds/ETFs by name and ticker are not stock; trading sessions only in `prices_daily`          | #437 → #438                              |
| A claimed but not started sync is re-queued after a restart                                   | #439 → #440                              |
| UI: Datasets table, sortable and paged tables, Map cards, per-Theorist models, Rows totals    | #384, #385, #366, #414, #412, #413, #420 |

## What the plan serves

See [data-coverage.md](../data-coverage.md). In short: 10+ years of prices, reported market caps, the treasury
curve, sector performance and 14 macro series; 48 quarters of statements and quarterly metrics; index members and
every change (S&P 500 since 1957); per-symbol earnings, grade, insider, congress and price-target history; every
page of the delisted list. **Limits:** FMP's delisted list starts in late 2020 (deaths in 2016–2020 are missing, so
the 2016 S&P 500 resolves 447 of 503 members). Estimate, price-target and grade **consensus** snapshots and news
have no history (forward-only).

## State after the rollout (2026-11-15 13:00 UTC)

- **Universe:** 7,089 US names (3,352 listed above $300M plus 3,737 delisted). **Securities:** 6,591 common stocks,
  315 ADRs, 610 non-stock instruments typed and kept out of the universes.
- **Layer 1:** 28 backfills, 187,102 FMP calls, 37.0M rows, 0 failed batches. Coverage of listed names: prices and
  market caps 100%, statements and quarterly metrics 98.8% (the rest are fresh IPOs and SPACs), profiles and float
  100%.
- **Layer 2:** `prices_daily`, `universe_daily` and `features_daily` 11.9M rows each, 0 duplicate keys; 2,200–3,200
  research-universe members per day; S&P 500 flags 447 (2016) → 500 (2023+); `macro_daily` has no null yields since 2016.
- **Health:** 69 fresh, 0 stale, 0 failed, 0 drift alerts, 0 gaps, 0 DQ errors on research rows (288,975 open flags,
  11,028 of them on research rows, all warnings). 1,223 catalog fields documented.
- **MongoDB:** dedicated r7i.xlarge (4 vCPU, 32 GiB), 19.3 GB cache, 200 GiB gp3 at 6,000 IOPS. The move kept every
  document: 129 collections, 25,765,380 documents before and after. Snapshots: `snap-0779247e415824607`,
  `snap-0b7e68bc68417cb1f`.

## How it was run

1. Live probe of every endpoint with the workspace's key (one call each), then the code changes above.
2. `deploy/config-io/exports/dataset-syncs.yaml` imported in merge mode (dry run first): 15 new syncs.
3. Backfills queued per dataset (`createBackfill`, `historyPeriods` 48 for statements), running below scheduled
   syncs; the dispatcher resumes them after a restart.
4. Layer 2 rebuilt in order, one step at a time (securities, corporate actions, prices from 2016, fundamentals,
   index membership, universe from 2016-01-04, features, ranked features, macro), then again after #437.
5. One-time cleanups, each backed up first: the DQ log (dedupe and reconcile, `scripts/dq-reconcile.ts`), foreign
   rows of `delisted_companies`, the leftover `market_cap` / `debug_trace` collections, and 386 rows on non-trading
   days. `scripts/duplicate-audit.ts` checks every synced collection for duplicate keys (0 found).

## Follow-ups

- #401 (backlog): simulations on Parquet exports (S15-26 hit its 4 GiB job limit).
- #402: UI polish of dialogs, tables and tab bars.
- Pre-2020 deaths: another source of delisted US companies (SEC or exchange lists) would close the remaining
  survivorship gap.
