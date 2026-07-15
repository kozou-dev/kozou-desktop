import { describe, expect, it } from 'vitest';
import type { ContextView } from '../src/shared/contextView.js';
import { buildGraph } from '../src/renderer/src/lib/graph.js';
import { computeCoverage } from '../src/renderer/src/lib/coverage.js';

const table = (over: Record<string, unknown>): ContextView['tables'][number] =>
  ({
    schema: 'public',
    name: 'x',
    qualifiedName: 'public.x',
    label: 'x',
    description: null,
    aiDescription: null,
    primaryKey: ['id'],
    columns: [],
    relations: [],
    ...over,
  }) as ContextView['tables'][number];

const view = (over: Record<string, unknown>): ContextView['views'][number] =>
  ({
    schema: 'public',
    name: 'v',
    qualifiedName: 'public.v',
    label: 'v',
    description: null,
    aiDescription: null,
    purpose: null,
    columns: [],
    underlyingTables: [],
    ...over,
  }) as ContextView['views'][number];

const ctx = (over: Partial<ContextView>): ContextView => ({
  meta: { serverVersion: 'x', builtAt: 'x', sourceSchemas: ['public'] },
  tables: [],
  views: [],
  enums: [],
  concepts: [],
  functions: [],
  ...over,
});

describe('buildGraph', () => {
  it('builds FK edges with fields and meaning', () => {
    const g = buildGraph(
      ctx({
        tables: [
          table({ name: 'orders', qualifiedName: 'public.orders', relations: [
            {
              field: 'customer_id',
              fields: ['customer_id'],
              references: { schema: 'public', table: 'customers', column: 'id' },
              cardinality: 'many-to-one',
              meaning: 'The customer who placed this order.',
            },
          ] }),
          table({ name: 'customers', qualifiedName: 'public.customers' }),
        ],
      }),
    );
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['public.customers', 'public.orders']);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({
      kind: 'fk',
      source: 'public.orders',
      target: 'public.customers',
      meaning: 'The customer who placed this order.',
    });
    expect(g.ghostCount).toBe(0);
  });

  it('creates ghost nodes for view dependencies outside the context', () => {
    const g = buildGraph(
      ctx({
        views: [
          view({
            underlyingTables: [
              { schema: 'public', name: 'known' },
              { schema: 'billing', name: 'invoices' },
            ],
          }),
        ],
        tables: [table({ name: 'known', qualifiedName: 'public.known' })],
      }),
    );
    const ghost = g.nodes.find((n) => n.kind === 'ghost');
    expect(ghost).toMatchObject({ id: 'billing.invoices', subtitle: 'outside configured schemas' });
    expect(g.ghostCount).toBe(1);
    expect(g.edges.filter((e) => e.kind === 'lineage')).toHaveLength(2);
  });

  it('derives subtitles from the first COMMENT line, skipping tag-only comments', () => {
    const g = buildGraph(
      ctx({
        tables: [
          table({ description: 'People who buy from the store.\n@ai: details' }),
          table({
            name: 'y',
            qualifiedName: 'public.y',
            description: '@ai: tag-only comment',
          }),
          table({ name: 'z', qualifiedName: 'public.z', description: 'a'.repeat(80) }),
        ],
      }),
    );
    expect(g.nodes[0]!.subtitle).toBe('People who buy from the store.');
    expect(g.nodes[1]!.subtitle).toBeNull();
    expect(g.nodes[2]!.subtitle!.length).toBeLessThanOrEqual(60);
    expect(g.nodes[2]!.subtitle!.endsWith('...')).toBe(true);
  });

  it('keeps edge ids unique for duplicate FK constraints (same columns, same target)', () => {
    const relation = {
      field: 'customer_id',
      fields: ['customer_id'],
      references: { schema: 'public', table: 'customers', column: 'id' },
      cardinality: 'many-to-one',
      meaning: null,
    };
    const g = buildGraph(
      ctx({
        tables: [
          table({ name: 'orders', qualifiedName: 'public.orders', relations: [relation, { ...relation }] }),
          table({ name: 'customers', qualifiedName: 'public.customers' }),
        ],
      }),
    );
    expect(g.edges).toHaveLength(2);
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(2);
  });

  it('sets badges from @ai/@policy/rowSecurity', () => {
    const g = buildGraph(
      ctx({
        tables: [
          table({
            aiDescription: '@ai: x',
            policy: ['no'],
            rowSecurity: { enabled: true, forced: false, hasPolicies: true },
          }),
        ],
      }),
    );
    expect(g.nodes[0]).toMatchObject({ hasAi: true, hasPolicy: true, rls: true });
  });
});

describe('computeCoverage', () => {
  it('computes relation and column annotation fractions (columns count @ai too)', () => {
    const cov = computeCoverage(
      ctx({
        tables: [
          table({
            description: 'annotated',
            columns: [
              { name: 'a', dataType: 't', nullable: true, isPrimaryKey: false, isForeignKey: false, label: 'a', description: 'yes' },
              { name: 'b', dataType: 't', nullable: true, isPrimaryKey: false, isForeignKey: false, label: 'b', description: null },
              { name: 'c', dataType: 't', nullable: true, isPrimaryKey: false, isForeignKey: false, label: 'c', description: null, aiDescription: '@ai only' },
            ],
          }),
          table({ name: 'y', qualifiedName: 'public.y' }),
        ],
        views: [view({ aiDescription: '@ai: v' })],
      }),
    );
    expect(cov.relationCount).toEqual({ tables: 2, views: 1, functions: 0 });
    expect(cov.relations).toBeCloseTo(2 / 3);
    expect(cov.columns).toBeCloseTo(2 / 3);
  });
});
