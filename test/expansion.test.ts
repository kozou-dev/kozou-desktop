import { describe, expect, it } from 'vitest';
import type { ContextView } from '../src/shared/contextView.js';
import { expansionApplies, selectionResolves } from '../src/renderer/src/lib/expansion.js';

/** A context holding one table and one view, and nothing else that matters here. */
const context = {
  tables: [{ qualifiedName: 'public.customers' }],
  views: [{ qualifiedName: 'public.recent_orders' }],
} as unknown as ContextView;

const applies = (over: Partial<Parameters<typeof expansionApplies>[0]> = {}): boolean =>
  expansionApplies({
    expanded: true,
    profile: 'p',
    context,
    selected: 'public.customers',
    ...over,
  });

describe('selectionResolves', () => {
  it('answers for a table and for a view', () => {
    expect(selectionResolves(context, 'public.customers')).toBe(true);
    expect(selectionResolves(context, 'public.recent_orders')).toBe(true);
  });

  it('is false for a name this context does not hold', () => {
    // A ghost (an outside-schema table a view reads from) and a stale selection
    // both look like this from here: set, and not a relation on screen.
    expect(selectionResolves(context, 'private.ledger')).toBe(false);
    expect(selectionResolves(context, 'public.dropped')).toBe(false);
  });

  it('is false with nothing selected, and with no context yet', () => {
    expect(selectionResolves(context, null)).toBe(false);
    expect(selectionResolves(null, 'public.customers')).toBe(false);
  });
});

describe('expansionApplies', () => {
  it('applies for a relation the context holds', () => {
    expect(applies()).toBe(true);
    expect(applies({ selected: 'public.recent_orders' })).toBe(true);
  });

  it('does not apply without the intent', () => {
    expect(applies({ expanded: false })).toBe(false);
  });

  // The invariant this module exists for. The pane renders its tab row - and so
  // the control that puts the map back - only for a relation it resolved. If the
  // map collapsed for anything else, the workspace would hold one explanatory
  // sentence and no way back to the map.
  it('does not apply for a ghost, a stale selection, or no selection', () => {
    expect(applies({ selected: 'private.ledger' })).toBe(false);
    expect(applies({ selected: 'public.dropped' })).toBe(false);
    expect(applies({ selected: null })).toBe(false);
  });

  it('does not apply before a context has arrived, or with no profile', () => {
    // Mid-inspect and inspect-failure: a selection can outlive the context that
    // explained it, and the map must not be collapsed for a pane showing neither.
    expect(applies({ context: null })).toBe(false);
    expect(applies({ profile: null })).toBe(false);
  });
});
