// Data caveats (#85): plan limits and data-shape facts every agent, judge and backtest must account for.
// Built-in caveats attach to collections automatically; curated ones are added (and built-ins dismissed)
// through the catalog's curated docs, so they survive refreshes and round-trip as YAML.
import { DATASET_CATALOG } from './datasetCatalog.js';

export type CaveatSeverity = 'info' | 'warn' | 'blocking';
export type Caveat = {
  id: string;
  severity: CaveatSeverity;
  text: string;
  source: 'plan' | 'data' | 'curated';
  /** Issue that lifts it, when known. */
  fix?: string;
};
type Ctx = { collection: string; dateMin?: string; dateField?: string };
type Builtin = {
  id: string;
  severity: CaveatSeverity;
  source: 'plan' | 'data';
  fix?: string;
  applies: (c: Ctx) => boolean;
  text: (c: Ctx) => string;
};

const perSymbol = new Set(DATASET_CATALOG.filter((d) => d.perSymbol).map((d) => d.defaultCollection));
const feeds = new Set(DATASET_CATALOG.filter((d) => d.scope === 'feed').map((d) => d.defaultCollection));
const snapshots = new Set(DATASET_CATALOG.filter((d) => d.snapshotDated).map((d) => d.defaultCollection));
const statements = new Set(['income_statement', 'balance_sheet', 'cash_flow', 'financial_growth']);
const annualOnly = new Set(['analyst_estimates', 'key_metrics', 'ratios']);

export const BUILTIN_CAVEATS: Builtin[] = [
  {
    id: 'delisted-coverage',
    severity: 'warn',
    source: 'plan',
    fix: '#136',
    applies: (c) =>
      perSymbol.has(c.collection) ||
      ['universe', 'securities', 'prices_daily', 'delisted_companies'].includes(c.collection),
    text: () =>
      'Survivorship bias: the FMP plan serves only page 0 of delisted-companies (about 100 names), so most companies that died are missing. Backtests overstate returns, most in small caps.',
  },
  {
    id: 'index-constituents',
    severity: 'info',
    source: 'plan',
    fix: '#136',
    applies: (c) => ['universe', 'securities'].includes(c.collection),
    text: () =>
      'Index constituents (S&P 500, Nasdaq, Dow) are not available on the FMP plan (402); there is no index membership. The screener universe stands in.',
  },
  {
    id: 'annual-only',
    severity: 'info',
    source: 'plan',
    applies: (c) => annualOnly.has(c.collection),
    text: () => 'Annual values only: quarterly estimates and key metrics are not on the FMP plan.',
  },
  {
    id: 'snapshot-history',
    severity: 'blocking',
    source: 'data',
    fix: '#113 (forward_only)',
    applies: (c) => snapshots.has(c.collection),
    text: (c) =>
      `No history before the first weekly snapshot${c.dateField === 'snapshot_date' && c.dateMin ? ` (${c.dateMin})` : ''}: FMP keeps no estimate/consensus history. Backtests must not use this data before that date; strategies built on it are forward-only.`,
  },
  {
    id: 'feed-history',
    severity: 'blocking',
    source: 'data',
    applies: (c) => feeds.has(c.collection),
    text: (c) =>
      `Feed of the latest items only: history starts when the sync started${c.dateMin ? ` (${c.dateMin})` : ''}. Not backtestable before then; strategies built on it are forward-only.`,
  },
  {
    id: 'earnings-timing',
    severity: 'warn',
    source: 'data',
    fix: '#133',
    applies: (c) => ['earnings_calendar', 'earnings_surprises'].includes(c.collection),
    text: () =>
      'Report timing (before open / after close) is unknown: react at the next session close. Same-day reactions would be lookahead.',
  },
  {
    id: 'statement-depth',
    severity: 'warn',
    source: 'data',
    fix: '#77, #88',
    applies: (c) => statements.has(c.collection),
    text: () =>
      'Quarterly history is short (the sync pulls about 8 quarters per symbol) until the 40-quarter backfill. Year-over-year features need 5+ quarters.',
  },
  {
    id: 'current-sector',
    severity: 'warn',
    source: 'data',
    applies: (c) => ['securities', 'company_profiles', 'universe'].includes(c.collection),
    text: () =>
      'Sector and industry are the current classification, not point-in-time; sector-relative results before a reclassification are approximate.',
  },
];

/** The caveats for one collection: applicable built-ins (minus dismissed ones) plus curated ones. */
export function caveatsFor(
  ctx: Ctx,
  curated?: {
    caveats?: { id: string; severity: CaveatSeverity; text: string }[];
    dismissedCaveats?: string[];
  },
): Caveat[] {
  const dismissed = new Set(curated?.dismissedCaveats ?? []);
  const builtins = BUILTIN_CAVEATS.filter((b) => b.applies(ctx) && !dismissed.has(b.id)).map<Caveat>((b) => ({
    id: b.id,
    severity: b.severity,
    text: b.text(ctx),
    source: b.source,
    ...(b.fix ? { fix: b.fix } : {}),
  }));
  const extra = (curated?.caveats ?? []).map<Caveat>((c) => ({ ...c, source: 'curated' }));
  const order = { blocking: 0, warn: 1, info: 2 } as const;
  return [...builtins, ...extra].sort(
    (a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id),
  );
}
