// Collection coverage over time (#87): rows and distinct symbols per day on the collection's date field, and a
// year × ISO-week grid for gaps. Large collections take a while to aggregate, so results are computed in the
// background and cached (6 hours); callers get `computing` until the first result is ready.
import { collection, mongo } from './db.js';
import { workspaceDatabase } from './mongoMcp.js';
import { safeError } from './security.js';
import { catalogEntries } from './schemaCatalog.js';
import { downsample, type SeriesPayload } from './series.js';

export type Coverage = {
  _id: string; // ownerId:collection
  ownerId: string;
  collection: string;
  dateField?: string;
  daily: SeriesPayload & { downsampled?: number };
  /** Year × ISO week: x = week (1..53), y = year index; value = average symbols (else rows) per day. */
  heatmap: { years: string[]; cells: [number, number, number][]; value: 'symbols' | 'rows' };
  days: number;
  computedAt: Date;
  error?: string;
};
const coverage = () => collection<Coverage>('catalog_coverage');
const TTL_MS = 6 * 3600_000;
const inflight = new Map<string, Promise<Coverage>>();

function isoWeek(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  return { year, week: Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7) };
}

/** Build the payloads from per-day rows (exported for tests). */
export function coverageFromDays(days: { date: string; rows: number; symbols: number }[]) {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const hasSymbols = sorted.some((d) => d.symbols > 0);
  const daily = downsample({
    dates: sorted.map((d) => d.date),
    series: {
      rows: sorted.map((d) => d.rows),
      ...(hasSymbols ? { symbols: sorted.map((d) => d.symbols) } : {}),
    },
  });
  const weeks = new Map<string, { sum: number; n: number }>();
  for (const d of sorted) {
    const { year, week } = isoWeek(d.date);
    const k = `${year}|${week}`;
    const w = weeks.get(k) ?? { sum: 0, n: 0 };
    w.sum += hasSymbols ? d.symbols : d.rows;
    w.n++;
    weeks.set(k, w);
  }
  const years = [...new Set([...weeks.keys()].map((k) => k.split('|')[0]))].sort();
  const cells: [number, number, number][] = [...weeks.entries()].map(([k, w]) => {
    const [y, wk] = k.split('|');
    return [Number(wk) - 1, years.indexOf(y), Math.round(w.sum / w.n)];
  });
  return {
    daily,
    heatmap: { years, cells, value: (hasSymbols ? 'symbols' : 'rows') as 'symbols' | 'rows' },
    days: sorted.length,
  };
}

const EMPTY = {
  daily: { dates: [], series: {} },
  heatmap: { years: [], cells: [], value: 'rows' as const },
  days: 0,
};

async function compute(ownerId: string, name: string): Promise<Coverage> {
  const entry = await catalogEntries().findOne({ ownerId, collection: name });
  const field = entry?.coverage.dateField;
  const base = {
    _id: `${ownerId}:${name}`,
    ownerId,
    collection: name,
    ...(field ? { dateField: field } : {}),
    computedAt: new Date(),
  };
  let doc: Coverage;
  if (!field) doc = { ...base, ...EMPTY };
  else {
    try {
      const f = '$' + field;
      const asDay = {
        $substrBytes: [
          {
            $cond: [
              { $eq: [{ $type: f }, 'date'] },
              { $dateToString: { format: '%Y-%m-%d', date: f } },
              { $toString: f },
            ],
          },
          0,
          10,
        ],
      };
      const rows = await mongo
        .db(workspaceDatabase(ownerId))
        .collection(name)
        .aggregate<{ _id: string; rows: number; symbols: number }>(
          [
            { $match: { [field]: { $exists: true, $ne: null } } },
            { $project: { d: asDay, s: '$symbol' } },
            { $group: { _id: { d: '$d', s: '$s' }, n: { $sum: 1 } } },
            {
              $group: {
                _id: '$_id.d',
                rows: { $sum: '$n' },
                symbols: { $sum: { $cond: [{ $ifNull: ['$_id.s', false] }, 1, 0] } },
              },
            },
            { $match: { _id: { $regex: /^\d{4}-\d{2}-\d{2}$/ } } },
          ],
          { allowDiskUse: true, maxTimeMS: 10 * 60_000 },
        )
        .toArray();
      doc = {
        ...base,
        ...coverageFromDays(rows.map((r) => ({ date: r._id, rows: r.rows, symbols: r.symbols }))),
      };
    } catch (e) {
      doc = { ...base, ...EMPTY, error: safeError(e) };
    }
  }
  await coverage().replaceOne({ _id: doc._id }, doc, { upsert: true });
  return doc;
}

/** The cached coverage, or `computing` while a (re)computation runs in the background. */
export async function collectionCoverage(ownerId: string, name: string, opts: { refresh?: boolean } = {}) {
  const id = `${ownerId}:${name}`;
  const cached = await coverage().findOne({ _id: id });
  const fresh = cached && Date.now() - cached.computedAt.getTime() < TTL_MS && !opts.refresh;
  if (!fresh && !inflight.has(id)) {
    const p = compute(ownerId, name).finally(() => inflight.delete(id));
    p.catch(() => undefined);
    inflight.set(id, p);
  }
  return { coverage: cached, computing: inflight.has(id) };
}
/** Await the background computation (tests). */
export const coverageSettled = (ownerId: string, name: string) => inflight.get(`${ownerId}:${name}`);
