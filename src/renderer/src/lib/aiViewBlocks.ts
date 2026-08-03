// What the "AI view" surface is allowed to be: a list of MCP tool results,
// each one whole and unedited.
//
// An agent never receives two tool results glued together, so this surface
// must not render them that way either. Earlier it did — a view's AI view
// concatenated `describe_view` and `get_concept_context` with a synthetic
// `// get_concept_context("…")` separator line, producing a blob that matched
// no payload any agent is ever handed. The fix is structural rather than a
// disclaimer: one block per tool result, and the call that produced a block is
// chrome *around* it, never text inside it.
//
// `call` therefore names a call an agent could actually make — the tool's real
// name and the exact JSON arguments the app passed (see worker/aiViews.ts).

import type { AiViews } from '../../../shared/types.js';

/** One MCP tool result. `text` is byte-for-byte what the server's own
 *  `successResult` produced; `call` is this app's label for it. */
export type AiViewBlock = { call: string; text: string };

/** Stated wherever an AI view surfaces. Two claims, both load-bearing: what
 *  the blocks are (whole tool results, with the heading outside the payload),
 *  and where this stops matching a real server (configuration-dependent
 *  surfaces are not reproduced). */
export const AI_VIEW_NOTE =
  'Each block below is one whole MCP tool result - byte-for-byte what a ' +
  'default-configured kozou server hands an AI agent, from the same functions ' +
  'and the same serialization. The heading above a block is the call that ' +
  'produced it and is not part of the payload. Server-side opt-ins (RPC ' +
  'exposure config, privilege-aware annotations) are not reproduced here yet.';

function label(tool: string, args: Record<string, string>): string {
  return `${tool} ${JSON.stringify(args)}`;
}

/** The blocks for a selected relation. A table yields one; a view yields
 *  `describe_view` plus, when the view backs a named concept, the separate
 *  `get_concept_context` result an agent would get from a second call. */
export function relationAiBlocks(
  kind: 'table' | 'view',
  qualifiedName: string,
  aiViews: AiViews,
  conceptName: string | null,
): AiViewBlock[] {
  const blocks: AiViewBlock[] = [];

  if (kind === 'table') {
    const text = aiViews.tables[qualifiedName];
    if (text) blocks.push({ call: label('describe_table', { qualifiedName }), text });
    return blocks;
  }

  const viewText = aiViews.views[qualifiedName];
  if (viewText) blocks.push({ call: label('describe_view', { qualifiedName }), text: viewText });

  if (conceptName !== null) {
    const conceptText = aiViews.concepts[conceptName];
    if (conceptText) {
      blocks.push({ call: label('get_concept_context', { name: conceptName }), text: conceptText });
    }
  }

  return blocks;
}

/** The functions panel's block. `describe_functions` takes no arguments, so
 *  the label carries an empty object rather than dropping the argument form. */
export function functionsAiBlocks(aiViews: AiViews): AiViewBlock[] {
  return aiViews.functions === null
    ? []
    : [{ call: 'describe_functions {}', text: aiViews.functions }];
}
