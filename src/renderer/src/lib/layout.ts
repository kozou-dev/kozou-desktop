// elk layout for the semantic map. Runs on the UI thread: the packaged app
// loads over file://, where Chromium refuses to start module workers loaded
// from file URLs, and MVP graphs (tens of nodes) lay out in milliseconds.
// If real schemas make layout noticeable, the viable offload path is elkjs's
// Blob-URL workerFactory (works under file://; needs `worker-src blob:` in
// the CSP) — recorded here so the revisit starts from the right option.

import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import type { GraphEdge, GraphNode } from './graph.js';
import { nodeSize } from './graph.js';

export type PositionedNode = GraphNode & { x: number; y: number; width: number; height: number };
export type RoutedEdge = GraphEdge & { points: { x: number; y: number }[] };
export type LayoutResult = {
  nodes: PositionedNode[];
  edges: RoutedEdge[];
  width: number;
  height: number;
};

const elk = new ELK();

export async function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): Promise<LayoutResult> {
  const elkGraph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.spacing.nodeNode': '28',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children: nodes.map((n) => ({ id: n.id, ...nodeSize(n) })),
    edges: edges.map((ed) => ({ id: ed.id, sources: [ed.source], targets: [ed.target] })),
  };

  const laid = await elk.layout(elkGraph);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const positioned: PositionedNode[] = (laid.children ?? []).map((c) => ({
    ...byId.get(c.id)!,
    x: c.x ?? 0,
    y: c.y ?? 0,
    width: c.width ?? 120,
    height: c.height ?? 36,
  }));
  const edgeById = new Map(edges.map((ed) => [ed.id, ed]));
  const routed: RoutedEdge[] = ((laid.edges ?? []) as ElkExtendedEdge[]).map((ee) => {
    const sections = ee.sections ?? [];
    const points = sections.flatMap((s) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]);
    return { ...edgeById.get(ee.id)!, points };
  });

  return {
    nodes: positioned,
    edges: routed,
    width: (laid.width ?? 800) + 40,
    height: (laid.height ?? 600) + 40,
  };
}
