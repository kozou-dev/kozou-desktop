// "See what your AI sees": render the exact payloads the MCP describe tools
// hand to an AI agent — the same pure functions, serialized through the MCP
// server's own `successResult`, so the identity is constructive rather than
// a re-implementation that could drift.
//
// Fidelity boundary (stated wherever this surfaces): this matches a
// DEFAULT-CONFIGURED kozou server (env-only). Server-side opt-ins — RPC
// exposure config, privilege-aware introspection — are threaded through the
// server's SchemaCache and are not reproduced here yet.
//
// Runs inside the worker so the renderer never depends on @kozou/mcp.

import type { SchemaContext } from '@kozou/core';
import {
  describeFunctions,
  describeTable,
  describeView,
  getConceptContext,
  successResult,
} from '@kozou/mcp';
import type { AiViews } from '../shared/types.js';

/** Serialize through the server's own tool-result path. */
function asToolText(payload: unknown): string {
  const result = successResult(payload) as { content: { text: string }[] };
  return result.content[0]!.text;
}

function tryDescribe(fn: () => unknown): string {
  try {
    return asToolText(fn());
  } catch (err) {
    // A describe function refusing an entity is itself faithful information.
    const message = err instanceof Error ? err.message : String(err);
    return `(describe unavailable: ${message})`;
  }
}

export function buildAiViews(ctx: SchemaContext): AiViews {
  const out: AiViews = { tables: {}, views: {}, concepts: {}, functions: null };
  for (const t of ctx.tables) {
    out.tables[t.qualifiedName] = tryDescribe(() => describeTable({ name: t.qualifiedName }, ctx));
  }
  for (const v of ctx.views) {
    out.views[v.qualifiedName] = tryDescribe(() => describeView({ name: v.qualifiedName }, ctx));
  }
  for (const c of ctx.concepts) {
    out.concepts[c.name] = tryDescribe(() => getConceptContext({ name: c.name }, ctx));
  }
  if ((ctx.functions ?? []).length > 0) {
    out.functions = tryDescribe(() => describeFunctions({}, ctx));
  }
  return out;
}
