// Local-MCP port and capability-path allocation.
//
// Ports are sticky while a profile keeps naming the same DATABASE: assigned once
// from 3335 upward, persisted, and never silently renumbered. A transient
// EADDRINUSE must NOT renumber — the persisted port is referenced by AI-client
// configs the user has already pasted, and renumbering would invalidate them
// without updating those files. Two things move a port, and they differ in
// what survives. An explicit user reassignment changes the port and KEEPS the
// rest (path, autoStart, bridge id), so a pasted bridge entry — which resolves
// the port at run time — keeps working across it. An edit that points the profile
// at another database (dbIdentityKey: host, port, database — see
// profileStore.upsert) discards the allocation whole, and there invalidating
// those configs is exactly what is wanted. An edit that keeps the database but
// changes what it is reached with — the schema list, the stored password, the
// role — keeps the allocation; widening the schema list additionally clears
// autoStart, so the wider set is served only after a deliberate start. 3334 is
// skipped on purpose: it is the kozou CLI's default HTTP port, and a manually
// run `kozou mcp --http` would collide.

import { randomBytes } from 'node:crypto';

export const MCP_PORT_START = 3335;
const MAX_PORT = 65_535;

/** Lowest port >= `start` not already allocated to a profile. Knows only
 *  about persisted allocations, not the OS — an actual bind conflict is
 *  reported as a start failure, never auto-renumbered. */
export function nextFreePort(taken: Iterable<number>, start = MCP_PORT_START): number {
  const used = new Set(taken);
  for (let port = start; port <= MAX_PORT; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error('no free local MCP port available');
}

/** Random 128-bit capability path, e.g. "/mcp-3f2a…". */
export function generateMcpPath(): string {
  return `/mcp-${randomBytes(16).toString('hex')}`;
}

/** Random 128-bit locator id. Unlike the capability path this one is safe to
 *  put in an AI client's config — it names a file, and reading that file
 *  still requires being this user (mode 0600). */
export function generateBridgeId(): string {
  return randomBytes(16).toString('hex');
}

/** Random 64-bit generation: a new value each time a locator is written, so
 *  a stop can recognize whether the file on disk is still its own. */
export function generateLocatorGeneration(): string {
  return randomBytes(8).toString('hex');
}
