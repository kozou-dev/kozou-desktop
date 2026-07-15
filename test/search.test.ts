import { describe, expect, it } from 'vitest';
import type { ContextView } from '../src/shared/contextView.js';
import { searchContexts } from '../src/renderer/src/lib/search.js';

const table = (over: Record<string, unknown>): ContextView['tables'][number] =>
  ({
    schema: 'public',
    name: 'x',
    qualifiedName: 'public.x',
    label: 'x',
    description: null,
    aiDescription: null,
    primaryKey: [],
    columns: [],
    relations: [],
    ...over,
  }) as ContextView['tables'][number];

const ctx = (tables: ContextView['tables']): ContextView => ({
  meta: { serverVersion: 'x', builtAt: 'x', sourceSchemas: ['public'] },
  tables,
  views: [],
  enums: [],
  concepts: [],
  functions: [],
});

const contexts = {
  sales: ctx([
    table({ name: 'customers', qualifiedName: 'public.customers', label: 'customers', description: 'People who buy things.' }),
    table({ name: 'orders', qualifiedName: 'public.orders', aiDescription: '@ai: total_cents is in cents' }),
  ]),
  billing: ctx([table({ name: 'invoices', qualifiedName: 'public.invoices', label: 'Invoices' })]),
};

describe('searchContexts', () => {
  it('needs at least two characters', () => {
    expect(searchContexts(contexts, 'a').hits).toEqual([]);
    expect(searchContexts(contexts, ' ').hits).toEqual([]);
  });

  it('matches by name across profiles', () => {
    const { hits } = searchContexts(contexts, 'invoi');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ profile: 'billing', id: 'public.invoices', matchedIn: 'name' });
  });

  it('matches @ai content and reports the matched field', () => {
    const { hits } = searchContexts(contexts, 'cents');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ profile: 'sales', id: 'public.orders', matchedIn: '@ai' });
    expect(hits[0]!.snippet).toContain('cents');
  });

  it('matches comment text', () => {
    const { hits } = searchContexts(contexts, 'buy things');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'public.customers', matchedIn: 'comment' });
  });

  it('ranks name matches ahead of comment/@ai matches', () => {
    const mixed = {
      p: ctx([
        table({ name: 'audit', qualifiedName: 'public.audit', description: 'notes about the money flow' }),
        table({ name: 'money', qualifiedName: 'public.money', label: 'money' }),
      ]),
    };
    const { hits } = searchContexts(mixed, 'money');
    expect(hits[0]!.matchedIn).toBe('name');
    expect(hits[0]!.id).toBe('public.money');
  });
});
