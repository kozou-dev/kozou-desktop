// The words the app uses for two states an operator has to be able to read off
// the screen without opening anything: who serves MCP, and what row access is
// in force.
//
// Both were legible only to someone who already knew the design. The MCP mode
// was a bare "MCP" label over Off / Local / Remote only, which named the
// setting rather than its effect — and because no behaviour branches on
// 'remote-only' (every branch is `=== 'local'` / `!== 'local'`), that mode was
// indistinguishable from 'off' on screen. Row access showed a level badge and
// an "enable browsing" link, and said nothing about what the approval covers,
// that editing is a second approval, or where rows then appear.
//
// Kept here as pure functions so the copy is unit-testable: the claim that two
// modes are distinguishable is exactly the kind of thing that regresses
// silently in markup.

import type { McpMode, RowAccess } from '../../../shared/types.js';

/** The mode named by its effect — who serves MCP for the databases in this
 *  app — rather than by the setting's internal value. 'remote-only' says
 *  "remote servers only" because the app itself serves nothing in that mode;
 *  what it adds over 'off' is the operator's statement that something else
 *  does, which `servingNote` then shows per profile. */
export function mcpModeLabel(mode: McpMode): string {
  switch (mode) {
    case 'local':
      return 'This app (local)';
    case 'remote-only':
      return 'Remote servers only';
    default:
      return 'Nobody (off)';
  }
}

export type CardNote = { text: string; cls: string } | null;

/** The declaration badge's text. Shared because it is rendered from two
 *  places — beside the app's own MCP badge under 'local', and on its own for
 *  the other modes — and two copies would drift. "(declared)" is not padding:
 *  the app never contacted the remote server, so this is the operator's claim
 *  and must not read as a verified fact. */
export const REMOTE_DECLARED = 'served remotely (declared)';

/** What a profile card says about serving, given the mode and whether this
 *  profile declares a remote MCP server.
 *
 *  The load-bearing case is 'remote-only' with no declaration. Without it the
 *  card renders identically under 'off' and 'remote-only', which is how the
 *  two modes came to be indistinguishable: the app claims nothing serves this
 *  database, and it should say so rather than leave a blank where a statement
 *  belongs.
 *
 *  A declaration is the operator's statement, not something the app verified —
 *  hence "(declared)" in the text. Under 'local' this returns null: the card's
 *  own MCP row already reports the app's server. */
export function servingNote(mode: McpMode, declared: boolean): CardNote {
  if (mode === 'local') return null;
  if (declared) return { text: REMOTE_DECLARED, cls: 'remote' };
  if (mode === 'remote-only') return { text: 'no serving server declared', cls: 'warn' };
  return null;
}

/** What row access is in force, what it took, and where the rows appear.
 *
 *  Stated at every level, including 'off': the ladder has to be visible before
 *  its first step is taken, or "editing is a second approval" is something an
 *  operator only learns by having already granted browsing. And a grant that
 *  offers no hint where rows show up leaves the operator with permission and
 *  nowhere to use it. */
export function rowAccessNote(level: RowAccess): string {
  switch (level) {
    case 'readwrite':
      return 'Rows are on the Data tab of a selected relation; edits run against your database over the connection this profile uses. Turning this off needs no approval.';
    case 'read':
      return 'Rows are on the Data tab of a selected relation, read-only. Editing them is a second, separate approval.';
    default:
      return 'This app runs no row queries yet. Browsing asks for your approval first; editing is a second, separate approval after that.';
  }
}
