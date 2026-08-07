// The words the app uses for three things an operator has to be able to read
// off the screen without opening anything: whether profiles may serve MCP at
// all, what a profile's own MCP server is doing, and what row access is in
// force.
//
// One surface, one claim — learned the hard way. The permission used to be
// answered in the header, above cards reporting per-profile state, and the
// header's answer was read as state: "MCP served by: Nobody (off)" and its
// replacement "This app may serve MCP: No" both invited "so is MCP running?",
// which the value cannot answer because it counts nothing. Rewording it a third
// time was not the fix. The permission now lives in Settings, where it is asked
// as a permission and nothing in the header speaks for it; what is running is
// said only where that profile is described — the card in the all-databases
// view, or the bar above the workspace while that profile is the one selected.
// Those two are one component (McpBlock.svelte), and never both on screen.
//
// Kept here as pure functions and constants so the copy is unit-testable: a
// claim drifting back onto the wrong surface is exactly the kind of thing that
// regresses silently in markup.

import type { McpServerStatus, RowAccess } from '../../../shared/types.js';

/** The Settings control's label. It names what the permission decides — that a
 *  profile is *allowed* to start a server — and deliberately not what any
 *  server is doing: a profile can be stopped, starting or up, and this label
 *  reads the same in all three cases. */
export const MCP_ALLOW_LABEL = 'Allow profiles to serve MCP on loopback';

/** The one line under that control, which says what switching it on does NOT
 *  do — the part a reader gets wrong. Turning it on serves nothing; a profile
 *  starts its own server, one at a time. The second sentence is what turning it
 *  off means, in the terms this app can keep: the servers are asked to stop,
 *  not made to (see `mcpStopWarning`). */
export const MCP_ALLOW_NOTE =
  "Nothing listens until you start a profile's server, one profile at a time. Turning this off asks every server that is up to stop, and refuses further starts.";

/** What a profile's MCP row says while no profile may run a server.
 *  "not allowed" rather than "off": 'off' reads as a state a server is in, and
 *  this row is about a server that cannot be started yet. It names the surface
 *  that owns the permission because the row cannot change it. */
export const MCP_NOT_ALLOWED = 'MCP not allowed - see Settings';

/** The confirmation shown when the permission is withdrawn while servers are
 *  up. Two things it deliberately does not say, both because they would be
 *  false:
 *
 *    * that the servers will stop. `UtilityProcess.kill()`'s failure result is
 *      ignored and the wait gives up after three seconds, so a child that
 *      refuses to die leaves a listener behind. They are *asked*.
 *    * that they are all "running". The count its caller passes includes
 *      'starting' — a server whose listener has not been confirmed yet — so
 *      naming only the confirmed ones would undercount what the click affects.
 *      The word follows the count rather than the count following the word. */
export function mcpStopWarning(count: number): string {
  return `turn this off? ${count} server${count === 1 ? '' : 's'} running or starting will be asked to stop.`;
}

/** Named for the card, which was the only surface that carried these notes when
 *  this file was written; the profile bar now renders the same ones. */
export type CardNote = { text: string; cls: string } | null;

/** The declaration badge's text. "(declared)" is not padding: the app never
 *  contacted that server, so this reports what the operator recorded and must
 *  not read as something this app checked. A declaration is valid with no URL
 *  at all, so there is not even an address to have checked. */
export const REMOTE_DECLARED = 'served remotely (declared)';

/** What a profile's row says about a remote server serving its database.
 *
 *  Mode-independent by construction — it takes the declaration and nothing
 *  else. What something else serves does not stop being what the operator
 *  recorded when this app is not allowed to serve, and taking no mode argument
 *  is what keeps that from being re-decided per branch: the badge used to be
 *  rendered from two places under two modes, which is how the app ended up
 *  saying different things about the same declaration depending on a setting
 *  that has nothing to do with it.
 *
 *  No declaration returns null, because silence is not a claim. Saying "no
 *  serving server declared" made the row speak about a database it knows
 *  nothing about: an operator not having recorded anything is not evidence that
 *  nothing serves it. */
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

/** The line under the AI-client config snippets that says why connecting may not
 *  work yet, or null when the server is up and there is nothing to warn about.
 *
 *  Branched on the status because one sentence for everything was false in a
 *  reachable state: the panel stays open when a start fails, and
 *  "server currently stopped - start it before connecting" then contradicted the
 *  badge beside it ("MCP port busy") and sent the operator to do the one thing
 *  that cannot work — a start re-fails while a foreign process holds the port,
 *  and the way out is to move the port. `blocked-duplicate` is the same shape:
 *  starting was refused, not attempted, so "start it" understates what it takes.
 *
 *  Nothing here says the port is free, or that the other process is malicious, or
 *  what it is: the app knows only that its own bind failed. */
export function snippetServerNote(status: McpServerStatus | undefined): string | null {
  switch (status) {
    case 'running':
      return null;
    case 'error-port-busy':
      return 'another process is on this port - this profile cannot serve until you move its port, so this config would point your client at something else';
    case 'blocked-duplicate':
      return 'this profile is not serving - starting it was refused because a remote MCP server is declared for the same database';
    default:
      return 'server currently stopped - start it before connecting';
  }
}
