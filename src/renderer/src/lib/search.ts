// Cross-profile search over the compiled semantics of every inspected
// profile: name / label / description / @ai of tables and views. Pure and
// unit-testable; the renderer maps hits to a profile + entity jump.

import type { ContextView } from '../../../shared/contextView.js';

export type SearchHit = {
  profile: string;
  kind: 'table' | 'view';
  /** qualified name — the entity id used for selection. */
  id: string;
  label: string;
  /** Which field matched, for a short "why" line. */
  matchedIn: 'name' | 'comment' | '@ai';
  /** A short excerpt around the match. */
  snippet: string;
};

const MAX_HITS = 50;

function excerpt(text: string, query: string): string {
  const i = text.toLowerCase().indexOf(query);
  if (i < 0) return text.slice(0, 80);
  const start = Math.max(0, i - 24);
  const slice = text.slice(start, start + 80).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '...' : '') + slice + (start + 80 < text.length ? '...' : '');
}

/** Search all inspected profiles. `contexts` maps profile name -> its trimmed
 *  SchemaContext (only profiles that inspected successfully). Returns up to
 *  MAX_HITS hits and whether the list was truncated (so the UI never
 *  silently hides matches). */
export function searchContexts(
  contexts: Record<string, ContextView>,
  rawQuery: string,
): { hits: SearchHit[]; truncated: boolean } {
  const query = rawQuery.trim().toLowerCase();
  if (query.length < 2) return { hits: [], truncated: false };

  const hits: SearchHit[] = [];
  for (const [profile, ctx] of Object.entries(contexts)) {
    const relations: { kind: 'table' | 'view'; r: ContextView['tables'][number] | ContextView['views'][number] }[] = [
      ...ctx.tables.map((r) => ({ kind: 'table' as const, r })),
      ...ctx.views.map((r) => ({ kind: 'view' as const, r })),
    ];
    for (const { kind, r } of relations) {
      let matchedIn: SearchHit['matchedIn'] | null = null;
      let source = '';
      if (r.qualifiedName.toLowerCase().includes(query) || r.label.toLowerCase().includes(query)) {
        matchedIn = 'name';
        source = r.label !== r.qualifiedName ? `${r.qualifiedName} (${r.label})` : r.qualifiedName;
      } else if (r.aiDescription && r.aiDescription.toLowerCase().includes(query)) {
        matchedIn = '@ai';
        source = r.aiDescription;
      } else if (r.description && r.description.toLowerCase().includes(query)) {
        matchedIn = 'comment';
        source = r.description;
      }
      if (matchedIn) {
        hits.push({
          profile,
          kind,
          id: r.qualifiedName,
          label: r.label,
          matchedIn,
          snippet: excerpt(source, query),
        });
      }
    }
  }

  // Stable order: name matches first, then by profile, then by id.
  const rank = { name: 0, '@ai': 1, comment: 2 } as const;
  hits.sort(
    (a, b) =>
      rank[a.matchedIn] - rank[b.matchedIn] ||
      a.profile.localeCompare(b.profile) ||
      a.id.localeCompare(b.id),
  );

  return { hits: hits.slice(0, MAX_HITS), truncated: hits.length > MAX_HITS };
}
