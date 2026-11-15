// Shared table behaviour (#384): infinite-scroll paging, 20 rows per page and more as you scroll.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
