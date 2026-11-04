// #157 pipeline graph layout: swimlanes, in-lane depth, critical path and Gantt bars.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  criticalPath,
  ganttBars,
  layoutPipeline,
  laneOf,
  NODE_W,
} from '../../apps/studio/src/pipelineLayout.js';

const nodes = [
  { id: 'eod', ref: 'sync:EOD', after: [] },
  { id: 'est', ref: 'sync:Estimates', after: [] },
  { id: 'prices', ref: 'transform:prices_daily', after: ['eod'] },
  { id: 'features', ref: 'transform:features_daily', after: ['prices', 'est'] },
  { id: 'ready', ref: 'check:collection_rows', after: ['features'] },
  { id: 'research', ref: 'research:loop', after: ['ready'] },
  { id: 'live', ref: 'live:all', after: ['features'] },
  { id: 'brief', ref: 'harness:Daily brief', after: ['live'] },
];

test('lanes left to right, depth within a lane, rows follow the flow', () => {
  assert.equal(laneOf('check:x'), 'transform');
  const { placed, lanes } = layoutPipeline(nodes);
  assert.deepEqual(
    lanes.map((l) => l.id),
    ['sync', 'transform', 'research', 'live', 'harness'],
  );
  const at = Object.fromEntries(placed.map((p) => [p.id, p]));
  assert.equal(at.eod.x, at.est.x, 'two syncs share the first column');
  assert.ok(at.eod.y !== at.est.y);
  assert.ok(at.prices.x < at.features.x && at.features.x < at.ready.x, 'a chain inside L2 gets columns');
  assert.equal(at.features.x - at.prices.x, NODE_W + 40);
  assert.ok(
    at.ready.x < at.research.x && at.research.x < at.live.x && at.live.x < at.brief.x,
    'lanes in layer order',
  );
  assert.deepEqual(
    layoutPipeline(nodes.filter((n) => n.ref.startsWith('sync'))).lanes.length,
    1,
    'empty lanes hidden',
  );
});

test('critical path and Gantt bars', () => {
  const t = (m: number) => new Date(Date.UTC(2026, 10, 7, 11, m)).toISOString();
  const timed = [
    { id: 'eod', after: [], startedAt: t(0), finishedAt: t(10) },
    { id: 'est', after: [], startedAt: t(0), finishedAt: t(4) },
    { id: 'features', after: ['eod', 'est'], startedAt: t(10), finishedAt: t(15) },
    { id: 'live', after: ['features'], startedAt: t(15), finishedAt: t(20) },
    { id: 'idle', after: ['live'] },
  ];
  assert.deepEqual(criticalPath(timed), ['eod', 'features', 'live']);
  const g = ganttBars(t(0), t(20), timed);
  const by = Object.fromEntries(g.bars.map((b) => [b.id, b]));
  assert.deepEqual([by.features.runLeftPct, by.features.runWidthPct], [50, 25]);
  assert.equal(by.idle.runLeftPct, undefined, 'a node that never started has no running bar');
});
