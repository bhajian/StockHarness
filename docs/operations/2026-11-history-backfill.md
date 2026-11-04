# History backfill, November 2026 (M1.16, #88)

On 2026-11-04 the 14 disabled syncs were re-enabled and the ten-year history backfill (#80) was run on the live
workspace (requested by `backfill-M1.16`). It ran through two app restarts and resumed each time (#80 resume).

## Result

| Sync                              | Range                  | Batches | Failed | FMP calls | Rows      |
| --------------------------------- | ---------------------- | ------- | ------ | --------- | --------- |
| EOD prices (5y, universe)         | 2016-01-01..2026-11-04 | 90      | 0      | 2,230     | 5,020,016 |
| L1 — Index & VIX levels           | 2016-01-01..2026-11-04 | 1       | 0      | 4         | 10,927    |
| L1 — Income statement (quarterly) | 40 quarters            | 90      | 0      | 2,230     | 78,235    |
| L1 — Balance sheet (quarterly)    | 40 quarters            | 90      | 0      | 2,230     | 77,246    |
| L1 — Cash flow (quarterly)        | 40 quarters            | 90      | 0      | 2,230     | 77,819    |
| L1 — Financial growth (quarterly) | 40 quarters            | 90      | 0      | 2,230     | 78,406    |
| L1 — Dividends history            | full history           | 90      | 0      | 2,230     | 92,515    |
| L1 — Splits history               | full history           | 90      | 0      | 2,230     | 4,552     |
| L1 — Earnings calendar            | 2016-01-01..2026-11-04 | 65      | 59     | 6         | 24,000    |
| L1 — Dividends calendar           | 2016-01-01..2026-11-04 | 65      | 59     | 6         | 23,998    |
| L1 — Splits calendar              | 2016-01-01..2026-11-04 | 65      | 59     | 6         | 1,436     |

Coverage afterwards (collection: rows, first → last date):

- `eod_prices`: 5,022,016, 2016-01-04 → 2026-11-04 (2,230 of 2,249 universe symbols; 19 returned no bars)
- `eod_index`: 10,927, 2016-01-04 → 2026-11-04
- `income_statement` / `balance_sheet` / `cash_flow` / `financial_growth`: ~78k each, 40 quarters per symbol
  (dates back to 1994 for long-listed companies)
- `dividends_history`: 92,590, from 1977; `splits_history`: 4,569, from 1930
- `earnings_calendar`: 28,399, 2025-11-12 → 2026-11-18; `dividends_calendar` and `splits_calendar`: likewise one year

## Findings

- **Calendar history is a plan limit.** FMP answers older ranges of `earnings-calendar`, `dividends-calendar` and
  `splits-calendar` with "not in the current plan"; only about the last year is served. Dividends and splits are
  fully covered by the per-symbol histories, which `corporate_actions` merges with the calendars (C3). Earnings
  history before 2025-11 is not available; `fundamentals_pit` uses statement acceptance times instead.
- **19 universe symbols returned no EOD bars** (2,230 of 2,249 covered); they are listed in the sync's runs
  (per-symbol errors, #76) and are mostly very recent or inactive listings.
- No FMP throttling failures: the shared limiter (#78) kept the backfill within the plan's rate.

## Layer 2 rebuild

After the backfill, Layer 2 was rebuilt through the new transforms (#98, #99): `securities` (2,081 written,
H4–H6 applied), `corporate_actions` (96,041), `prices_daily` (yearly chunks 2016 → 2026) and `macro_daily`.
