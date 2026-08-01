// Build the renderer's SchemaContext payload. Three things happen here, and
// the order matters — two of them read the raw catalog records that the third
// then throws away:
//
//  1. LIFT the verbatim COMMENT of every table, view and column out of the raw
//     record, as `rawComment`. The renderer's `description` is NOT the comment
//     the schema author wrote: the context builder lifts `@widget:` and
//     `@example:` blocks out of it (measured — they are gone from `description`,
//     while `@ai:`/`@policy:` stay). A comment editor seeded from `description`
//     would therefore drop those tags on save, silently. The verbatim text
//     exists only inside the raw records, so it has to travel as its own field.
//  2. MARK materialized views. Introspection reports relkind 'v' and 'm' as one
//     kind, and the two need different DDL (`COMMENT ON MATERIALIZED VIEW` is
//     mandatory for 'm'), so the worker establishes it with its own catalog
//     query and passes the answer in. Deliberately tri-state: a view gets
//     `materialized: true|false` when that query succeeded and NO field at all
//     when it did not — "we could not tell" must not render as "ordinary view",
//     which would emit DDL the database rejects.
//  3. DROP the raw records (`rawTable` / `rawView` / `rawFunction`), which the
//     human-facing map never renders and which inflate the JSON severalfold.
//     The full context stays available inside the worker.

type AnyRecord = Record<string, unknown>;

const RAW_KEYS = new Set(['rawTable', 'rawView', 'rawFunction']);

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null;
}

/** The verbatim COMMENT of a raw catalog record. A record whose `comment` is
 *  null — or absent — is "no comment", which is a real state a comment editor
 *  has to be able to show and to write back to. */
function rawCommentOf(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  return typeof raw.comment === 'string' ? raw.comment : null;
}

/** Verbatim column COMMENTs from a raw record, keyed by column name. Matched by
 *  name rather than by position: the context builder is free to order its
 *  columns differently from the catalog record, and a comment attached to the
 *  wrong column is worse than a missing one. */
function rawColumnComments(raw: unknown): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!isRecord(raw) || !Array.isArray(raw.columns)) return out;
  for (const column of raw.columns) {
    if (!isRecord(column) || typeof column.name !== 'string') continue;
    out.set(column.name, typeof column.comment === 'string' ? column.comment : null);
  }
  return out;
}

function stripRaw(entry: AnyRecord): AnyRecord {
  const out: AnyRecord = {};
  for (const [k, v] of Object.entries(entry)) {
    if (!RAW_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/** Copy `entry` without its raw record, with the verbatim comments lifted onto
 *  it and onto its columns. */
function liftEntry(entry: AnyRecord, rawKey: 'rawTable' | 'rawView'): AnyRecord {
  const raw = entry[rawKey];
  const out = stripRaw(entry);
  // Only claim a comment when there was a record to read one from: without a
  // raw record nothing is known, and `null` there would assert "no comment".
  if (raw !== undefined) out.rawComment = rawCommentOf(raw);

  const byName = rawColumnComments(raw);
  if (Array.isArray(out.columns) && byName.size > 0) {
    out.columns = out.columns.map((column) => {
      if (!isRecord(column) || typeof column.name !== 'string') return column;
      if (!byName.has(column.name)) return column;
      return { ...column, rawComment: byName.get(column.name) ?? null };
    });
  }
  return out;
}

export type TrimOptions = {
  /** Qualified names (`schema.view`) of the views that are MATERIALIZED, as
   *  established by the worker's own catalog query. Omit it to say the relkind
   *  is unknown: every view is then left unmarked rather than marked ordinary. */
  materializedViews?: readonly string[];
};

/** Structurally clone `context` as the renderer payload (see the file header).
 *  The input is treated as untyped JSON so this file has no dependency on
 *  @kozou/core — the contract test pins the real shape. The input is never
 *  mutated: the worker keeps using the full context after this returns. */
export function trimContext(context: AnyRecord, opts: TrimOptions = {}): AnyRecord {
  const out: AnyRecord = { ...context };

  if (Array.isArray(context.tables)) {
    out.tables = context.tables.map((entry) =>
      isRecord(entry) ? liftEntry(entry, 'rawTable') : entry,
    );
  }

  const materialized =
    opts.materializedViews === undefined ? undefined : new Set(opts.materializedViews);
  if (Array.isArray(context.views)) {
    out.views = context.views.map((entry) => {
      if (!isRecord(entry)) return entry;
      const view = liftEntry(entry, 'rawView');
      if (materialized !== undefined && typeof view.qualifiedName === 'string') {
        view.materialized = materialized.has(view.qualifiedName);
      }
      return view;
    });
  }

  if (Array.isArray(context.functions)) {
    out.functions = context.functions.map((entry) => (isRecord(entry) ? stripRaw(entry) : entry));
  }

  return out;
}
