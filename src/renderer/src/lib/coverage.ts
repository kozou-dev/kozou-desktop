// Annotation coverage: how much of the schema carries human/AI meaning.
// Pure and unit-testable.

import type { ContextView } from '../../../shared/contextView.js';

export type Coverage = {
  relationCount: { tables: number; views: number; functions: number };
  /** Fraction of tables+views with a description or @ai annotation (0..1). */
  relations: number;
  /** Fraction of all columns with a description (0..1). */
  columns: number;
};

export function computeCoverage(ctx: ContextView): Coverage {
  const rels = [...ctx.tables, ...ctx.views];
  const annotated = rels.filter((r) => Boolean(r.description) || Boolean(r.aiDescription)).length;
  const allColumns = rels.flatMap((r) => r.columns);
  const annotatedColumns = allColumns.filter((c) => Boolean(c.description)).length;
  return {
    relationCount: {
      tables: ctx.tables.length,
      views: ctx.views.length,
      functions: (ctx.functions ?? []).length,
    },
    relations: rels.length === 0 ? 0 : annotated / rels.length,
    columns: allColumns.length === 0 ? 0 : annotatedColumns / allColumns.length,
  };
}
