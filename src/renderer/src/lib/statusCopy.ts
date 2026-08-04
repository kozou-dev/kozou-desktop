// The words the app uses for two states an operator has to be able to read off
// the screen without opening anything: whether this app serves MCP, and what row
// access is in force.
//
// Both were legible only to someone who already knew the design. The MCP setting
// was a bare "MCP" label over Off / Local / Remote only, which named the setting
// rather than its effect. Naming the effect then exposed the real problem: the
// third mode branched no behaviour at all (every branch is `=== 'local'` /
// `!== 'local'`), so "remote servers only" was a label over nothing, and the
// first person to use a build could not tell what choosing it would do. It is
// gone. The question is now about this app alone, and a profile's declaration
// that something else serves its database stands on its own. Row access showed a
// level badge and an "enable browsing" link, and said nothing about what the
// approval covers, that editing is a second approval, or where rows then appear.
//
// Kept here as pure functions so the copy is unit-testable: prose that regresses
// silently in markup is exactly what belongs behind a test.

import type { McpMode, RowAccess } from '../../../shared/types.js';

/** The answer to "MAY this app serve MCP", named by its effect rather than by the
 *  setting's internal value.
 *
 *  Permission, not observed state. 'local' allows a profile to start a server; it
 *  starts none by itself, and every card reads `MCP off` until you start one. An
 *  answer phrased as "yes, serving" would contradict those cards on the same
 *  screen — the first draft of this said exactly that, and the e2e test one line
 *  below the mode switch asserts `MCP off`.
 *
 *  The question is also about this app alone. An earlier version asked *who*
 *  serves and offered "remote servers only" as a third answer, which was a
 *  mistake twice over: the mode changed nothing, and answering "nobody" while a
 *  card underneath reported a declared remote server was another contradiction
 *  the same screen could print. What something else serves is reported by
 *  `servingNote`, per profile, independently of this. */
export function mcpModeLabel(mode: McpMode): string {
  return mode === 'local' ? 'Yes, one per profile' : 'No';
}

export type CardNote = { text: string; cls: string } | null;

/** The declaration badge's text. Shared because it is rendered from two
 *  places — beside the app's own MCP badge when this app serves, and on its own
 *  when it does not — and two copies would drift. "(declared)" is not padding:
 *  the app never contacted the remote server, so this is the operator's claim
 *  and must not read as a verified fact. A declaration is valid with no URL at
 *  all, so there is not even an address to have checked. */
export const REMOTE_DECLARED = 'served remotely (declared)';

/** What a profile card says about a remote server serving its database.
 *
 *  Only a declaration says anything, and it says it whatever this app's own mode
 *  is. The two are independent facts: hiding the declaration while this app is
 *  off would mean a card silently changes what it claims about someone else's
 *  server when you flip a setting about ours.
 *
 *  A profile with no declaration says nothing, rather than "none declared". That
 *  is the common case, and printing it on every card would make the quiet state
 *  the loud one. The absence is also visible where it is set — the profile's own
 *  edit form — which is where a reader goes to change it.
 *
 *  Takes only the declaration, not the mode. It used to take both, because the
 *  note existed to tell 'remote-only' apart from 'off'; with that mode gone the
 *  mode is not part of the question. */
export function servingNote(declared: boolean): CardNote {
  return declared ? { text: REMOTE_DECLARED, cls: 'remote' } : null;
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
