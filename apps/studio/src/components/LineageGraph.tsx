// Catalog > Graph (#97): lineage DAG, left to right: syncs -> collections -> transforms -> collections.
// Borders show freshness; hover shows the last run; selecting a node highlights everything up- and
// downstream; Open goes to the sync, collection or transform. Styled like the Pipelines graph (#157).
import React, { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Code2, Database, RefreshCw } from 'lucide-react';
import { api, timestamp } from '../api';
import type { DatasetsRoute } from '../datasetsRoute';
import { layoutDag, NODE_W } from '../pipelineLayout';
import { fmtNumber } from '../charts/chartData';
import { Button } from './ui';
import { Skeleton, StatusPill } from './kit';

type LNode = {
  id: string;
  kind: 'sync' | 'collection' | 'transform';
  name: string;
  layer?: 1 | 2 | null;
  freshness: 'fresh' | 'stale' | 'failed' | 'unknown';
  rows?: number;
  lastRun?: { at?: string; status?: string; rows?: number; error?: string };
  enabled?: boolean;
  version?: number;
};
type Lineage = { nodes: LNode[]; edges: { from: string; to: string }[] };
const FRESH_PILL = { fresh: 'fresh', stale: 'stale', failed: 'failed', unknown: 'pending' } as const;
const ICON = { sync: RefreshCw, collection: Database, transform: Code2 };

function LineageCard({ data }: NodeProps<Node<{ n: LNode; dim: boolean; selected: boolean }>>) {
  const { n } = data;
  const Icon = ICON[n.kind];
  const tip = [
    `${n.kind} ${n.name}${n.version ? ` v${n.version}` : ''}`,
    n.lastRun?.at ? `last run ${new Date(n.lastRun.at).toLocaleString()} (${n.lastRun.status})` : 'never run',
    n.lastRun?.rows !== undefined ? `${n.lastRun.rows.toLocaleString()} rows written` : '',
    n.rows !== undefined ? `${n.rows.toLocaleString()} rows` : '',
    n.lastRun?.error ?? '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div
      className={`lnode lnode-${n.kind} fresh-${n.freshness}${data.dim ? ' dim' : ''}${data.selected ? ' selected' : ''}`}
      title={tip}
      style={{ width: NODE_W }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="lnode-head">
        <Icon size={13} aria-hidden="true" />
        <strong>{n.name}</strong>
      </div>
      <div className="lnode-meta">
        <StatusPill status={FRESH_PILL[n.freshness]} label={n.freshness} />
        {n.kind === 'collection' && n.rows !== undefined && <span>{fmtNumber(n.rows)} rows</span>}
        {n.kind !== 'collection' && n.lastRun?.at && <span>{timestamp(n.lastRun.at)}</span>}
        {n.enabled === false && <span>disabled</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { lineage: LineageCard };

/** `focus` = a collection name: show only what is connected to it (upstream and downstream). */
export function LineageGraph({
  go,
  focus,
  height = 560,
}: {
  go: (r: DatasetsRoute) => void;
  focus?: string;
  height?: number;
}) {
  const [data, setData] = useState<Lineage | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | undefined>(focus ? `collection:${focus}` : undefined);
  useEffect(() => {
    void api<Lineage>('/catalog/lineage').then(setData, (e) => setError(String(e)));
  }, []);
  const graph = useMemo(() => {
    if (!data) return null;
    const parents = new Map<string, string[]>();
    const children = new Map<string, string[]>();
    for (const e of data.edges) {
      parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
      children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
    }
    const walk = (start: string, next: Map<string, string[]>) => {
      const out = new Set<string>();
      const stack = [start];
      while (stack.length)
        for (const x of next.get(stack.pop()!) ?? []) if (!out.has(x)) (out.add(x), stack.push(x));
      return out;
    };
    const related = (id: string) => new Set([id, ...walk(id, parents), ...walk(id, children)]);
    const keep = focus ? related(`collection:${focus}`) : undefined;
    const nodes = data.nodes.filter((n) => !keep || keep.has(n.id));
    return { nodes, parents, related, ids: new Set(nodes.map((n) => n.id)) };
  }, [data, focus]);
  const highlight = useMemo(
    () => (graph && selected ? graph.related(selected) : undefined),
    [graph, selected],
  );
  const flow = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], edges: [] as Edge[] };
    const pos = layoutDag(
      graph.nodes.map((n) => ({
        id: n.id,
        after: (graph.parents.get(n.id) ?? []).filter((p) => graph.ids.has(p)),
      })),
    );
    return {
      nodes: graph.nodes.map((n) => ({
        id: n.id,
        type: 'lineage',
        position: pos[n.id],
        data: { n, dim: highlight ? !highlight.has(n.id) : false, selected: selected === n.id },
        draggable: false,
      })),
      edges: data!.edges
        .filter((e) => graph.ids.has(e.from) && graph.ids.has(e.to))
        .map((e) => ({
          id: `${e.from}->${e.to}`,
          source: e.from,
          target: e.to,
          className: `pedge${highlight && !(highlight.has(e.from) && highlight.has(e.to)) ? ' dim' : ''}`,
        })),
    };
  }, [graph, highlight, selected, data]);
  if (error) return <div className="notice error">{error}</div>;
  if (!data || !graph) return <Skeleton rows={6} />;
  if (!graph.nodes.length)
    return <p className="muted-line">No lineage yet: add a dataset sync or a transform.</p>;
  const sel = selected ? data.nodes.find((n) => n.id === selected) : undefined;
  const open = (n: LNode) =>
    n.kind === 'collection'
      ? go({ tab: 'catalog', item: n.name })
      : n.kind === 'transform'
        ? go({ tab: 'transforms', item: n.name })
        : go({ tab: 'syncs' });
  return (
    <div className="lineage">
      <div className="lineage-bar">
        <span className="muted-line">
          {graph.nodes.filter((n) => n.kind === 'sync').length} syncs ·{' '}
          {graph.nodes.filter((n) => n.kind === 'collection').length} collections ·{' '}
          {graph.nodes.filter((n) => n.kind === 'transform').length} transforms. Borders show freshness; hover
          a node for its last run.
        </span>
        {sel && (
          <span className="lineage-selection">
            <strong>{sel.name}</strong>
            <Button variant="secondary" onClick={() => open(sel)}>
              Open {sel.kind}
            </Button>
          </span>
        )}
      </div>
      <div
        className="pipeline-graph"
        style={{
          height: Math.min(height, Math.max(220, Math.max(0, ...flow.nodes.map((n) => n.position.y)) + 150)),
        }}
      >
        <ReactFlow
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ maxZoom: 1, padding: 0.06 }}
          minZoom={0.1}
          nodesConnectable={false}
          onNodeClick={(_, n) => setSelected(n.id === selected ? undefined : n.id)}
          onNodeDoubleClick={(_, n) => {
            const x = data.nodes.find((m) => m.id === n.id);
            if (x) open(x);
          }}
          onPaneClick={() => setSelected(undefined)}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
