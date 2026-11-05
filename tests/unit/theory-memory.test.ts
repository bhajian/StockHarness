// #111: the lexical fallback embedding and cosine similarity.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { cosine, lexicalVector, theoryText } = await import('../../packages/core/src/theoryMemory.js');

const A = theoryText({
  title: 'Post-earnings drift in quality names',
  hypothesis: 'High-quality companies that beat estimates keep drifting up for 40 days after the report.',
  signalLogic: 'Rank names by quality_score among those that reported in the last 5 days; long the top 10.',
});
test('a re-submission is identical, light rewording stays close, an unrelated idea is far', () => {
  assert.equal(Math.round(cosine(lexicalVector(A), lexicalVector(A)) * 1e6) / 1e6, 1);
  const reworded = A.replace('keep drifting up', 'keeps drifting higher').replace('top 10', 'top 12');
  assert.ok(cosine(lexicalVector(A), lexicalVector(reworded)) > 0.75);
  const other = theoryText({
    title: 'Low volatility in bear markets',
    hypothesis: 'The calmest stocks lose less in market downturns and outperform over a full cycle.',
    signalLogic: 'Rank by 63-day volatility, long the lowest decile, rebalance monthly.',
  });
  assert.ok(cosine(lexicalVector(A), lexicalVector(other)) < 0.3);
  assert.equal(lexicalVector(A).length, 512);
  assert.equal(cosine([1, 0], [1, 0, 0]), 0, 'different dimensions never match');
});
