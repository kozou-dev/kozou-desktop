import { describe, expect, it } from 'vitest';
import { trimContext } from '../src/shared/trim.js';

describe('trimContext', () => {
  it('strips raw catalog records from tables/views/functions', () => {
    const ctx = {
      meta: { builtAt: 'x' },
      tables: [{ name: 't', columns: [], rawTable: { comment: null, columns: [] } }],
      views: [{ name: 'v', rawView: { comment: null, definition: 'SELECT 1' } }],
      functions: [{ name: 'f', rawFunction: { src: '...' } }],
      enums: [{ name: 'e' }],
    };
    const out = trimContext(ctx);
    expect((out.tables as Record<string, unknown>[])[0]).toEqual({
      name: 't',
      columns: [],
      rawComment: null,
    });
    expect((out.views as Record<string, unknown>[])[0]).toEqual({ name: 'v', rawComment: null });
    expect((out.functions as Record<string, unknown>[])[0]).toEqual({ name: 'f' });
    // Untouched sections pass through.
    expect(out.enums).toEqual(ctx.enums);
    expect(out.meta).toEqual(ctx.meta);
    // Input is not mutated.
    expect(ctx.tables[0]).toHaveProperty('rawTable');
  });

  it('tolerates a context without a functions array (pre-1.4 shape)', () => {
    const out = trimContext({ tables: [], views: [] });
    expect(out.functions).toBeUndefined();
  });

  describe('verbatim comments', () => {
    // What makes this load-bearing: `description` is a PROCESSED form —
    // `@widget:`/`@example:` are lifted out of it by the context builder — so a
    // comment editor seeded from it would delete those tags on the first save.
    // The verbatim text exists only inside the raw records.
    const ctx = {
      tables: [
        {
          name: 'customers',
          description: 'People.',
          columns: [
            { name: 'email', description: 'Contact.' },
            { name: 'id', description: null },
            { name: 'ghost', description: 'not in the raw record' },
          ],
          rawTable: {
            comment: 'People.\n@ai: one row per customer',
            columns: [
              // Deliberately in a different order than the context's columns:
              // the lift matches by name, never by position.
              { name: 'id', comment: null },
              { name: 'email', comment: 'Contact.\n@widget: text' },
            ],
          },
        },
      ],
      views: [
        {
          name: 'recent',
          qualifiedName: 'public.recent',
          columns: [],
          rawView: { comment: 'Recent.\n@example: q\n  SELECT 1;' },
        },
      ],
    };

    it('lifts the table, view and column comments verbatim', () => {
      const out = trimContext(ctx);
      const table = (out.tables as Record<string, unknown>[])[0]!;
      expect(table.rawComment).toBe('People.\n@ai: one row per customer');
      const columns = table.columns as Record<string, unknown>[];
      expect(columns[0]).toEqual({
        name: 'email',
        description: 'Contact.',
        rawComment: 'Contact.\n@widget: text',
      });
      expect(columns[1]!.rawComment).toBeNull();
      // A column with no counterpart in the raw record gets no claim at all —
      // absent is not the same as "no comment".
      expect(columns[2]).not.toHaveProperty('rawComment');

      expect((out.views as Record<string, unknown>[])[0]!.rawComment).toBe(
        'Recent.\n@example: q\n  SELECT 1;',
      );
    });

    it('does not mutate the input', () => {
      trimContext(ctx);
      expect(ctx.tables[0]!.columns[0]).not.toHaveProperty('rawComment');
      expect(ctx.tables[0]).toHaveProperty('rawTable');
    });

    it('says nothing about a comment when there is no raw record to read', () => {
      const out = trimContext({ tables: [{ name: 't', columns: [{ name: 'c' }] }], views: [] });
      const table = (out.tables as Record<string, unknown>[])[0]!;
      expect(table).not.toHaveProperty('rawComment');
      expect((table.columns as Record<string, unknown>[])[0]).not.toHaveProperty('rawComment');
    });
  });

  describe('materialized views', () => {
    const ctx = {
      tables: [],
      views: [
        { schema: 'public', name: 'plain', qualifiedName: 'public.plain', rawView: { comment: null } },
        { schema: 'public', name: 'snap', qualifiedName: 'public.snap', rawView: { comment: null } },
      ],
    };

    it('marks each view when the relkind was established', () => {
      const out = trimContext(ctx, { materializedViews: [{ schema: 'public', name: 'snap' }] });
      const views = out.views as Record<string, unknown>[];
      expect(views[0]!.materialized).toBe(false);
      expect(views[1]!.materialized).toBe(true);
    });

    it('marks every view false when the query found none', () => {
      const views = trimContext(ctx, { materializedViews: [] }).views as Record<string, unknown>[];
      expect(views.map((v) => v.materialized)).toEqual([false, false]);
    });

    it('does not confuse two relations that share a qualified name', () => {
      // A dot is legal inside a quoted identifier, so `schema.name` is not an
      // identity. Measured against a real database: matching on it marked the
      // ordinary view `"sales"."archive.rollup"` materialized, because the
      // MATERIALIZED view `"sales.archive"."rollup"` joins to the same string —
      // and the app then emitted DDL PostgreSQL rejects.
      const ambiguous = {
        tables: [],
        views: [
          {
            schema: 'sales',
            name: 'archive.rollup',
            qualifiedName: 'sales.archive.rollup',
            rawView: { comment: null },
          },
          {
            schema: 'sales.archive',
            name: 'rollup',
            qualifiedName: 'sales.archive.rollup',
            rawView: { comment: null },
          },
        ],
      };
      const views = trimContext(ambiguous, {
        materializedViews: [{ schema: 'sales.archive', name: 'rollup' }],
      }).views as Record<string, unknown>[];
      expect(views[0]!.materialized).toBe(false);
      expect(views[1]!.materialized).toBe(true);
    });

    it('leaves every view unmarked when the relkind is unknown', () => {
      // The important half. `COMMENT ON VIEW` is an error against a materialized
      // view and `COMMENT ON MATERIALIZED VIEW` is an error against an ordinary
      // one, so "we could not tell" must not arrive as "ordinary" — the UI
      // refuses to offer a statement rather than emit a guess.
      const views = trimContext(ctx).views as Record<string, unknown>[];
      for (const view of views) expect(view).not.toHaveProperty('materialized');
    });
  });
});
