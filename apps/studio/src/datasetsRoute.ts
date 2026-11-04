// Datasets page routing (#73): /datasets/<tab>[/<item>] so every screen is linkable.
export const DATASET_TABS = ['syncs', 'transforms', 'pipelines', 'catalog', 'health'] as const;
export type DatasetTab = (typeof DATASET_TABS)[number];
export type DatasetsRoute = { tab: DatasetTab; item?: string };

/** Parse a pathname such as `/datasets/transforms/prices_daily`. Unknown tabs fall back to syncs. */
export function parseDatasetsPath(pathname: string): DatasetsRoute {
  const [, page, tab, ...rest] = pathname.split('/');
  if (page !== 'datasets' && page !== 'dataset') return { tab: 'syncs' };
  const t = (DATASET_TABS as readonly string[]).includes(tab ?? '') ? (tab as DatasetTab) : 'syncs';
  const item = rest.length ? decodeURIComponent(rest.join('/')) : undefined;
  return item ? { tab: t, item } : { tab: t };
}

export const datasetsPath = (r: DatasetsRoute) =>
  `/datasets/${r.tab}${r.item ? `/${encodeURIComponent(r.item)}` : ''}`;

/** CSV for a set of rows (header from `columns`; objects become JSON; quotes doubled). */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join(
    '\n',
  );
}
