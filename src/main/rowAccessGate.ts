// The main-process gate for row-data access.
//
// Two guarantees live here, both deliberately outside the renderer:
//
//   1. Escalation is anchored in a native dialog owned by main. The renderer
//      can only *ask* for a level; a renderer-drawn modal is not a trust
//      anchor, because a compromised renderer could draw its own "approval"
//      and click it. Downgrades need no prompt — losing a capability is
//      always safe — so only a strict escalation prompts.
//   2. Every `data:*` IPC passes assertRowAccess before anything spawns or
//      reaches a data worker. The worker's own capability is fixed at fork
//      time by its environment, so this is the outer half of a deliberate
//      double check, not the only one.
//
// The approval function is injected (the same philosophy as the store's
// Encryptor and the MCP manager's fork) so the whole gate is unit-testable
// without Electron.

import type { RowAccess } from '../shared/types.js';
import { validateRowAccess, type ProfileStore } from './profileStore.js';

/** Asks the user to approve an escalation. Resolves true only on an explicit
 *  approval — anything else (dismissal, close, error surfaced as false) keeps
 *  the stored level. */
export type RowAccessApproval = (request: {
  profile: string;
  level: 'read' | 'readwrite';
  /** The profile's password-free connection URL, so the prompt can name the
   *  database the grant would apply to rather than only the profile. */
  connection: string;
}) => Promise<boolean>;

/** Capability order. Comparing ranks (rather than testing for 'off') keeps
 *  readwrite -> read a prompt-free downgrade. */
const RANK: Record<RowAccess, number> = { off: 0, read: 1, readwrite: 2 };

/** What the user is really approving: which database, reached as which user,
 *  over which schemas. Showing the dialog does not block main's event loop —
 *  the profile handlers keep running, so a compromised renderer can delete
 *  the profile and recreate a different one behind the same name while the
 *  prompt is open. Binding the approval to these facts (not to the name
 *  alone) is what keeps a grant from landing on a record the user never saw.
 *  A password rotation on an otherwise identical URL deliberately does not
 *  count: same server, same database, same role. */
function profileFacts(store: ProfileStore, name: string): { connection: string; identity: string } {
  const p = store.list().find((x) => x.name === name);
  if (p === undefined) throw new Error(`unknown profile "${name}"`);
  return { connection: p.url, identity: JSON.stringify([p.url, p.schemas, p.hasPassword]) };
}

/** Handle a renderer request to change a profile's row-access level.
 *  Returns the level in force afterwards — the unchanged one when the user
 *  declines, so a declined prompt is a normal outcome rather than an error
 *  the renderer has to interpret. */
export async function requestRowAccessChange(
  store: ProfileStore,
  approve: RowAccessApproval,
  name: unknown,
  level: unknown,
): Promise<RowAccess> {
  if (typeof name !== 'string') throw new Error('profile name must be a string');
  // Validate before prompting: junk input must never reach the user as a
  // dialog, let alone the store.
  const next = validateRowAccess(level);
  // Read the stored level at decision time — the renderer's idea of the
  // current level is not an input to this.
  const current = store.rowAccess(name);
  if (next === current) return current;
  // 'off' is the floor, so a change to it is always a downgrade — and a
  // downgrade never needs approval. Above it, approval is required exactly
  // when the request raises the level in force.
  if (next !== 'off' && RANK[next] > RANK[current]) {
    const approved = profileFacts(store, name);
    if (!(await approve({ profile: name, level: next, connection: approved.connection }))) {
      // Re-read rather than report the level captured before the prompt: a
      // concurrent request may have changed it while the dialog was open,
      // and the caller is owed the level actually in force.
      return store.rowAccess(name);
    }
    if (profileFacts(store, name).identity !== approved.identity) {
      throw new Error(`profile "${name}" changed while its approval was open; no row access was granted`);
    }
  }
  return store.setRowAccess(name, next);
}

/** Guard every `data:*` handler: throws unless the profile is opted in at
 *  (at least) the level the operation needs. Returns the level in force so a
 *  caller can branch on read vs readwrite without a second store read. */
export function assertRowAccess(store: ProfileStore, name: string, need: 'read' | 'readwrite'): RowAccess {
  if (typeof name !== 'string') throw new Error('profile name must be a string');
  // Fail closed even when a caller computes `need` instead of writing a
  // literal: an unrecognized level would otherwise compare as satisfied and
  // wave the operation through.
  if (need !== 'read' && need !== 'readwrite') {
    throw new Error('required row access must be "read" or "readwrite"');
  }
  const current = store.rowAccess(name);
  if (RANK[current] < RANK[need]) {
    throw new Error(`row ${need} access is not enabled for profile "${name}"`);
  }
  return current;
}
