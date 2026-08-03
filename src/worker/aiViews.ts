// "See what your AI sees": render the exact payloads the MCP describe tools
// hand to an AI agent — the same pure functions, serialized through the MCP
// server's own `successResult`, so the identity is constructive rather than
// a re-implementation that could drift.
//
// Fidelity boundary (stated wherever this surfaces — renderer/AiView.svelte
// is the single place that renders one, so the disclosure cannot be present
// on one surface and missing on another): this matches a DEFAULT-CONFIGURED
// kozou server (env-only). Server-side opt-ins — RPC exposure config,
// privilege-aware introspection — are threaded through the server's
// SchemaCache and are not reproduced here yet.
//
// The arguments below are the ones the UI prints above each block, so they
// are spelled the way an agent would send them: `qualifiedName` is what the
// tools' input schemas declare (`name` is only a tolerated alias).
//
// Runs inside the worker so the renderer never depends on @kozou/mcp.

import type { SchemaContext } from '@kozou/core';
import {
  describeFunctions,
  describeTable,
  describeView,
  errorResult,
  getConceptContext,
  McpToolError,
  successResult,
} from '@kozou/mcp';
import type { AiViews } from '../shared/types.js';

/** Serialize through the server's own tool-result path. */
function asToolText(payload: unknown): string {
  const result = successResult(payload) as { content: { text: string }[] };
  return result.content[0]!.text;
}

function resultText(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]!.text;
}

/** A describe that throws is still something an agent would be handed — the
 *  server turns the throw into an error tool result — so the failure path has
 *  to produce that result's text, not a phrasing of this app's own. The
 *  server's own classification is reproduced here: a deliberate McpToolError
 *  is surfaced verbatim so an agent can self-correct, anything else collapses
 *  to a generic line because it may carry internal detail. Getting this wrong
 *  is not cosmetic: the surface claims every block is a tool result's text,
 *  and one app-authored string in a block would make that claim false. */
function tryDescribe(tool: string, fn: () => unknown): string {
  try {
    return asToolText(fn());
  } catch (err) {
    return resultText(
      err instanceof McpToolError
        ? errorResult(err.message)
        : errorResult(`The "${tool}" tool failed.`),
    );
  }
}

export function buildAiViews(ctx: SchemaContext): AiViews {
  const out: AiViews = { tables: {}, views: {}, concepts: {}, functions: null };
  for (const t of ctx.tables) {
    out.tables[t.qualifiedName] = tryDescribe('describe_table', () =>
      describeTable({ qualifiedName: t.qualifiedName }, ctx),
    );
  }
  for (const v of ctx.views) {
    out.views[v.qualifiedName] = tryDescribe('describe_view', () =>
      describeView({ qualifiedName: v.qualifiedName }, ctx),
    );
  }
  for (const c of ctx.concepts) {
    out.concepts[c.name] = tryDescribe('get_concept_context', () =>
      getConceptContext({ name: c.name }, ctx),
    );
  }
  if ((ctx.functions ?? []).length > 0) {
    out.functions = tryDescribe('describe_functions', () => describeFunctions({}, ctx));
  }
  return out;
}
