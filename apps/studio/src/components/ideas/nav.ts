// Page navigation inside the studio: push a URL and let the pages re-read location (#119).
import { useEffect, useState } from 'react';

export const go = (path: string) => {
  history.pushState({}, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
};
/** The current path and query, updated on navigation. */
export function useLocation() {
  const [loc, setLoc] = useState({ path: location.pathname, search: location.search });
  useEffect(() => {
    const on = () => setLoc({ path: location.pathname, search: location.search });
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  return loc;
}
/** Replace the query string without a new history entry (filters kept in the URL). */
export function setQuery(params: Record<string, string | undefined>) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  history.replaceState({}, '', `${location.pathname}${s ? `?${s}` : ''}`);
  dispatchEvent(new PopStateEvent('popstate'));
}
export const pct = (v: unknown, d = 1) =>
  typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—';
export const num = (v: unknown, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  pre_review: 'Pre-review',
  revise: 'Revising',
  rejected_untestable: 'Rejected',
  approved_for_code: 'Approved for code',
  coding: 'Coding',
  code_error: 'Code error',
  evaluated: 'Evaluated',
  post_review: 'Post-review',
  revise_code: 'Revising code',
  failed: 'Failed',
  promising: 'Promising',
  successful: 'Successful',
  approved: 'Approved',
  parked: 'Parked',
};
