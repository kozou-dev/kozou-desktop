// The bridge locator: a projection of one running local MCP server, and the
// only file the stdio bridge is allowed to read.
//
// Why a dedicated file rather than the profile store: the bridge must reach a
// server without ever holding database credentials, and profiles.json is read
// whole (it carries the encrypted password blob for every profile). A locator
// carries four facts — an opaque id, the port, the capability path, and a
// generation — and nothing else. The parser below enforces that shape in the
// strictest direction available: an UNKNOWN key is a rejection, so no field
// can be added on the writing side and silently ride along into the bridge.
//
// Pure on purpose (no node builtins): main writes these files and the bridge
// reads them, and both sides must agree on the shape without sharing anything
// that could pull a dependency into the bridge's import graph.

/** Directory under userData holding one locator per running server. */
export const LOCATOR_DIR_NAME = 'mcp-locators';

/** 128-bit opaque id, hex. Identifies the locator in an AI client's config —
 *  it is not a secret (the capability path is), but it is unguessable so a
 *  stale config never resolves to a different profile's server. */
export const BRIDGE_ID_RE = /^[0-9a-f]{32}$/;

/** 64-bit generation, hex: a fresh value per locator write. */
export const GENERATION_RE = /^[0-9a-f]{16}$/;

/** The capability path as allocated by mcpAllocation.generateMcpPath. The
 *  character class is wider than what the generator emits (a hand-edited
 *  store can hold any "/mcp-…" the server will serve) but excludes "/", "?"
 *  and "#" — a locator must not be able to redirect the relay to another
 *  path, a query string, or a fragment. */
const MCP_PATH_RE = /^\/mcp-[A-Za-z0-9._~-]+$/;

export type McpLocator = {
  /** Schema version. A bump is a hard break by design: an older bridge
   *  rejects it rather than guessing at a field it does not know. */
  v: 1;
  id: string;
  port: number;
  path: string;
  /** Changes on every write, so a stop can tell "my own locator" from one a
   *  newer start already replaced. */
  generation: string;
};

const LOCATOR_KEYS = ['v', 'id', 'port', 'path', 'generation'] as const;

export function locatorFileName(id: string): string {
  if (!BRIDGE_ID_RE.test(id)) throw new Error('bridge id must be 32 lowercase hex characters');
  return `${id}.json`;
}

/** Serialize with an explicit key allowlist: even if a caller hands over an
 *  object carrying more than the four facts, only these keys are written. */
export function serializeLocator(locator: McpLocator): string {
  return JSON.stringify(locator, [...LOCATOR_KEYS], 2) + '\n';
}

/** Parse a locator file's text, rejecting anything that is not exactly the
 *  documented shape for `expectedId`. Every rejection throws — a bridge that
 *  cannot establish which server it was pointed at must fail loudly rather
 *  than fall back to a guess. */
export function parseLocator(text: string, expectedId: string): McpLocator {
  if (!BRIDGE_ID_RE.test(expectedId)) throw new Error('bridge id must be 32 lowercase hex characters');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('locator is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('locator must be a JSON object');
  }
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !(LOCATOR_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new Error(`locator has unexpected field(s): ${unknown.sort().join(', ')}`);
  }
  if (record.v !== 1) throw new Error('locator version is not 1');
  if (typeof record.id !== 'string' || !BRIDGE_ID_RE.test(record.id)) {
    throw new Error('locator id is not a bridge id');
  }
  if (record.id !== expectedId) {
    throw new Error(`locator belongs to a different server (id ${record.id}, expected ${expectedId})`);
  }
  if (!Number.isInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65_535) {
    throw new Error('locator port is not a valid port number');
  }
  if (typeof record.path !== 'string' || !MCP_PATH_RE.test(record.path)) {
    throw new Error('locator path is not a capability path');
  }
  if (typeof record.generation !== 'string' || !GENERATION_RE.test(record.generation)) {
    throw new Error('locator generation is malformed');
  }
  return {
    v: 1,
    id: record.id,
    port: record.port as number,
    path: record.path,
    generation: record.generation,
  };
}
