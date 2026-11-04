// Pipeline DAG layout (#157): left-to-right layer swimlanes (L1 syncs | L2 transforms & checks | L3 research |
// L5 live | harnesses). Within a lane, a node's column is its depth among same-lane predecessors. Also the
// critical path of a run and the Gantt scale. Pure functions (unit-tested).
export type LaneId = 'sync' | 'transform' | 'research' | 'live' | 'harness';
export const LANES: { id: LaneId; label: string }[] = [
  { id: 'sync', label: 'L1 · Syncs' },
  { id: 'transform', label: 'L2 · Transforms & checks' },
  { id: 'research', label: 'L3 · Research' },
  { id: 'live', label: 'L5 · Live' },
  { id: 'harness', label: 'Harnesses' },
];
export const NODE_W = 210;
export const NODE_H = 86;
export const GAP_X = 40;
export const GAP_Y = 22;
export const LANE_HEAD = 34;
export const LANE_PAD = 24;

export type GraphNode = { id: string; ref: string; after: string[] };
export const laneOf = (ref: string): LaneId => {
  const t = ref.slice(0, ref.indexOf(':'));
  return t === 'check' ? 'transform' : ((LANES.some((l) => l.id === t) ? t : 'harness') as LaneId);
};

export type Placed = { id: string; lane: LaneId; x: number; y: number };
export type LaneBox = { id: LaneId; label: string; x: number; width: number };
/** Positions for every node, and the lanes (only lanes that have nodes). */
export function layoutPipeline(nodes: GraphNode[]): { placed: Placed[]; lanes: LaneBox[]; height: number } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const local = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    const n = byId.get(id);
    if (!n || seen.has(id)) return 0;
    seen.add(id);
    const lane = laneOf(n.ref);
    const d = Math.max(
      0,
      ...n.after
        .filter((u) => byId.has(u) && laneOf(byId.get(u)!.ref) === lane)
        .map((u) => local(u, seen) + 1),
    );
    depth.set(id, d);
    return d;
  };
  for (const n of nodes) local(n.id);
  // Global order hint: a node's overall depth, so rows follow the flow.
  const gdepth = new Map<string, number>();
  const global = (id: string, seen = new Set<string>()): number => {
    if (gdepth.has(id)) return gdepth.get(id)!;
    const n = byId.get(id);
    if (!n || seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(0, ...n.after.filter((u) => byId.has(u)).map((u) => global(u, seen) + 1));
    gdepth.set(id, d);
    return d;
  };
  for (const n of nodes) global(n.id);
  const lanes: LaneBox[] = [];
  const placed: Placed[] = [];
  let x = 0;
  let height = 0;
  for (const lane of LANES) {
    const members = nodes.filter((n) => laneOf(n.ref) === lane.id);
    if (!members.length) continue;
    const cols = Math.max(...members.map((n) => depth.get(n.id)!)) + 1;
    const width = cols * NODE_W + (cols - 1) * GAP_X + 2 * LANE_PAD;
    lanes.push({ ...lane, x, width });
    for (let c = 0; c < cols; c++) {
      const col = members
        .filter((n) => depth.get(n.id) === c)
        .sort((a, b) => gdepth.get(a.id)! - gdepth.get(b.id)! || a.id.localeCompare(b.id));
      col.forEach((n, i) => {
        const y = LANE_HEAD + LANE_PAD + i * (NODE_H + GAP_Y);
        placed.push({ id: n.id, lane: lane.id, x: x + LANE_PAD + c * (NODE_W + GAP_X), y });
        height = Math.max(height, y + NODE_H + LANE_PAD);
      });
    }
    x += width + GAP_X;
  }
  return { placed, lanes, height };
}

export type TimedNode = { id: string; after: string[]; startedAt?: string; finishedAt?: string };
/** The chain that decided when the run finished: from the last node to finish, back through the latest upstream. */
export function criticalPath(nodes: TimedNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const t = (s?: string) => (s ? Date.parse(s) : -Infinity);
  let cur = [...nodes].filter((n) => n.finishedAt).sort((a, b) => t(b.finishedAt) - t(a.finishedAt))[0];
  const path: string[] = [];
  while (cur && !path.includes(cur.id)) {
    path.unshift(cur.id);
    const ups = cur.after.map((u) => byId.get(u)).filter((u): u is TimedNode => !!u?.finishedAt);
    cur = ups.sort((a, b) => t(b.finishedAt) - t(a.finishedAt))[0];
  }
  return path;
}

/** Gantt bars as percentages of the run's span: waiting (run start -> node start) and running. */
export function ganttBars(
  runStart: string,
  runEnd: string | undefined,
  nodes: TimedNode[],
  now = Date.now(),
) {
  const s = Date.parse(runStart);
  const e = Math.max(
    runEnd ? Date.parse(runEnd) : now,
    ...nodes.map((n) => (n.finishedAt ? Date.parse(n.finishedAt) : n.startedAt ? now : s)),
  );
  const span = Math.max(1, e - s);
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - s) / span) * 100));
  return {
    spanMs: span,
    bars: nodes.map((n) => {
      const start = n.startedAt ? Date.parse(n.startedAt) : undefined;
      const end = n.finishedAt ? Date.parse(n.finishedAt) : start !== undefined ? now : undefined;
      return {
        id: n.id,
        waitPct: start !== undefined ? pct(start) : pct(end ?? e),
        runLeftPct: start !== undefined ? pct(start) : undefined,
        runWidthPct:
          start !== undefined && end !== undefined ? Math.max(0.5, pct(end) - pct(start)) : undefined,
      };
    }),
  };
}
