// Shared table behaviour (#384): paging for infinite-scroll tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rowsToShow, PAGE_SIZE } = await import('../../apps/studio/src/components/tableKit.js');

test('infinite scroll: 20 rows a page, the next page on demand, never more than there are', () => {
  assert.equal(PAGE_SIZE, 20);
  assert.equal(rowsToShow(56, 1), 20, 'first page');
  assert.equal(rowsToShow(56, 2), 40, 'scrolled once');
  assert.equal(rowsToShow(56, 3), 56, 'the last page is short');
  assert.equal(rowsToShow(56, 9), 56);
  assert.equal(rowsToShow(7, 1), 7, 'fewer rows than a page');
  assert.equal(rowsToShow(0, 1), 0);
});

test('a selected row further down stays loaded (opened from a link)', () => {
  assert.equal(rowsToShow(56, 1, 20, 0), 20);
  assert.equal(rowsToShow(56, 1, 20, 19), 20);
  assert.equal(rowsToShow(56, 1, 20, 20), 40, 'row 21 needs the second page');
  assert.equal(rowsToShow(56, 1, 20, 45), 56);
  assert.equal(rowsToShow(56, 1, 20, -1), 20, 'nothing selected');
});

// Sorting (#385).
const { sortRows, compareValues, rankOf, nextSort } =
  await import('../../apps/studio/src/components/tableKit.js');

test('sorts by the underlying value: numbers, dates, natural text', () => {
  const rows = [{ v: 1234 }, { v: 92 }, { v: 7 }, { v: 100000 }];
  assert.deepEqual(
    sortRows(rows, (r) => r.v).map((r) => r.v),
    [7, 92, 1234, 100000],
    'numerically, not "1,234" < "7" as text',
  );
  assert.deepEqual(
    sortRows(rows, (r) => r.v, true).map((r) => r.v),
    [100000, 1234, 92, 7],
  );
  assert.deepEqual(
    sortRows(['L10 — x', 'L2 — y', 'l1 — z'], (n) => n),
    ['l1 — z', 'L2 — y', 'L10 — x'],
    'natural and case-insensitive',
  );
  const d = (s: string) => new Date(s);
  const dates = [d('2026-11-14T18:49:00Z'), d('2026-10-23T17:58:00Z'), d('2026-11-13T18:58:00Z')];
  assert.deepEqual(
    sortRows(dates, (x) => x, true).map((x) => x.toISOString().slice(0, 10)),
    ['2026-11-14', '2026-11-13', '2026-10-23'],
  );
  assert.ok(compareValues('2016-01-01', '2026-01-01') < 0, 'ISO dates as text order by date');
});

test('empty values ("—") always go last, in both directions; equal values keep their order', () => {
  const rows = [
    { id: 'a', v: null },
    { id: 'b', v: 3 },
    { id: 'c', v: undefined },
    { id: 'd', v: 1 },
    { id: 'e', v: 3 },
    { id: 'f', v: '' },
  ];
  assert.deepEqual(
    sortRows(rows, (r) => r.v as number).map((r) => r.id),
    ['d', 'b', 'e', 'a', 'c', 'f'],
  );
  assert.deepEqual(
    sortRows(rows, (r) => r.v as number, true).map((r) => r.id),
    ['b', 'e', 'd', 'a', 'c', 'f'],
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ['a', 'b', 'c', 'd', 'e', 'f'],
    'the input is not mutated',
  );
});

test('logical orders for statuses and priorities; clicking flips the direction', () => {
  const status = rankOf(['failed', 'running', 'queued', 'ready', 'disabled']);
  assert.deepEqual(
    sortRows(['ready', 'disabled', 'failed', 'odd', 'queued'], status),
    ['failed', 'queued', 'ready', 'disabled', 'odd'],
    'unknown values after the known ones',
  );
  assert.equal(status(''), null);
  assert.deepEqual(nextSort(null, 'rows', true), { by: 'rows', desc: true }, 'numbers start largest first');
  assert.deepEqual(nextSort({ by: 'rows', desc: true }, 'rows'), { by: 'rows', desc: false });
  assert.deepEqual(nextSort({ by: 'rows', desc: false }, 'name'), { by: 'name', desc: false });
});
