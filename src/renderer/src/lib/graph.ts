// Pure graph builder for the semantic map: turns a trimmed SchemaContext into
// nodes and edges for layout. No DOM, no layout engine — unit-testable.
//
// Boundary semantics (two deliberate asymmetries of the compiled context):
//  - Foreign keys pointing outside the profile's configured schemas are
//    silently pruned during introspection and leave no trace — the map's
//    legend states this so absence is not read as "no reference exists".
//  - A view's underlying relations are NOT schema-filtered, so they can
//    reference relations absent from the context. Those become explicit
//    ghost nodes rather than broken edges.

import type { ContextView } from '../../../shared/contextView.js';

export type NodeKind = 'table' | 'view' | 'ghost';

export type GraphNode = {
  id: string; // qualified name
  kind: NodeKind;
  name: string;
  /** First line of the COMMENT, shown as a subtitle under the name. Shown
   *  alongside (not instead of) the name — replacing names with comment text
   *  is the duplication trap the Dashboard already walked back. */
  subtitle: string | null;
  hasAi: boolean;
  hasPolicy: boolean;
  rls: boolean;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: 'fk' | 'lineage';
  /** Human meaning of the relationship: the FK's COMMENT, when present. */
  meaning: string | null;
  /** e.g. "orders.customer_id -> customers.id" for tooltips. */
  detail: string;
};

export type SemanticGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  ghostCount: number;
};

function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text.split('\n', 1)[0]!.trim();
  if (line === '' || line.startsWith('@')) return null;
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

export function buildGraph(ctx: ContextView): SemanticGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  for (const t of ctx.tables) {
    nodes.set(t.qualifiedName, {
      id: t.qualifiedName,
      kind: 'table',
      name: t.qualifiedName,
      subtitle: firstLine(t.description),
      hasAi: Boolean(t.aiDescription),
      hasPolicy: (t.policy ?? []).length > 0,
      rls: t.rowSecurity?.enabled ?? false,
    });
  }
  for (const v of ctx.views) {
    nodes.set(v.qualifiedName, {
      id: v.qualifiedName,
      kind: 'view',
      name: v.qualifiedName,
      subtitle: firstLine(v.description),
      hasAi: Boolean(v.aiDescription),
      hasPolicy: (v.policy ?? []).length > 0,
      rls: false,
    });
  }

  // FK edges: targets always exist in the context (out-of-scope FKs are
  // pruned upstream), so these never dangle.
  for (const t of ctx.tables) {
    for (const r of t.relations) {
      const target = `${r.references.schema}.${r.references.table}`;
      if (!nodes.has(target)) continue; // defensive; upstream pruning should prevent this
      const fields = (r.fields ?? [r.field]).join(', ');
      const refCols = (r.references.columns ?? [r.references.column]).join(', ');
      edges.push({
        id: `fk:${t.qualifiedName}.${fields}->${target}`,
        source: t.qualifiedName,
        target,
        kind: 'fk',
        meaning: r.meaning,
        detail: `${t.name}.${fields} -> ${r.references.table}.${refCols}`,
      });
    }
  }

  // View lineage edges: may reference relations outside the context ->
  // explicit ghost nodes.
  let ghostCount = 0;
  for (const v of ctx.views) {
    for (const u of v.underlyingTables) {
      const target = `${u.schema}.${u.name}`;
      if (!nodes.has(target)) {
        ghostCount++;
        nodes.set(target, {
          id: target,
          kind: 'ghost',
          name: target,
          subtitle: 'outside configured schemas',
          hasAi: false,
          hasPolicy: false,
          rls: false,
        });
      }
      edges.push({
        id: `lineage:${v.qualifiedName}->${target}`,
        source: v.qualifiedName,
        target,
        kind: 'lineage',
        meaning: null,
        detail: `${v.name} reads ${u.name}`,
      });
    }
  }

  return { nodes: [...nodes.values()], edges, ghostCount };
}

/** Rough text-metrics-free node sizing for layout. */
export function nodeSize(node: GraphNode): { width: number; height: number } {
  const longest = Math.max(node.name.length, (node.subtitle ?? '').length * 0.9, 8);
  return {
    width: Math.min(360, Math.round(longest * 7.2 + 56)),
    height: node.subtitle ? 52 : 36,
  };
}
