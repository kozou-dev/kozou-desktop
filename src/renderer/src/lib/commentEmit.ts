// COMMENT DDL generation — the whole of it, and deliberately the whole of what
// this feature does. The app writes the statement; the operator applies it,
// with psql, a migration tool, or a pull request. Nothing here reaches a
// database, and nothing here may: this module is a pure function of a relation
// name and a piece of text, imports nothing, and is bundled only into the
// renderer, which has no driver and no connection (pinned by the import-graph
// scan in scripts/check-treeshake.mjs).
//
// Why emit rather than execute. Schema documentation is schema change: it
// belongs in the same migration history as the columns it describes, reviewed
// the same way. An app that quietly ran `COMMENT ON` would put the semantic
// model — the thing kozou compiles everything else from — outside that history,
// and would need a write grant against the catalog to do it. The statement is
// the deliverable.

/** Quote an identifier for safe inlining into SQL.
 *
 *  Restated rather than imported: @kozou/core exposes this through its barrel
 *  only, and that barrel reaches filesystem and JWT code that has no business
 *  in a renderer bundle. The bodies are pinned against each other by a unit
 *  test, so "quoted the way kozou quotes" stays a fact rather than a habit —
 *  the same arrangement as DATA_MAX_PAGE_SIZE in shared/types.ts. */
export function quoteIdent(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

/** Quote a string literal for safe inlining into SQL, by doubling the single
 *  quotes. A comment body cannot be a bind parameter — PostgreSQL's `COMMENT`
 *  takes a literal, not an expression — so the escaping is ours to get right.
 *
 *  Doubling is the whole rule, and it is complete under `standard_conforming_
 *  strings` (on by default since PostgreSQL 9.1, and the setting this app
 *  states it assumes): with it on, a backslash in a standard literal is a
 *  backslash. Dollar quoting would need a tag that provably does not occur in
 *  the body — more moving parts for no additional safety here. */
export function quoteLiteral(text: string): string {
  return "'" + text.replace(/'/g, "''") + "'";
}

/** What a COMMENT statement can be written for. A column is addressed through
 *  its relation for tables, views and materialized views alike — PostgreSQL has
 *  one `COMMENT ON COLUMN` syntax for all three — so the column case carries no
 *  relation kind. */
export type CommentTarget =
  | { kind: 'table'; schema: string; name: string }
  | { kind: 'view'; schema: string; name: string; materialized: boolean }
  | { kind: 'column'; schema: string; relation: string; column: string };

/** Why a piece of text cannot become a COMMENT literal, or null when it can.
 *  The editor asks before offering the statement, so an unusable body is
 *  refused where it was typed rather than at the point the operator runs the
 *  file. */
export function commentTextProblem(text: string): string | null {
  if (text.includes('\u0000')) {
    return 'PostgreSQL text cannot contain a NUL character (U+0000) — remove it to emit this comment.';
  }
  return null;
}

/** The object clause of a COMMENT statement, e.g. `TABLE "public"."customers"`. */
function objectClause(target: CommentTarget): string {
  switch (target.kind) {
    case 'table':
      return `TABLE ${quoteIdent(target.schema)}.${quoteIdent(target.name)}`;
    case 'view':
      // A materialized view MUST be named as one: `COMMENT ON VIEW` against it
      // is an error, and so is `COMMENT ON MATERIALIZED VIEW` against an
      // ordinary view. Whoever builds this target has to know which it is.
      return `${target.materialized ? 'MATERIALIZED VIEW' : 'VIEW'} ${quoteIdent(target.schema)}.${quoteIdent(target.name)}`;
    case 'column':
      return `COLUMN ${quoteIdent(target.schema)}.${quoteIdent(target.relation)}.${quoteIdent(target.column)}`;
  }
}

/** The `COMMENT ON` statement setting `comment` on `target`.
 *
 *  An empty comment is not a state PostgreSQL has: `IS ''` REMOVES the comment
 *  exactly as `IS NULL` does (measured — `pg_description` keeps no row either
 *  way). So `''` and `null` produce the same statement here, written as
 *  `IS NULL`, which is the form the documentation gives for removal and the one
 *  that reads as what it does. Normalizing in this function rather than in the
 *  editor is deliberate: an emptied text box and an explicit removal cannot then
 *  drift into two statements that only look different. */
export function emitComment(target: CommentTarget, comment: string | null): string {
  if (comment !== null) {
    const problem = commentTextProblem(comment);
    // Unreachable from the editor, which refuses first; here so the function
    // cannot be made to produce a statement that is invalid by construction.
    if (problem !== null) throw new Error(problem);
  }
  const value = comment === null || comment === '' ? 'NULL' : quoteLiteral(comment);
  return `COMMENT ON ${objectClause(target)} IS ${value};`;
}

/** How a target reads in the drafts list. Not SQL — a label. */
export function describeTarget(target: CommentTarget): string {
  switch (target.kind) {
    case 'table':
      return `${target.schema}.${target.name}`;
    case 'view':
      return `${target.schema}.${target.name}`;
    case 'column':
      return `${target.schema}.${target.relation}.${target.column}`;
  }
}

/** One statement waiting to be copied or saved. Session-only by design: these
 *  are unapplied schema changes, and a file of them that outlived the app —
 *  and the schema it was written against — would be a worse artifact than
 *  having to write them again. */
export type CommentDraft = {
  /** Monotonic within a session; identity for removal. */
  id: number;
  /** The profile the statement was written against. A draft is only ever
   *  offered alongside the database it describes. */
  profile: string;
  /** Display label (see describeTarget). */
  target: string;
  sql: string;
};

const FILE_HEADER = [
  '-- COMMENT statements drafted in kozou Desktop.',
  '-- Nothing here has been applied: this app never runs them. Review, then',
  '-- apply the way you apply any other schema change (psql, your migration',
  '-- tool, a pull request). Re-inspect afterwards to see them take effect.',
  '',
].join('\n');

/** The drafts as a .sql file body. */
export function draftsToSqlFile(drafts: readonly CommentDraft[]): string {
  return FILE_HEADER + drafts.map((d) => `${d.sql}\n`).join('');
}
