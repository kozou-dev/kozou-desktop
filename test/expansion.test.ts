import { describe, expect, it } from 'vitest';
import type { ContextView } from '../src/shared/contextView.js';
import {
  bottomPanelShown,
  expansionApplies,
  selectionResolves,
} from '../src/renderer/src/lib/expansion.js';

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

describe('bottomPanelShown', () => {
  it('shows an open panel the row still offers', () => {
    expect(bottomPanelShown('enums', ['functions', 'enums'])).toBe('enums');
    expect(bottomPanelShown('drafts', ['drafts'])).toBe('drafts');
  });

  it('shows nothing when nothing is open', () => {
    expect(bottomPanelShown(null, ['drafts', 'enums'])).toBe(null);
  });

  // The same invariant as `expansionApplies`, reached from the other side: an open
  // panel collapses the pane row, so the row below it is the only way back. A panel
  // the row no longer offers has no button, and its body has nothing in it - the
  // workspace would hold an empty box and no way out.
  it('shows nothing when what was open is no longer offered', () => {
    // The drafts were cleared while their panel was open.
    expect(bottomPanelShown('drafts', ['functions', 'enums'])).toBe(null);
    // Another profile was inspected, and this one exposes no functions.
    expect(bottomPanelShown('functions', ['enums'])).toBe(null);
    // Nothing left to offer at all.
    expect(bottomPanelShown('enums', [])).toBe(null);
  });
});
