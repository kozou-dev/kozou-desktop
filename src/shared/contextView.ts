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
