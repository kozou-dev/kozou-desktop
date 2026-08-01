// The row editor's decisions, taken away from the component that renders them.
//
// What is worth pinning here is everything that could quietly write the wrong
// thing: which fields are sent at all, the difference between "not provided"
// and NULL, a value that cannot survive the round trip, and the id an item
// route is addressed by.

import { describe, expect, it } from 'vitest';
import type { ColumnView } from '../src/shared/contextView.js';
import {
  buildPayload,
  controlKind,
  fieldLock,
  rowId,
  seedForm,
  type FieldState,
} from '../src/renderer/src/lib/rowForm.js';

const column = (over: Partial<ColumnView> & { name: string }): ColumnView => ({
  dataType: 'text',
  nullable: true,
  isPrimaryKey: false,
  isForeignKey: false,
  label: over.name,
  ...over,
});

const COLUMNS: ColumnView[] = [
  column({ name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true }),
  column({ name: 'name', dataType: 'text', nullable: false }),
  column({ name: 'email', dataType: 'text' }),
  column({ name: 'created_at', dataType: 'timestamptz', nullable: false, defaultExpr: 'now()' }),
];

/** Touch a seeded field the way the component does when the operator types. */
const type = (fields: FieldState[], name: string, text: string): FieldState[] =>
  fields.map((f) => (f.column === name ? { ...f, text, isNull: false, touched: true } : f));

const setNull = (fields: FieldState[], name: string): FieldState[] =>
  fields.map((f) => (f.column === name ? { ...f, text: '', isNull: true, touched: true } : f));

const find = (fields: FieldState[], name: string): FieldState =>
  fields.find((f) => f.column === name)!;

describe('fieldLock', () => {
  it('locks the primary key on update but not on insert', () => {
    const pk = COLUMNS[0]!;
    expect(fieldLock(pk, 'update')).toBe('primary-key');
    expect(fieldLock(pk, 'insert')).toBeUndefined();
  });

  it('folds a privilege-aware column to read-only per mode', () => {
    const insertOnly = column({ name: 'c', insertable: true, updatable: false });
    expect(fieldLock(insertOnly, 'insert')).toBeUndefined();
    expect(fieldLock(insertOnly, 'update')).toBe('privilege');
  });

  it('leaves every field editable when privileges were not evaluated', () => {
    // The desktop's own inspect does not ask for privilege-aware output, so
    // absent flags must not read as "denied".
    const plain = column({ name: 'c' });
    expect(fieldLock(plain, 'insert')).toBeUndefined();
    expect(fieldLock(plain, 'update')).toBeUndefined();
  });

  it('honours a UI-hint readonly column', () => {
    expect(fieldLock(column({ name: 'c', readonly: true }), 'insert')).toBe('hint-readonly');
  });
});

describe('seedForm', () => {
  it('starts an insert with every field unset', () => {
    const { fields, anyReserialized } = seedForm(COLUMNS, 'insert');
    expect(fields.every((f) => !f.touched && f.text === '' && !f.isNull)).toBe(true);
    expect(anyReserialized).toBe(false);
  });

  it('seeds an update from the fetched row and marks a null as null', () => {
    const { fields } = seedForm(COLUMNS, 'update', {
      id: '7',
      name: 'Ada',
      email: null,
      created_at: '2026-08-01 00:00:00+00',
    });
    expect(find(fields, 'name').text).toBe('Ada');
    expect(find(fields, 'email').isNull).toBe(true);
    // Date/time values arrive as the server's own text (the worker keeps them
    // that way), so the seed is the value rather than a rendering of it.
    expect(find(fields, 'created_at').text).toBe('2026-08-01 00:00:00+00');
    expect(fields.every((f) => !f.touched)).toBe(true);
  });

  it('locks a value it cannot represent instead of seeding a rendering of it', () => {
    const cols = [column({ name: 'blob', dataType: 'bytea' })];
    const { fields } = seedForm(cols, 'update', { blob: new Uint8Array([1, 2, 3]) });
    expect(find(fields, 'blob').lock).toBe('unrepresentable');
    expect(find(fields, 'blob').text).toBe('');
  });

  it('locks a structured value whose column would reject json syntax', () => {
    // The driver parses `text[]` into a JavaScript array. Seeding it as JSON
    // (`["a,b","c"]`) and saving would bind that spelling to an array column,
    // which wants `{"a,b",c}` - a value the operator never asked to change.
    const cols = [
      column({ name: 'tags', dataType: 'text[]' }),
      column({ name: 'loc', dataType: 'point' }),
    ];
    const { fields } = seedForm(cols, 'update', { tags: ['a,b', 'c'], loc: { x: 1, y: 2 } });
    expect(find(fields, 'tags').lock).toBe('unrepresentable');
    expect(find(fields, 'loc').lock).toBe('unrepresentable');
  });

  it('flags a re-serialized json seed', () => {
    const cols = [column({ name: 'doc', dataType: 'jsonb' })];
    const { fields, anyReserialized } = seedForm(cols, 'update', { doc: { a: 1 } });
    expect(find(fields, 'doc').reserialized).toBe(true);
    expect(JSON.parse(find(fields, 'doc').text)).toEqual({ a: 1 });
    expect(anyReserialized).toBe(true);
  });

  it('seeds a json column in json syntax even when the driver produced a string', () => {
    // A jsonb document `"123"` is a json STRING; the driver parses it into the
    // JavaScript string `123`, which is indistinguishable from a text column's
    // value. Seeding that verbatim and saving it would store the json NUMBER
    // 123 - a type change nothing on screen shows.
    const cols = [column({ name: 'doc', dataType: 'jsonb' })];
    const { fields } = seedForm(cols, 'update', { doc: '123' });
    expect(find(fields, 'doc').text).toBe('"123"');
    expect(find(fields, 'doc').reserialized).toBe(true);
    const sent = buildPayload(cols, type(fields, 'doc', '"123"'), 'update');
    expect(sent).toEqual({ ok: true, values: { doc: '"123"' } });
  });
});

describe('buildPayload', () => {
  it('sends only what was touched on an update', () => {
    const seeded = seedForm(COLUMNS, 'update', {
      id: '7',
      name: 'Ada',
      email: 'ada@example.com',
      created_at: '2026-08-01 00:00:00+00',
    }).fields;
    const result = buildPayload(COLUMNS, type(seeded, 'name', 'Grace'), 'update');
    expect(result).toEqual({ ok: true, values: { name: 'Grace' } });
  });

  it('refuses an update with nothing changed', () => {
    const seeded = seedForm(COLUMNS, 'update', { id: '7', name: 'Ada' }).fields;
    const result = buildPayload(COLUMNS, seeded, 'update');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Nothing was changed');
  });

  it('never sends a locked field, even when it was somehow touched', () => {
    const seeded = seedForm(COLUMNS, 'update', { id: '7', name: 'Ada' }).fields;
    // The control for a locked field is not rendered; this is the payload
    // builder refusing on its own rather than trusting that.
    const forced = seeded.map((f) => (f.lock !== undefined ? { ...f, text: '9', touched: true } : f));
    const result = buildPayload(COLUMNS, type(forced, 'name', 'Grace'), 'update');
    expect(result).toEqual({ ok: true, values: { name: 'Grace' } });
  });

  it('omits an untouched insert field so the database applies its default', () => {
    const seeded = seedForm(COLUMNS, 'insert').fields;
    const result = buildPayload(COLUMNS, type(seeded, 'name', 'New'), 'insert');
    // Neither the generated key nor the defaulted timestamp rides along.
    expect(result).toEqual({ ok: true, values: { name: 'New' } });
  });

  it('distinguishes an explicit null from a field left out', () => {
    const seeded = seedForm(COLUMNS, 'insert').fields;
    const withNull = setNull(type(seeded, 'name', 'New'), 'email');
    const result = buildPayload(COLUMNS, withNull, 'insert');
    expect(result).toEqual({ ok: true, values: { name: 'New', email: null } });
  });

  it('warns about a NOT NULL column with no default, but still sends', () => {
    // Naming the column is more use than the database's own "Not-null
    // constraint violation", which names nothing. Refusing would be this app
    // overruling PostgreSQL about a column a trigger may well fill in.
    const seeded = seedForm(COLUMNS, 'insert').fields;
    const result = buildPayload(COLUMNS, type(seeded, 'email', 'a@b.test'), 'insert');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings?.join(' ')).toContain('name');
    expect(result.values).toEqual({ email: 'a@b.test' });
  });

  it('does not warn about a primary key with no default', () => {
    // An identity key has no pg_attrdef entry, so it is indistinguishable from
    // a key the client must supply. Warning on every ordinary insert would
    // train the operator to ignore the line.
    const seeded = seedForm(COLUMNS, 'insert').fields;
    const result = buildPayload(COLUMNS, type(seeded, 'name', 'New'), 'insert');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toBeUndefined();
  });

  it('refuses to null a NOT NULL column', () => {
    const seeded = seedForm(COLUMNS, 'update', { id: '7', name: 'Ada' }).fields;
    const result = buildPayload(COLUMNS, setNull(seeded, 'name'), 'update');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('cannot be null');
  });

  it('refuses an insert with nothing filled in, even when every column could default', () => {
    // @kozou/api would accept this as `INSERT ... DEFAULT VALUES`, but main's
    // input validation rejects an empty payload — so the form says so here
    // rather than letting the IPC rejection surface as a raw error.
    const cols = [column({ name: 'a' }), column({ name: 'b' })];
    const result = buildPayload(cols, seedForm(cols, 'insert').fields, 'insert');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('at least one column');
  });

  it('sends every value as a string, leaving the type to the pre-flight', () => {
    const cols = [column({ name: 'n', dataType: 'integer', nullable: false })];
    const seeded = seedForm(cols, 'insert').fields;
    const result = buildPayload(cols, type(seeded, 'n', '42'), 'insert');
    expect(result).toEqual({ ok: true, values: { n: '42' } });
  });
});

describe('rowId', () => {
  it('takes a single-column key verbatim, commas and all', () => {
    expect(rowId(['id'], { id: 'a,b' })).toEqual({ ok: true, id: 'a,b' });
    expect(rowId(['id'], { id: 7 })).toEqual({ ok: true, id: '7' });
  });

  it('joins a composite key in declaration order', () => {
    expect(rowId(['a', 'b'], { b: 2, a: 1 })).toEqual({ ok: true, id: '1,2' });
  });

  it('refuses a composite component containing the separator', () => {
    // Splitting happens after decoding, so this id would address a different
    // row (or none) — silently.
    expect(rowId(['a', 'b'], { a: 'x,y', b: 'z' })).toEqual({
      ok: false,
      reason: 'separator-in-value',
    });
  });

  it('refuses a relation with no primary key', () => {
    expect(rowId([], { a: 1 })).toEqual({ ok: false, reason: 'no-primary-key' });
  });

  it('refuses a key the page budget shortened', () => {
    // The browse budget cuts every oversized value it carries, keys included.
    // The first 1,024 characters of one key can be another key in full, so an
    // id built from a cut cell can address a different row - the one failure
    // this whole derivation exists to prevent.
    expect(rowId(['id'], { id: 'x'.repeat(1024) }, new Set(['id']))).toEqual({
      ok: false,
      reason: 'cut-value',
    });
    // A cut somewhere else in the row is not this row's problem.
    expect(rowId(['id'], { id: '7', bio: 'cut' }, new Set(['bio']))).toEqual({ ok: true, id: '7' });
  });

  it('refuses a key value that is missing or not a scalar', () => {
    expect(rowId(['id'], { id: null })).toEqual({ ok: false, reason: 'missing-value' });
    expect(rowId(['id'], {})).toEqual({ ok: false, reason: 'missing-value' });
    expect(rowId(['id'], { id: '' })).toEqual({ ok: false, reason: 'missing-value' });
    expect(rowId(['id'], { id: new Uint8Array([1]) })).toEqual({
      ok: false,
      reason: 'unrepresentable-value',
    });
  });
});

describe('controlKind', () => {
  it('offers a closed choice only for a native enum', () => {
    const native = column({ name: 's', dataType: 'order_status', enumValues: ['a', 'b'], nativeEnum: true });
    const check = column({ name: 's', dataType: 'text', enumValues: ['a', 'b'] });
    expect(controlKind(native)).toBe('enum');
    // A CHECK-derived set is not exhaustive: offering it as a closed choice
    // would refuse values the column accepts.
    expect(controlKind(check)).toBe('textarea');
  });

  it('falls back to a text input for an unknown widget', () => {
    expect(controlKind(column({ name: 'c', dataType: 'inet', widget: 'future-widget' }))).toBe('text');
  });

  it('reads a boolean from either the widget or the type', () => {
    expect(controlKind(column({ name: 'b', dataType: 'boolean' }))).toBe('boolean');
    expect(controlKind(column({ name: 'b', dataType: 'int2', widget: 'boolean' }))).toBe('boolean');
  });
});
