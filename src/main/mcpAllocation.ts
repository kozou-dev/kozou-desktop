// Local-MCP port and capability-path allocation.
//
// Ports are sticky: assigned once from 3335 upward, persisted, and only
// changed by an explicit user reassignment. A transient EADDRINUSE must NOT
// silently renumber — the persisted port is referenced by AI-client configs
// the user has already pasted, and renumbering would invalidate them without
// updating those files. 3334 is skipped on purpose: it is the kozou CLI's
// default HTTP port, and a manually run `kozou mcp --http` would collide.

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
