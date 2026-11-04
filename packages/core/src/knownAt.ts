// Point-in-time rules for Layer 1 datasets (#84): when each raw row became known, so agents, backtests,
// bindings and pipelines can read Layer 1 directly ("Layer 2 is optional"). Semantics match
// pipeline/core/pit.py: known_at is a UTC instant; as_of_date is the first session that opens after it
// (the same date for end-of-day prices). Without the trading calendar, "next session" = next weekday;
// the M3 as_of reader refines holidays with trading_calendar.

export type KnownAtRule =
  /** End-of-day value for `field`: known at that day's 16:00 ET close, usable the same date. */
  | { type: 'eod'; field: string }
  /** A date or timestamp field (`fallback` when empty). Date-only values are taken as end of day. */
  | { type: 'timestamp'; field: string; fallback?: string }
  /** SEC filings: `acceptedDate`, or period end + 45 days (Q1–Q3) / 90 days (Q4, FY) when it is a placeholder. */
  | { type: 'statement'; field: 'acceptedDate'; periodField: 'date' }
  /** Period end + lag, for values without their own filing time (annual metrics, segments, macro releases). */
  | { type: 'periodLag'; periodField: string; lagDays: number; note?: string }
  /** Known on `field`'s date, usable from the next session close (unknown BMO/AMC timing). */
  | { type: 'nextSession'; field: string }
  /** Corporate actions with no announcement date: known the day before `field` (the ex-date). */
  | { type: 'dayBefore'; field: string }
  /** Weekly snapshots: known on `snapshot_date`. */
  | { type: 'snapshot'; field: 'snapshot_date' }
  /** Holds today's value only; never readable for historical dates. */
  | { type: 'current_only' };

const eod = (field = 'date'): KnownAtRule => ({ type: 'eod', field });
const ts = (field: string, fallback?: string): KnownAtRule => ({
  type: 'timestamp',
  field,
  ...(fallback ? { fallback } : {}),
});
const lag = (lagDays: number, note?: string): KnownAtRule => ({
  type: 'periodLag',
  periodField: 'date',
  lagDays,
  ...(note ? { note } : {}),
});
const CURRENT: KnownAtRule = { type: 'current_only' };
const SNAP: KnownAtRule = { type: 'snapshot', field: 'snapshot_date' };
const STATEMENT: KnownAtRule = { type: 'statement', field: 'acceptedDate', periodField: 'date' };

/** One rule per catalog dataset id (a unit test enforces completeness). */
export const KNOWN_AT: Record<string, KnownAtRule> = {
  universe: CURRENT,
  eod_prices: eod(),
  eod_index: eod(),
  treasury_rates: eod(),
  sector_performance: eod(),
  market_cap: eod(),
  historical_market_cap: eod(),
  earnings_calendar: { type: 'nextSession', field: 'date' },
  dividends_calendar: ts('declarationDate', 'date'),
  dividends_history: ts('declarationDate', 'date'),
  splits_calendar: { type: 'dayBefore', field: 'date' },
  splits_history: { type: 'dayBefore', field: 'date' },
  insider_trades: ts('filingDate'),
  congress_senate: ts('disclosureDate'),
  congress_house: ts('disclosureDate'),
  analyst_grades: ts('publishedDate'),
  price_target_changes: ts('publishedDate'),
  news_stocks: ts('publishedDate'),
  employee_count: ts('filingDate'),
  income_statement: STATEMENT,
  balance_sheet: STATEMENT,
  cash_flow: STATEMENT,
  key_metrics: lag(90, "join the matching income_statement row's acceptedDate when available"),
  ratios: lag(90, "join the matching income_statement row's acceptedDate when available"),
  financial_growth: lag(90, "join the matching income_statement row's acceptedDate when available"),
  enterprise_values: lag(90, 'priced at period end; recompute EV with the price on the as_of date'),
  owner_earnings: lag(90),
  revenue_product_segmentation: lag(90),
  revenue_geo_segmentation: lag(90),
  economic_gdp: lag(45, 'advance estimate about a month after the quarter'),
  economic_cpi: lag(20, 'released about two weeks after the month'),
  analyst_estimates: SNAP,
  price_target_consensus: SNAP,
  grades_consensus: SNAP,
  financial_scores: SNAP,
  company_profiles: CURRENT,
  shares_float: CURRENT,
  price_target_summary: CURRENT,
  stock_peers: CURRENT,
  key_executives: CURRENT,
  biggest_gainers: CURRENT,
  most_actives: CURRENT,
};

/** One-line description for the catalog and the agents. */
export function describeKnownAt(rule: KnownAtRule): string {
  switch (rule.type) {
    case 'eod':
      return `\`${rule.field}\` at the 16:00 ET close; usable the same date`;
    case 'timestamp':
      return `\`${rule.field}\`${rule.fallback ? ` (else \`${rule.fallback}\`)` : ''}; usable from the next session`;
    case 'statement':
      return '`acceptedDate` (SEC acceptance); if it equals the period end it is a placeholder: period end + 45 days (Q1–Q3) or + 90 days (Q4/FY)';
    case 'periodLag':
      return `period end (\`${rule.periodField}\`) + ${rule.lagDays} days${rule.note ? `; ${rule.note}` : ''}`;
    case 'nextSession':
      return `\`${rule.field}\`; BMO/AMC timing unknown, so usable from the next session close`;
    case 'dayBefore':
      return `the day before \`${rule.field}\` (no announcement date)`;
    case 'snapshot':
      return '`snapshot_date` (weekly snapshot; no history before the first snapshot)';
    case 'current_only':
      return 'current value only; never use for historical dates';
  }
}

// --- computing known_at / as_of_date for a row ----------------------------------------------------
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** UTC instant of a New York wall-clock time (DST-correct via Intl). */
export function easternToUtc(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return new Date(guess - (asIfUtc - guess));
}
const easternDate = (t: Date) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(t); // YYYY-MM-DD
  return p;
};
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isWeekend = (iso: string) => [0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());
const nextWeekday = (iso: string) => {
  let d = addDays(iso, 1);
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
};
const onOrNextWeekday = (iso: string) => (isWeekend(iso) ? nextWeekday(iso) : iso);

/** Parse a date / timestamp value to a UTC instant. Date-only = end of that day (16:00 ET); naive = ET. */
function parseInstant(v: unknown, dateOnlyAt: [number, number] = [16, 0]): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  let m = s.match(DATE);
  if (m) return easternToUtc(+m[1], +m[2], +m[3], dateOnlyAt[0], dateOnlyAt[1]);
  m = s.match(NAIVE);
  if (m) return easternToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}
/** First session whose 09:30 ET open is after `t` (weekdays; holidays are refined by the M3 reader). */
function firstSessionAfter(t: Date): string {
  const d = easternDate(t);
  const open = easternToUtc(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10), 9, 30);
  return !isWeekend(d) && open.getTime() > t.getTime() ? d : nextWeekday(d);
}

export type KnownAtResult = { known_at: string; as_of_date: string } | null;
/** When `row` became known and the first trading date it may be acted on; null for current-only data. */
export function knownAtOf(rule: KnownAtRule, row: Record<string, unknown>): KnownAtResult {
  const out = (t: Date | null, asOf: (t: Date) => string): KnownAtResult =>
    t ? { known_at: t.toISOString(), as_of_date: asOf(t) } : null;
  switch (rule.type) {
    case 'current_only':
      return null;
    case 'eod':
    case 'snapshot':
      return out(parseInstant(row[rule.field]), (t) => onOrNextWeekday(easternDate(t)));
    case 'timestamp':
      return out(
        parseInstant(row[rule.field]) ?? (rule.fallback ? parseInstant(row[rule.fallback]) : null),
        firstSessionAfter,
      );
    case 'nextSession':
      return out(parseInstant(row[rule.field]), firstSessionAfter);
    case 'dayBefore': {
      const v = row[rule.field];
      if (typeof v !== 'string' || !DATE.test(v)) return null;
      return out(parseInstant(addDays(v, -1)), firstSessionAfter);
    }
    case 'statement': {
      const accepted = row.acceptedDate;
      const period = typeof row.date === 'string' ? row.date : '';
      const placeholder =
        typeof accepted !== 'string' || !accepted.trim() || accepted.slice(0, 10) === period;
      if (!placeholder) return out(parseInstant(accepted), firstSessionAfter);
      if (!DATE.test(period)) return null;
      const lagDays = ['Q4', 'FY'].includes(String(row.period ?? '')) ? 90 : 45;
      return out(parseInstant(addDays(period, lagDays)), firstSessionAfter);
    }
    case 'periodLag': {
      const v = row[rule.periodField];
      if (typeof v !== 'string' || !DATE.test(v)) return null;
      return out(parseInstant(addDays(v, rule.lagDays)), firstSessionAfter);
    }
  }
}
