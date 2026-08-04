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
 *  places — beside the app's own MCP badge under 'local', and on its own under
 *  'remote-only' — and two copies would drift. "(declared)" is not padding:
 *  the app never contacted the remote server, so this is the operator's claim
 *  and must not read as a verified fact. */
export const REMOTE_DECLARED = 'served remotely (declared)';

/** What a profile card says about serving, given the mode and whether this
 *  profile declares a remote MCP server.
 *
 *  Only 'remote-only' says anything. That is what makes it distinguishable from
 *  'off', which is the whole point: no behaviour differs between the two, so
 *  the difference has to be the statement the operator made — declared, or
 *  explicitly not declared.
 *
 *  'off' returns null on purpose, declaration or not. The header reads
 *  "Nobody (off)", and a card that answered "served remotely" underneath it
 *  would contradict the header on the same screen. Under 'off' the app makes no
 *  claim about MCP at all; the declaration is still visible in the profile's
 *  own edit form, and switching to 'remote-only' is what asks the app to report
 *  it. Under 'local' the card's own MCP row already reports the app's server,
 *  and the declaration rides beside it there.
 *
 *  A declaration is the operator's statement, not something the app verified —
 *  hence "(declared)" in the text. */
export function servingNote(mode: McpMode, declared: boolean): CardNote {
  if (mode !== 'remote-only') return null;
  return declared
    ? { text: REMOTE_DECLARED, cls: 'remote' }
    : { text: 'no serving server declared', cls: 'warn' };
}

/** What row access is in force, what it costs, and where it is used.
 *
 *  Stated at every level, 'off' included: that editing carries an approval of
 *  its own is something an operator would otherwise learn only by having
 *  already granted browsing, and a grant that hints at no destination leaves
 *  them with permission and nowhere to use it.
 *
 *  Three things this deliberately does NOT say, each because it would be false:
 *
 *    * that editing comes *after* browsing. The main-owned gate prompts once
 *      per raise in level (main/rowAccessGate.ts), so 'off' → 'readwrite' is a
 *      single approval; the ladder is the order this UI offers, not an
 *      invariant of the gate. What is true at every level is that editing
 *      needs an approval of its own.
 *    * that no row query has ever run. 'off' is the level in force, not a
 *      history: revoking after a browse returns here, and revoking is
 *      prompt-free by design. So the tense is about now, not about the past.
 *    * that rows will be there. The app opens a tab and asks the database; a
 *      revoked privilege, an RLS policy or a dropped column answers with a
 *      refusal, and this app is not the thing that decides.
 *
 *  One thing said at the editing level and nowhere else: that this app offers no
 *  write controls for a view or a table without a primary key. The grant is not
 *  the only thing that governs writing — `canEdit` in DetailPane.svelte also
 *  requires a table and a primary key, and both of those refusals are ours (a
 *  write to a view is answered by kozou with a 405; a table without a primary
 *  key leaves no id to address a row by). Leaving the level's text at "your
 *  database decides what that connection may see or change" would make an
 *  operator who granted editing and then selected a view read our own refusal as
 *  the database's answer. */
export function rowAccessNote(level: RowAccess): string {
  switch (level) {
    case 'readwrite':
      return 'The Data tab of a selected relation reads and writes rows over the connection this profile uses; your database decides what that connection may see or change, and this app offers no write controls for a view or a table without a primary key. Turning this off needs no approval.';
    case 'read':
      return 'The Data tab of a selected relation reads rows over the connection this profile uses; your database decides what it may see. Editing needs an approval of its own.';
    default:
      return 'This app runs no row queries while this is off. Browsing needs your approval, and editing needs an approval of its own.';
  }
}
