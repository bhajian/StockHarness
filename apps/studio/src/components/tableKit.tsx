// Shared table behaviour (#384, #385): infinite-scroll paging (20 rows per page, more as you scroll) and
// click-to-sort column headers that sort by the underlying value, not the displayed text.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

// ---------------------------------------------------------------------------------------------------------
// Sorting

/** What a column sorts by: numbers numerically, dates by time, text naturally ("L2" before "L10"). */
export type SortValue = number | string | Date | boolean | null | undefined;
export type SortState = { by: string; desc: boolean } | null;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const isEmpty = (v: SortValue) =>
  v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v));

/** Compare two values ascending; empty values ("—") are not handled here (see sortRows). */
export function compareValues(a: SortValue, b: SortValue): number {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : Date.parse(String(a));
    const tb = b instanceof Date ? b.getTime() : Date.parse(String(b));
    return ta - tb;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

/**
 * Rows sorted by `value` (stable: equal values keep their order). Empty values always go last, in both
 * directions, so "—" never fills the top of a descending sort.
 */
export function sortRows<T>(rows: readonly T[], value: (row: T) => SortValue, desc = false): T[] {
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((x, y) => {
      const ex = isEmpty(x.v);
      const ey = isEmpty(y.v);
      if (ex || ey) return ex === ey ? x.i - y.i : ex ? 1 : -1;
      const c = compareValues(x.v, y.v);
      return (desc ? -c : c) || x.i - y.i;
    })
    .map((x) => x.row);
}

/** A value's rank in a logical order (statuses, priorities); unknown values sort after the known ones. */
export const rankOf =
  (order: readonly string[]) =>
  (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const i = order.indexOf(String(v));
    return i === -1 ? order.length : i;
  };

export type SortColumns<T> = Record<string, { value: (row: T) => SortValue; firstDesc?: boolean }>;

/** The next sort after clicking a column: a new column starts in its first direction, the same one flips. */
export function nextSort(current: SortState, by: string, firstDesc = false): SortState {
  return current?.by === by ? { by, desc: !current.desc } : { by, desc: firstDesc };
}

/**
 * Sort state plus the sorted rows. Sorting happens on the whole (filtered) list, before any paging, so a
 * paged table shows the true top rows.
 */
export function useSort<T>(rows: readonly T[], columns: SortColumns<T>, initial: SortState = null) {
  const [sort, setSort] = useState<SortState>(initial);
  // `columns` is usually an inline object (new every render), and columns can appear later (one per year once
  // the data loads): read the latest through a ref, and re-sort only when the rows or the sort change.
  const cols = useRef(columns);
  cols.current = columns;
  const sorted = useMemo(() => {
    const col = sort && cols.current[sort.by];
    return col ? sortRows(rows, col.value, sort.desc) : [...rows];
  }, [rows, sort]);
  const toggle = useCallback(
    (by: string) => setSort((s) => nextSort(s, by, cols.current[by]?.firstDesc)),
    [],
  );
  return { sorted, sort, toggle, setSort };
}

/** A sortable column header: a button with an arrow, and aria-sort on the cell. */
export function SortTh({
  id,
  sort,
  onSort,
  children,
  className,
  title,
}: {
  id: string;
  sort: SortState;
  onSort: (id: string) => void;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const active = sort?.by === id;
  return (
    <th
      className={className}
      aria-sort={active ? (sort!.desc ? 'descending' : 'ascending') : 'none'}
      title={title}
    >
      <button type="button" className="th-sort" onClick={() => onSort(id)}>
        {children}
        <span className={`th-sort-arrow${active ? ' active' : ''}`} aria-hidden="true">
          {active ? (sort!.desc ? '↓' : '↑') : '↕'}
        </span>
      </button>
    </th>
  );
}

/** A header row of sortable columns (`label` may be an element). */
export function SortHead({
  heads,
  sort,
  toggle,
  extra,
}: {
  /** `[id, label, className?]`: `num` right-aligns a numeric column. */
  heads: readonly (readonly [string, ReactNode, string?])[];
  sort: SortState;
  toggle: (id: string) => void;
  /** Trailing cells that do not sort (actions). */
  extra?: ReactNode;
}) {
  return (
    <thead>
      <tr>
        {heads.map(([id, label, className]) => (
          <SortTh key={id} id={id} sort={sort} onSort={toggle} className={className}>
            {label}
          </SortTh>
        ))}
        {extra}
      </tr>
    </thead>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Infinite scroll

export const PAGE_SIZE = 20;

/** How many rows to render: whole pages, enough to include `keepIndex` (the selected row), at most all. */
export function rowsToShow(total: number, pages: number, pageSize = PAGE_SIZE, keepIndex = -1) {
  const need = keepIndex >= 0 ? Math.ceil((keepIndex + 1) / pageSize) : 0;
  return Math.min(total, Math.max(pages, need, 1) * pageSize);
}

/**
 * Renders `pageSize` rows at a time and the next page when a sentinel at the bottom scrolls into view of the
 * scroll container. Changing `resetKey` (filters, sort) goes back to the first page. `keepIndex` keeps a
 * selected row loaded.
 */
export function useInfiniteRows<T>(
  rows: readonly T[],
  opts: { pageSize?: number; resetKey?: unknown; keepIndex?: number } = {},
) {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const [pages, setPages] = useState(1);
  const resetKey = JSON.stringify(opts.resetKey ?? null);
  const count = rowsToShow(rows.length, pages, pageSize, opts.keepIndex);
  const shown = useMemo(() => rows.slice(0, count), [rows, count]);
  const hasMore = count < rows.length;
  const more = useCallback(
    () => setPages((p) => Math.max(p, Math.ceil(count / pageSize)) + 1),
    [count, pageSize],
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  // A new filter or sort starts again at the top: the first page, scrolled up (otherwise the sentinel is still in
  // view at the bottom and loads every page again).
  useEffect(() => {
    setPages(1);
    if (rootRef.current) rootRef.current.scrollTop = 0;
  }, [resetKey]);
  const sentinel = useRef<Element | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback(
    (el: Element | null) => {
      observer.current?.disconnect();
      sentinel.current = el;
      if (!el || typeof IntersectionObserver === 'undefined') return;
      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) more();
        },
        // Start loading a little before the end comes into view.
        { root: rootRef.current, rootMargin: '0px 0px 160px 0px' },
      );
      observer.current.observe(el);
    },
    [more],
  );
  useEffect(() => () => observer.current?.disconnect(), []);
  return { shown, hasMore, more, total: rows.length, rootRef, sentinelRef };
}

/** The last row of a paged table: the scroll sentinel, with a button for keyboards and old browsers. */
export function MoreRows({
  colSpan,
  shown,
  total,
  onMore,
  sentinelRef,
}: {
  colSpan: number;
  shown: number;
  total: number;
  onMore: () => void;
  sentinelRef: (el: Element | null) => void;
}) {
  if (shown >= total) return null;
  return (
    <tr className="table-more" ref={sentinelRef}>
      <td colSpan={colSpan}>
        <span className="muted-line">
          Showing {shown} of {total}
        </span>{' '}
        <button type="button" className="link-button" onClick={onMore}>
          Show {Math.min(PAGE_SIZE, total - shown)} more
        </button>
      </td>
    </tr>
  );
}

/**
 * The rows of a paged table that grows with the page (#414): 20 rows, then 20 more as the page scrolls (the
 * viewport is the scroll root), with a "Show more" row for keyboards. A new sort or a different row count (a
 * filter) starts again at the first page. Use inside <tbody>; the render function returns one <tr> per row.
 */
export function PagedRows<T>({
  rows,
  resetKey,
  children,
  colSpan = 100,
}: {
  rows: readonly T[];
  resetKey?: unknown;
  children: (row: T, index: number) => ReactNode;
  colSpan?: number;
}) {
  const page = useInfiniteRows(rows, { resetKey: [resetKey ?? null, rows.length] });
  return (
    <>
      {page.shown.map((row, i) => children(row, i))}
      <MoreRows
        colSpan={colSpan}
        shown={page.shown.length}
        total={page.total}
        onMore={page.more}
        sentinelRef={page.sentinelRef}
      />
    </>
  );
}
