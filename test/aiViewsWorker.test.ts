// The failure path of the AI view. It has its own test because it is the one
// place where the app could put words of its own into a block: a describe that
// throws produces no payload, so something has to be shown, and for a while
// that something was `(describe unavailable: …)` — a phrasing no server ever
// emits. The surface claims every block is a tool result's text, so the
// failure text has to be the error result's text.

import { successResult } from '@kozou/mcp';
import type { SchemaContext } from '@kozou/core';
import { describe, expect, it } from 'vitest';
import { buildAiViews } from '../src/worker/aiViews.js';

/** A context whose table is malformed enough to make `describe_table` throw
 *  something other than a deliberate McpToolError (it maps over `columns`).
 *  Nothing `buildSchemaContext` produces looks like this — the point is to
 *  reach the branch, not to claim the branch is reachable in normal use. */
const brokenContext = {
  tables: [{ qualifiedName: 'public.broken', name: 'broken', schema: 'public' }],
  views: [],
  concepts: [],
  enums: [],
  functions: [],
  meta: {},
} as unknown as SchemaContext;

describe('buildAiViews failure path', () => {
  it('shows the error result the server would return, not a phrasing of its own', () => {
    const views = buildAiViews(brokenContext);

    // Exactly what the server's catch-all produces for an unexpected throw:
    // generic, tool-named, and free of internal detail.
    expect(views.tables['public.broken']).toBe('The "describe_table" tool failed.');
  });

  it('never labels a failure with app-authored wording', () => {
    const views = buildAiViews(brokenContext);
    expect(views.tables['public.broken']).not.toContain('describe unavailable');
  });
});

describe('buildAiViews success path', () => {
  // Deliberately thin: the real identity check for the success path runs in
  // e2e/app.spec.ts against a live database, because comparing this module's
  // output to the same functions it just called would only restate itself.
  // What is worth pinning here is the serialization contract it relies on.
  it('uses the server tool-result serialization for its stored text', () => {
    const text = (successResult({ a: 1 }) as { content: { text: string }[] }).content[0]!.text;
    expect(text).toBe('{\n  "a": 1\n}');
  });
});
