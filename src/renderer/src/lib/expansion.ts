// Whether the detail pane is currently given the whole workspace, collapsing
// the map. Pure so the one invariant that matters here can be pinned by a test:
// the map is collapsed only when the pane renders the control that puts it back.
//
// That control lives in the pane's tab row, and the pane renders the tab row
// only for a relation it resolved in the context on screen. Collapse for
// anything else and the workspace holds one explanatory sentence and no exit.

import type { ContextView } from '../../../shared/contextView.js';

/** Does this selection name a relation of the context on screen? The same
 *  question `DetailPane` answers with `table ?? view` — and the reason it can
 *  come out false while a selection is set:
 *
 *    * a ghost — an outside-schema table a view reads from. It is a real,
 *      clickable node on the map, and the pane explains it instead of
 *      describing it, so there is no tab row;
 *    * a stale selection — a re-inspect of the same profile keeps the selection
 *      while the relation may be gone from the new context (dropped, or its
 *      schema no longer configured).
 */
export function selectionResolves(context: ContextView | null, selected: string | null): boolean {
  if (context === null || selected === null) return false;
  return (
    context.tables.some((t) => t.qualifiedName === selected) ||
    context.views.some((v) => v.qualifiedName === selected)
  );
}

/** The operator's expansion intent as it actually applies to the layout. The
 *  intent itself outlives every false answer here, so returning to a relation
 *  returns to the width they last chose. */
export function expansionApplies(args: {
  /** The intent, which the app keeps whether or not it currently applies. */
  expanded: boolean;
  profile: string | null;
  context: ContextView | null;
  selected: string | null;
}): boolean {
  return (
    args.expanded && args.profile !== null && selectionResolves(args.context, args.selected)
  );
}
