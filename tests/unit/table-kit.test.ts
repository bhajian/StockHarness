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
