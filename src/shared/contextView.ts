// Structural types for the TRIMMED SchemaContext the renderer receives over
// IPC (raw catalog records stripped, so @kozou/core's own types — which
// require them — do not apply). Only the fields the UI consumes are typed;
// the contract test pins the real shape against `kozou inspect`.

export type RelationRef = {
  field: string;
  fields?: string[];
  references: { schema: string; table: string; column: string; columns?: string[] };
  cardinality: string;
  meaning: string | null;
};

export type ColumnView = {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  label: string;
  description?: string | null;
  aiDescription?: string | null;
  enumValues?: string[] | null;
  /** Present when the column has a DEFAULT. A row editor reads it as "leave
   *  this out and the database fills it in", which is the difference between
   *  a field that may be skipped and one that must be typed. */
  defaultExpr?: string | null;
  /** kozou's widget choice for this column (UI Hints > `@widget:` > heuristic).
   *  The row editor uses it to pick a control; an unknown value falls back to a
   *  text input, so a new widget upstream degrades rather than breaks. */
  widget?: string;
  /** True when `enumValues` is a PostgreSQL ENUM's exhaustive label set rather
   *  than a (non-exhaustive) set read out of a CHECK constraint. Only the
   *  former may be offered as a closed choice. */
  nativeEnum?: boolean;
  /** Read-only from UI Hints. Desktop never supplies hints today, so this is
   *  false in practice; honoured anyway so a hinted schema is not overridden. */
  readonly?: boolean;
  /** Privilege-aware introspection only: whether the connected role may INSERT
   *  (`insertable`) or UPDATE (`updatable`) this column. `undefined` means
   *  privileges were not evaluated — which is the desktop's own inspect today,
   *  so these fold a form to read-only only when they are actually present. */
  insertable?: boolean;
  updatable?: boolean;
};

export type RowSecurityView = { enabled: boolean; forced: boolean; hasPolicies: boolean };

export type TableView = {
  schema: string;
  name: string;
  qualifiedName: string;
  label: string;
  description: string | null;
  aiDescription: string | null;
  policy?: string[];
  rowSecurity?: RowSecurityView;
  primaryKey: string[];
  columns: ColumnView[];
  relations: RelationRef[];
};

export type ViewView = {
  schema: string;
  name: string;
  qualifiedName: string;
  label: string;
  description: string | null;
  aiDescription: string | null;
  policy?: string[];
  purpose: string | null;
  columns: ColumnView[];
  underlyingTables: { schema: string; name: string }[];
};

export type ConceptView = {
  name: string;
  label: string;
  description: string | null;
  kind: string;
  joinSuggestions: { table: string; on: string; meaning: string | null }[];
  aiNotes: string[];
  policies?: string[];
  exampleQueries: { description: string; sql: string }[];
};

export type FunctionView = {
  schema: string;
  name: string;
  qualifiedName: string;
  label: string;
  description: string | null;
  aiDescription: string | null;
  policy?: string[];
  args: { name: string; typeName: string; hasDefault: boolean }[];
  returns: { kind: string; typeName: string };
  volatility: string;
  security: string;
};

export type EnumView = { schema: string; name: string; values: string[]; description: string | null };

export type ContextView = {
  meta: { serverVersion: string; builtAt: string; sourceSchemas: string[] };
  tables: TableView[];
  views: ViewView[];
  enums: EnumView[];
  concepts: ConceptView[];
  functions?: FunctionView[];
};
