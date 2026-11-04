// #94 "New transform" templates. Each is a complete, valid transform (checked by a unit test against
// transformInputSchema) that a user can save as-is and then adapt. Layer 2 means many flat collections:
// the Flatten template splits one nested Layer 1 dataset into several outputs.
export type TemplateOutput = {
  collection: string;
  key: string[];
  write_mode?: 'upsert' | 'append' | 'replace';
  known_at_field?: string;
  as_of_field?: string;
  static?: boolean;
  description?: string;
  grain?: string;
  fields?: Record<string, { description?: string; unit?: string }>;
};
export type TransformDraft = {
  name: string;
  description: string;
  code: string;
  inputs: string[];
  outputs: TemplateOutput[];
  trigger: { schedule?: Record<string, unknown>; after: string[] };
  incremental: { mode: 'full' | 'date_range'; lookback_days: number };
  params: Record<string, unknown>;
  secrets: string[];
  enabled: boolean;
};
export type TransformTemplate = { id: string; label: string; text: string; draft: TransformDraft };

const base = (d: Partial<TransformDraft> & Pick<TransformDraft, 'code' | 'outputs'>): TransformDraft => ({
  name: '',
  description: '',
  inputs: [],
  trigger: { after: [] },
  incremental: { mode: 'full', lookback_days: 0 },
  params: {},
  secrets: [],
  enabled: true,
  ...d,
});

export const TEMPLATES: TransformTemplate[] = [
  {
    id: 'blank',
    label: 'Blank',
    text: 'One input, one point-in-time output.',
    draft: base({
      name: 'my_transform',
      inputs: ['eod_prices'],
      outputs: [
        {
          collection: 'my_output',
          key: ['symbol', 'date'],
          known_at_field: 'known_at',
          as_of_field: 'as_of_date',
        },
      ],
      incremental: { mode: 'date_range', lookback_days: 0 },
      code: `import oh

w = oh.window  # {start, end, lookback_start}; None for full-mode transforms
flt = {"date": {"$gte": w.start, "$lte": w.end}} if w else {}
df = oh.read_df("eod_prices", flt, columns=["symbol", "date", "close"])

df["known_at"] = df["date"].map(oh.pit.eod_known_at)
df["as_of_date"] = df["date"]
oh.output("my_output").upsert_df(df)
`,
    }),
  },
  {
    id: 'join',
    label: 'Join',
    text: 'Join prices and market cap on symbol and date with DuckDB.',
    draft: base({
      name: 'prices_with_mcap',
      inputs: ['eod_prices', 'historical_market_cap'],
      outputs: [
        {
          collection: 'prices_with_mcap',
          key: ['symbol', 'date'],
          known_at_field: 'known_at',
          as_of_field: 'as_of_date',
        },
      ],
      incremental: { mode: 'date_range', lookback_days: 0 },
      code: `import oh

w = oh.window
flt = {"date": {"$gte": w.start, "$lte": w.end}} if w else {}
prices = oh.read_df("eod_prices", flt, columns=["symbol", "date", "close"])
mcap = oh.read_df("historical_market_cap", flt, columns=["symbol", "date", "marketCap"])

df = oh.duckdb(p=prices, m=mcap).sql("""
    select p.symbol, p.date, p.close, m.marketCap as market_cap
    from p left join m using (symbol, date)
""").df()
df["known_at"] = df["date"].map(oh.pit.eod_known_at)
df["as_of_date"] = df["date"]
oh.output("prices_with_mcap").upsert_df(df)
`,
    }),
  },
  {
    id: 'flatten',
    label: 'Flatten',
    text: 'Split one nested Layer 1 dataset into several flat collections.',
    draft: base({
      name: 'profiles_flat',
      inputs: ['company_profiles'],
      outputs: [
        {
          collection: 'company_identity',
          key: ['symbol'],
          known_at_field: 'known_at',
          description: 'One row per symbol: name, exchange, currency',
          grain: 'symbol',
        },
        {
          collection: 'company_classification',
          key: ['symbol'],
          known_at_field: 'known_at',
          description: 'Sector and industry per symbol',
          grain: 'symbol',
        },
        {
          collection: 'company_listing',
          key: ['symbol'],
          known_at_field: 'known_at',
          description: 'Listing status per symbol: IPO date, ETF/fund flags, actively trading',
          grain: 'symbol',
        },
      ],
      code: `import oh, datetime as dt

known_at = dt.datetime.now(dt.timezone.utc).isoformat()  # profiles are a current snapshot
identity, classification, listing = [], [], []
for p in oh.read("company_profiles"):
    s = p.get("symbol")
    if not s:
        oh.dq("missing_symbol", "warn")
        continue
    identity.append({"symbol": s, "name": p.get("companyName"), "exchange": p.get("exchange"),
                     "currency": p.get("currency"), "known_at": known_at})
    classification.append({"symbol": s, "sector": p.get("sector"), "industry": p.get("industry"),
                           "known_at": known_at})
    listing.append({"symbol": s, "ipo_date": p.get("ipoDate"), "is_etf": p.get("isEtf"), "is_fund": p.get("isFund"),
                    "is_actively_trading": p.get("isActivelyTrading"), "known_at": known_at})

oh.output("company_identity").upsert(identity)
oh.output("company_classification").upsert(classification)
oh.output("company_listing").upsert(listing)
`,
    }),
  },
  {
    id: 'feature',
    label: 'Feature',
    text: 'Rolling features per symbol, with a lookback so the first window day is complete.',
    draft: base({
      name: 'momentum_features',
      inputs: ['eod_prices'],
      outputs: [
        {
          collection: 'momentum_features',
          key: ['symbol', 'date'],
          known_at_field: 'known_at',
          as_of_field: 'as_of_date',
          grain: 'symbol x trading day',
        },
      ],
      incremental: { mode: 'date_range', lookback_days: 60 },
      params: { window: 20 },
      code: `import oh

w = oh.window
n = int(oh.params.get("window", 20))
flt = {"date": {"$gte": w.lookback_start, "$lte": w.end}} if w else {}
df = oh.read_df("eod_prices", flt, columns=["symbol", "date", "close"]).sort_values(["symbol", "date"])

g = df.groupby("symbol")["close"]
df["ret_1d"] = g.pct_change()
df[f"mom_{n}d"] = g.pct_change(n)
df[f"vol_{n}d"] = df.groupby("symbol")["ret_1d"].transform(lambda r: r.rolling(n).std())
df["known_at"] = df["date"].map(oh.pit.eod_known_at)
df["as_of_date"] = df["date"]
if w:
    df = df[df.date >= w.start]  # write only the window; the lookback is context
oh.output("momentum_features").upsert_df(df)
oh.describe("momentum_features", description=f"{n}-day momentum and volatility per symbol",
            fields={"ret_1d": {"description": "1-day return", "unit": "ratio"}})
`,
    }),
  },
  {
    id: 'snapshot_diff',
    label: 'Snapshot diff',
    text: 'Record what changed between two snapshots of a current-only dataset.',
    draft: base({
      name: 'profile_changes',
      inputs: ['company_profiles'],
      outputs: [
        {
          collection: 'profile_changes',
          key: ['symbol', 'field', 'known_at'],
          write_mode: 'append',
          known_at_field: 'known_at',
          description: 'One row per changed field per snapshot',
        },
        {
          collection: 'profile_snapshot',
          key: ['symbol'],
          static: true,
          description: 'The last snapshot seen',
        },
      ],
      params: { fields: ['sector', 'industry', 'exchange'] },
      code: `import oh, datetime as dt

now = dt.datetime.now(dt.timezone.utc).isoformat()
fields = oh.params.get("fields", ["sector", "industry"])
before = {r["symbol"]: r for r in oh.read("profile_snapshot")}
changes, snapshot = [], []
for p in oh.read("company_profiles"):
    s = p.get("symbol")
    if not s:
        continue
    old = before.get(s, {})
    for f in fields:
        if s in before and old.get(f) != p.get(f):
            changes.append({"symbol": s, "field": f, "old": old.get(f), "new": p.get(f), "known_at": now})
    snapshot.append({"symbol": s, **{f: p.get(f) for f in fields}})

oh.output("profile_changes").upsert(changes)
oh.output("profile_snapshot").upsert(snapshot)
`,
    }),
  },
];

/** A read_df snippet for the inputs pane: the window filter when there is a date field, and a projection. */
export function readSnippet(collection: string, fields: string[], dateField?: string) {
  const v = collection.replace(/[^A-Za-z0-9_]/g, '_');
  const filter = dateField
    ? `{"${dateField}": {"$gte": oh.window.start, "$lte": oh.window.end}} if oh.window else {}`
    : '{}';
  const cols = fields.length ? `, columns=[${fields.map((f) => JSON.stringify(f)).join(', ')}]` : '';
  return `${v} = oh.read_df("${collection}", ${filter}${cols})\n`;
}
