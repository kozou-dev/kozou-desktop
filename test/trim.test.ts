import { describe, expect, it } from 'vitest';
import { trimContext } from '../src/shared/trim.js';

describe('trimContext', () => {
  it('strips raw catalog records from tables/views/functions', () => {
    const ctx = {
      meta: { builtAt: 'x' },
      tables: [{ name: 't', columns: [], rawTable: { big: 'blob' } }],
      views: [{ name: 'v', rawView: { definition: 'SELECT 1' } }],
      functions: [{ name: 'f', rawFunction: { src: '...' } }],
      enums: [{ name: 'e' }],
    };
    const out = trimContext(ctx);
    expect((out.tables as Record<string, unknown>[])[0]).toEqual({ name: 't', columns: [] });
    expect((out.views as Record<string, unknown>[])[0]).toEqual({ name: 'v' });
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
});
