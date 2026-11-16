// #461: the portfolio builder picks the best ideas whose returns are not too correlated, and says why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { buildPortfolio, correlation } = await import('../../packages/core/src/portfolioBuilder.js');

const series = (f: (k: number) => number, n = 300) =>
  new Map(Array.from({ length: n }, (_, k) => [`d${String(k).padStart(4, '0')}`, f(k)]));
const noise = (seed: number) => (k: number) => Math.sin(k * 12.9898 + seed * 78.233) * 0.01;

test('correlation of identical and unrelated series', () => {
  const a = series(noise(1));
  assert.ok(correlation(a, a).r! > 0.999);
  assert.ok(Math.abs(correlation(a, series(noise(7))).r!) < 0.5);
});

test('greedy by score, correlation cap, positive scores only, and a full book', () => {
  const a = series(noise(1));
  const c = (ref: string, score: number | null, returns: Map<string, number>) => ({
    ref,
    status: 'promising',
    score,
    scoreSource: 'explore_sharpe' as const,
    returns,
  });
  const r = buildPortfolio(
    [
      c('T-1', 1.2, a),
      c('T-2', 1.0, a),
      c('T-3', 0.8, series(noise(9))),
      c('T-4', -0.1, series(noise(4))),
      c('T-5', 0.7, series(noise(5))),
    ],
    { maxIdeas: 2, corrCap: 0.5, minOverlapDays: 100 },
  );
  assert.deepEqual(r.picked, ['T-1', 'T-3']);
  const why = Object.fromEntries(r.audit.map((x: any) => [x.ref, x.reason]));
  assert.match(why['T-2'], /correlation 1\.00 with T-1/);
  assert.match(why['T-4'], /no positive/);
  assert.match(why['T-5'], /book is full/);
});

test('too little history in common is skipped', () => {
  const r = buildPortfolio(
    [
      { ref: 'T-1', status: 'promising', score: 1, scoreSource: 'explore_sharpe', returns: series(noise(1)) },
      {
        ref: 'T-2',
        status: 'promising',
        score: 0.9,
        scoreSource: 'explore_sharpe',
        returns: series(noise(2), 50),
      },
    ],
    { maxIdeas: 8, corrCap: 0.5, minOverlapDays: 252 },
  );
  assert.deepEqual(r.picked, ['T-1']);
  assert.match(r.audit[1].reason, /only 50 days in common/);
});
