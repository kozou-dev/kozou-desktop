// The AI view claims to show what an agent receives, so the thing under test
// is an identity, not a rendering detail: every block must be one tool result
// verbatim, with nothing of the app's own inside it.
//
// The regression this pins: a view's AI view used to concatenate
// `describe_view` and `get_concept_context` with a synthetic
// `// get_concept_context("…")` separator, so the text on screen matched no
// payload any agent is ever handed.

import { describe, expect, it } from 'vitest';
import {
  AI_VIEW_NOTE,
  functionsAiBlocks,
  relationAiBlocks,
} from '../src/renderer/src/lib/aiViewBlocks.js';
import type { AiViews } from '../src/shared/types.js';

const TABLE_PAYLOAD = '{\n  "qualifiedName": "public.customers",\n  "columns": []\n}';
const VIEW_PAYLOAD = '{\n  "qualifiedName": "public.recent_orders",\n  "columns": []\n}';
const CONCEPT_PAYLOAD = '{\n  "concept": "recent_orders",\n  "joinSuggestions": []\n}';

const aiViews: AiViews = {
  tables: { 'public.customers': TABLE_PAYLOAD },
  views: { 'public.recent_orders': VIEW_PAYLOAD },
  concepts: { recent_orders: CONCEPT_PAYLOAD },
  functions: '{\n  "functions": []\n}',
};

/** Every payload the fixture can produce. A block's text must be one of these
 *  and nothing else — no joining, no trimming, no added lines. */
const PAYLOADS = [TABLE_PAYLOAD, VIEW_PAYLOAD, CONCEPT_PAYLOAD, aiViews.functions!];

describe('relationAiBlocks', () => {
  it('gives a table one block holding the describe_table result verbatim', () => {
    const blocks = relationAiBlocks('table', 'public.customers', aiViews, null);
    expect(blocks).toEqual([
      { call: 'describe_table {"qualifiedName":"public.customers"}', text: TABLE_PAYLOAD },
    ]);
  });

  it('splits a concept-backed view into the two calls an agent would make', () => {
    const blocks = relationAiBlocks('view', 'public.recent_orders', aiViews, 'recent_orders');

    expect(blocks).toEqual([
      { call: 'describe_view {"qualifiedName":"public.recent_orders"}', text: VIEW_PAYLOAD },
      { call: 'get_concept_context {"name":"recent_orders"}', text: CONCEPT_PAYLOAD },
    ]);
  });

  it('never puts app text inside a payload', () => {
    const blocks = relationAiBlocks('view', 'public.recent_orders', aiViews, 'recent_orders');

    for (const block of blocks) {
      // The identity that matters: the text IS a tool result, not a document
      // built from one. A separator, a heading, or a joined second payload
      // would each break this.
      expect(PAYLOADS).toContain(block.text);
      expect(block.text).not.toContain('//');
      expect(block.text).not.toContain('get_concept_context');
    }
  });

  it('omits the concept block when the view backs no concept', () => {
    const blocks = relationAiBlocks('view', 'public.recent_orders', aiViews, null);
    expect(blocks.map((b) => b.text)).toEqual([VIEW_PAYLOAD]);
  });

  it('omits a block whose payload is missing rather than rendering an empty one', () => {
    expect(relationAiBlocks('table', 'public.unknown', aiViews, null)).toEqual([]);
    expect(relationAiBlocks('view', 'public.recent_orders', aiViews, 'no_such_concept')).toEqual([
      { call: 'describe_view {"qualifiedName":"public.recent_orders"}', text: VIEW_PAYLOAD },
    ]);
  });
});

describe('functionsAiBlocks', () => {
  it('labels the no-argument call with its empty argument object', () => {
    expect(functionsAiBlocks(aiViews)).toEqual([
      { call: 'describe_functions {}', text: aiViews.functions },
    ]);
  });

  it('yields nothing when the server exposed no functions', () => {
    expect(functionsAiBlocks({ ...aiViews, functions: null })).toEqual([]);
  });
});

describe('AI_VIEW_NOTE', () => {
  // Both surfaces render this string, so it has to carry both claims. Losing
  // the second one is how the functions panel came to show an AI view with no
  // fidelity boundary stated on it at all.
  it('states that a block is a whole tool result and that the heading is not payload', () => {
    expect(AI_VIEW_NOTE).toContain('one whole MCP tool result');
    expect(AI_VIEW_NOTE).toContain('not part of the payload');
  });

  it('states the configuration boundary', () => {
    expect(AI_VIEW_NOTE).toContain('default-configured');
    expect(AI_VIEW_NOTE).toContain('not reproduced here yet');
  });
});
