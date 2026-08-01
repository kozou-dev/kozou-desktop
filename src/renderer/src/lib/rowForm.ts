// The row editor's logic, kept pure so it can be tested without a window and
// without a database. The Svelte component owns the controls; everything that
// decides what is sent — and what may not be sent at all — lives here.
//
// Four rules shape it:
//
//   1. Only what the operator touched is sent. An UPDATE carries the fields
//      they edited and nothing else, so a value this app cannot represent
//      faithfully (a byte array, a re-serialized json document) is left alone
//      instead of being written back in whatever shape it survived the trip in.
//   2. "Not provided" and NULL are different answers. Omitting a field lets the
//      database apply its DEFAULT; sending null stores a null. A form that
//      could only ever send a value would make a generated key impossible to
//      insert and a nullable column impossible to clear.
//   3. Values travel as strings. @kozou/api pre-flights a string against the
//      column type (rejecting an out-of-range integer or a malformed uuid with
//      a 400 before any statement runs) and binds it as a parameter, so
//      PostgreSQL performs the conversion it would perform for any client. The
//      form's own checks stay thin on purpose: NOT NULL and "something to send",
//      which are the two the database cannot answer more helpfully than we can.
//   4. A row is addressed by its primary key, or not at all. The id is what
//      @kozou/api's item routes parse, and a key it cannot express (a composite
//      component containing the separator, a value that did not arrive as a
//      scalar) yields no id — so the row offers no editor rather than an editor
//      that would act on a different row.

import type { ColumnView } from '../../../shared/contextView.js';

/** What the form is doing. `insert` starts from nothing; `update` starts from a
 *  row fetched through the `get` path — never from the browse page, whose values
 *  may have been cut before they left the worker. */
export type FormMode = 'insert' | 'update';

/** Why a field cannot be edited. Shown next to the control, because "you may
 *  not change this" is only useful with the reason attached. */
export type FieldLock =
  | 'primary-key'
  | 'privilege'
  | 'hint-readonly'
  | 'unrepresentable';

export type FieldState = {
  column: string;
  /** Text in the control. Empty when the field is unset or null. */
  text: string;
  /** The operator asked for a null here (or the fetched value was one). */
  isNull: boolean;
  /** Whether this field is part of the payload. `insert` starts every field
   *  untouched (= let the database decide); `update` starts every field
   *  untouched (= leave it as it is). */
  touched: boolean;
  /** Absent when the field is editable. */
  lock?: FieldLock;
  /** The fetched value was re-serialized to seed the control, so saving it
   *  back could differ from what is stored (json key order, number precision).
   *  Only matters once the field is touched — untouched fields are not sent. */
  reserialized?: boolean;
};

export type SeededForm = {
  fields: FieldState[];
  /** True when at least one seeded field was re-serialized, so the form can say
   *  so once rather than per field. */
  anyReserialized: boolean;
};

/** Whether a column may be written in this mode, and why not when it may not.
 *  Privilege flags are only present under privilege-aware introspection, which
 *  the desktop does not ask for today; they fold the field to read-only when a
 *  build does. */
export function fieldLock(
  column: ColumnView,
  mode: FormMode,
): Exclude<FieldLock, 'unrepresentable'> | undefined {
  // A primary key is what addresses the row being edited. Changing it mid-edit
  // would move the row out from under the id the form is about to PATCH, so the
  // editor does not offer it — an insert may of course supply one.
  if (mode === 'update' && column.isPrimaryKey) return 'primary-key';
  if (column.readonly === true) return 'hint-readonly';
  if (mode === 'insert' && column.insertable === false) return 'privilege';
  if (mode === 'update' && column.updatable === false) return 'privilege';
  return undefined;
}

/** A value this app cannot hand back to the database in the form it arrived in.
 *  Byte arrays are the real case: a browse cell shows a length, not the bytes,
 *  and there is no text the operator could edit that would round-trip. */
function unrepresentable(value: unknown): boolean {
  return (
    value instanceof Uint8Array ||
    ArrayBuffer.isView(value) ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  );
}

/** Render a fetched value as editable text.
 *
 *  Dates and intervals do not appear here as objects: the data worker hands
 *  that family over as PostgreSQL's own text precisely so this function does not
 *  have to invent a textual form for them (see runData.ts). What is left that is
 *  not already text is a json/jsonb document, which is re-serialized — flagged,
 *  because the result is equal as JSON but not necessarily identical as text. */
function seedText(value: unknown): { text: string; reserialized: boolean } | null {
  if (typeof value === 'string') return { text: value, reserialized: false };
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return { text: String(value), reserialized: false };
  }
  // A Date can still arrive from a column type outside the family the worker
  // overrides. Its ISO form is the honest reading of an instant; flagged as
  // re-serialized because it is this app's rendering, not the server's text.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : { text: value.toISOString(), reserialized: true };
  }
  if (unrepresentable(value)) return null;
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? null : { text: json, reserialized: true };
  } catch {
    // Cyclic, or a bigint nested inside an object: no text to offer.
    return null;
  }
}

/** Build the initial field states for a form.
 *
 *  `row` is the row fetched for an update, and undefined for an insert. An
 *  insert starts every field unset so the database's own defaults apply to
 *  everything the operator does not fill in — including a generated key, which
 *  is the common case and must not require them to notice. */
export function seedForm(
  columns: ColumnView[],
  mode: FormMode,
  row?: Record<string, unknown>,
): SeededForm {
  const fields = columns.map((column): FieldState => {
    const lock = fieldLock(column, mode);
    const base: FieldState = {
      column: column.name,
      text: '',
      isNull: false,
      touched: false,
      ...(lock !== undefined ? { lock } : {}),
    };
    if (mode === 'insert' || row === undefined) return base;
    const value = row[column.name];
    if (value === null) return { ...base, isNull: true };
    if (value === undefined) return base;
    const seeded = seedText(value);
    if (seeded === null) {
      // The value is here, but not as anything this form can put in a control.
      // Locking the field is what keeps an untouched byte array from being
      // saved back as the string it happened to render as.
      return { ...base, lock: 'unrepresentable' };
    }
    return {
      ...base,
      text: seeded.text,
      ...(seeded.reserialized ? { reserialized: true } : {}),
    };
  });
  return {
    fields,
    anyReserialized: fields.some((f) => f.reserialized === true && f.lock === undefined),
  };
}

export type PayloadResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; error: string };

/** Turn the form state into the payload for an insert or an update — or into
 *  the reason it is not ready to send.
 *
 *  The checks here are the two the database cannot phrase better than the form
 *  can: a NOT NULL column that would arrive empty, and a payload with nothing
 *  in it. Everything else (types, ranges, constraints, permissions) is left to
 *  the pre-flight and to PostgreSQL, which is where the real answer lives. */
export function buildPayload(
  columns: ColumnView[],
  fields: FieldState[],
  mode: FormMode,
): PayloadResult {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  const nulled: string[] = [];

  for (const field of fields) {
    const column = byName.get(field.column);
    if (column === undefined || field.lock !== undefined) continue;
    if (!field.touched) {
      // An insert that leaves a NOT NULL column with no default unset reaches
      // PostgreSQL as a 23502, which comes back as "Not-null constraint
      // violation" without naming the column. Naming it here is the whole value
      // of this check.
      //
      // Primary keys are exempt, and the reason is a gap in what introspection
      // reports: an identity column (`GENERATED ALWAYS AS IDENTITY`, the
      // ordinary way to key a table) has no entry in `pg_attrdef`, so it is
      // indistinguishable here from a key the client must supply. Refusing to
      // save would then block the common case to warn about the rare one. A key
      // that really was required still gets the database's own 400.
      if (
        mode === 'insert' &&
        !column.nullable &&
        !column.isPrimaryKey &&
        (column.defaultExpr === null || column.defaultExpr === undefined)
      ) {
        missing.push(column.name);
      }
      continue;
    }
    if (field.isNull) {
      if (!column.nullable) nulled.push(column.name);
      values[column.name] = null;
      continue;
    }
    values[column.name] = field.text;
  }

  if (nulled.length > 0) {
    return {
      ok: false,
      error: `These columns cannot be null: ${nulled.join(', ')}.`,
    };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: `These columns have no default and cannot be empty: ${missing.join(', ')}.`,
    };
  }
  if (Object.keys(values).length === 0) {
    return {
      ok: false,
      error:
        mode === 'insert'
          ? 'Fill in at least one column. A row of nothing but database defaults cannot be requested from here.'
          : 'Nothing was changed.',
    };
  }
  return { ok: true, values };
}

/** Why a row cannot be addressed, in the words the row's controls will use. */
export type RowIdFailure =
  | 'no-primary-key'
  | 'missing-value'
  | 'unrepresentable-value'
  | 'separator-in-value';

export type RowIdResult = { ok: true; id: string } | { ok: false; reason: RowIdFailure };

/** The id @kozou/api's item routes expect: the key value for a single-column
 *  primary key, taken verbatim, and the components joined with commas for a
 *  composite one.
 *
 *  A composite key value containing a comma has no representation in that
 *  grammar — the id is split on commas after decoding — so it is refused here
 *  rather than sent to address whatever row the mis-split happens to name. */
export function rowId(
  primaryKey: string[],
  row: Record<string, unknown>,
): RowIdResult {
  if (primaryKey.length === 0) return { ok: false, reason: 'no-primary-key' };
  const parts: string[] = [];
  for (const column of primaryKey) {
    const value = row[column];
    if (value === null || value === undefined) return { ok: false, reason: 'missing-value' };
    if (typeof value === 'string') parts.push(value);
    else if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
      parts.push(String(value));
    } else return { ok: false, reason: 'unrepresentable-value' };
  }
  if (primaryKey.length > 1 && parts.some((p) => p.includes(','))) {
    return { ok: false, reason: 'separator-in-value' };
  }
  // A single-column key takes the id verbatim, so an empty string would address
  // nothing and read as a missing segment on the way in.
  if (parts.every((p) => p === '')) return { ok: false, reason: 'missing-value' };
  return { ok: true, id: parts.join(',') };
}

export const ROW_ID_EXPLANATION: Record<RowIdFailure, string> = {
  'no-primary-key':
    'This relation has no primary key, so there is no way to address one of its rows.',
  'missing-value': 'This row has no usable primary-key value, so it cannot be addressed.',
  'unrepresentable-value':
    'This row is keyed by a value this app cannot put in a request, so it cannot be addressed.',
  'separator-in-value':
    'A component of this composite key contains a comma, which the item address separates on - this row cannot be addressed unambiguously.',
};

/** Which control a column gets. Derived from kozou's own widget choice where it
 *  says something a text input does not, and from the type otherwise. An
 *  unrecognized widget falls through to text: a new one upstream should degrade
 *  to a usable control, not to a missing one. */
export type ControlKind = 'boolean' | 'enum' | 'textarea' | 'text';

export function controlKind(column: ColumnView): ControlKind {
  if (column.widget === 'boolean') return 'boolean';
  const base = column.dataType.toLowerCase();
  if (base === 'boolean' || base === 'bool') return 'boolean';
  // Only a native ENUM's label set is exhaustive. A set read out of a CHECK
  // constraint is not, so offering it as a closed choice would refuse values
  // the column accepts.
  if (column.nativeEnum === true && (column.enumValues ?? []).length > 0) return 'enum';
  if (column.widget === 'textarea') return 'textarea';
  if (base.startsWith('json') || base === 'text' || base === 'xml') return 'textarea';
  return 'text';
}
