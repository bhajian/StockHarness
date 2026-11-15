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
type Ctx = { collection: string; dateMin?: string; dateField?: string; firstSnapshot?: string };
type Builtin = {
  id: string;
  severity: CaveatSeverity;
  source: 'plan' | 'data';
  fix?: string;
  applies: (c: Ctx) => boolean;
  text: (c: Ctx) => string;
};

const feeds = new Set(DATASET_CATALOG.filter((d) => d.scope === 'feed').map((d) => d.defaultCollection));
// Feed collections a per-symbol history sync also fills stay feeds for the survivorship caveat (#387).
const perSymbol = new Set(
  DATASET_CATALOG.filter((d) => d.perSymbol && !feeds.has(d.defaultCollection)).map(
    (d) => d.defaultCollection,
  ),
);
const snapshots = new Set(DATASET_CATALOG.filter((d) => d.snapshotDated).map((d) => d.defaultCollection));
/** Feed collections a per-symbol history dataset also fills (#387): they have history, per symbol. */
const historyBacked = new Map(
  DATASET_CATALOG.filter((d) => d.perSymbol && feeds.has(d.defaultCollection)).map((d) => [
    d.defaultCollection,
    d.label,
  ]),
);
/** Where the backtestable history of a forward-only collection lives, when FMP has one (#387). */
const historyElsewhere: Record<string, string> = {
  grades_consensus: 'grades_consensus_history (monthly, since about 2018)',
  analyst_grades: 'analyst_grades_history (every grade change, since about 2012)',
  price_target_consensus: 'price_target_changes (individual targets, latest 100 per symbol)',
};
const statements = new Set([
  'income_statement',
  'balance_sheet',
  'cash_flow',
  'financial_growth',
  'key_metrics_quarterly',
  'ratios_quarterly',
]);
const annualOnly: Record<string, string> = {
  analyst_estimates: 'analyst_estimates_quarterly',
  key_metrics: 'key_metrics_quarterly',
  ratios: 'ratios_quarterly',
};

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
      "Survivorship bias before 2021: the universe holds every delisted NASDAQ/NYSE/AMEX company FMP lists, but FMP's delisted list starts in late 2020. Companies that died in 2016-2020 are missing, so backtests over those years still lean toward survivors, most in small caps.",
  },
  {
    id: 'annual-only',
    severity: 'info',
    source: 'data',
    applies: (c) => c.collection in annualOnly,
    text: (c) => `Annual values; the quarterly series is ${annualOnly[c.collection]}.`,
  },
  {
    id: 'snapshot-history',
    severity: 'blocking',
    source: 'data',
    fix: '#113 (forward_only)',
    applies: (c) => snapshots.has(c.collection),
    text: (c) =>
      `No history before the first weekly snapshot${c.firstSnapshot ? ` (${c.firstSnapshot})` : ''}: FMP keeps no history of these values. Backtests must not use this data before that date; strategies built on it are forward-only.${historyElsewhere[c.collection] ? ` For history use ${historyElsewhere[c.collection]}.` : ''}`,
  },
  {
    id: 'feed-history',
    severity: 'blocking',
    source: 'data',
    applies: (c) => feeds.has(c.collection) && !historyBacked.has(c.collection),
    text: (c) =>
      `Feed of the latest items only: history starts when the sync started${c.dateMin ? ` (${c.dateMin})` : ''}. Not backtestable before then; strategies built on it are forward-only.${historyElsewhere[c.collection] ? ` For history use ${historyElsewhere[c.collection]}.` : ''}`,
  },
  {
    id: 'per-symbol-history',
    severity: 'warn',
    source: 'data',
    applies: (c) => historyBacked.has(c.collection),
    text: (c) =>
      `History comes from the per-symbol "${historyBacked.get(c.collection)}" sync and its backfill${c.dateMin ? ` (earliest ${c.dateMin})` : ''}; FMP serves a limited depth per symbol, so how far back it goes varies by company. The daily feed adds new rows.`,
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
    severity: 'info',
    source: 'data',
    applies: (c) => statements.has(c.collection),
    text: () =>
      'The weekly sync re-pulls the latest 8 quarters per symbol; older quarters come from the 48-quarter backfill. Symbols listed for less than that have shorter history.',
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
