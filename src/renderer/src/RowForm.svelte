<script lang="ts">
  // The row editor. One form, two modes, and a deliberate three-way answer per
  // field: leave it to the database, send a value, or send null.
  //
  // That third state is not decoration. An INSERT that could only send values
  // could never let a generated key be generated, and an UPDATE that could only
  // send values could never clear a column — while an UPDATE that sent every
  // field would write back values this app only ever showed an approximation of.
  // So the payload carries what the operator answered for and nothing else
  // (see lib/rowForm.ts, which owns that decision and is tested without a DOM).
  //
  // Everything is typed as text and sent as text: @kozou/api pre-flights a
  // string against the column's type and binds it as a parameter, so PostgreSQL
  // does the conversion it would do for any client. The form's own checks are
  // the two the database phrases worse than we can — a NOT NULL column left
  // empty, and a payload with nothing in it.

  import { untrack } from 'svelte';
  import type { ColumnView, RelationRef } from '../../shared/contextView';
  import {
    buildPayload,
    controlKind,
    seedForm,
    type FieldState,
    type FormMode,
  } from './lib/rowForm';

  let {
    columns,
    relations,
    mode,
    row,
    busy,
    error,
    onsubmit,
    oncancel,
  }: {
    columns: ColumnView[];
    /** The table's foreign keys, for the display hint on a key column. v1 types
     *  the raw value; a picker is a later question (there is no relation search
     *  here to build one on). */
    relations: RelationRef[];
    mode: FormMode;
    /** For 'update': the row as re-fetched through the single-row `get` path.
     *  Never a row out of the browse page — those values may have been cut
     *  before they left the worker, and an editor working from a cut value
     *  would write the cut back. */
    row?: Record<string, unknown>;
    busy: boolean;
    /** The failure the last submission came back with, owned by the panel. */
    error: string | null;
    onsubmit: (values: Record<string, unknown>) => void;
    oncancel: () => void;
  } = $props();

  // Seeded once, deliberately: the panel keys this component on what it is
  // editing, so a different row (or a different mode) arrives as a different
  // instance. Re-seeding on a prop change would instead drop the operator's
  // half-typed input on the floor — `untrack` is that intent stated rather
  // than a warning silenced.
  const seeded = untrack(() => seedForm(columns, mode, row));
  let fields = $state<FieldState[]>(seeded.fields);

  /** The form's own complaint about the payload, kept apart from `error` (the
   *  database's). One is fixed by typing; the other may not be. */
  let localError = $state<string | null>(null);

  const byName = $derived(new Map(columns.map((c) => [c.name, c])));

  /** How a field is answered. The labels differ per mode because the meaning
   *  does: an insert leaves a column to its DEFAULT, an update leaves it as it
   *  already is. */
  type Source = 'skip' | 'value' | 'null';

  const sourceOf = (field: FieldState): Source =>
    !field.touched ? 'skip' : field.isNull ? 'null' : 'value';

  const skipLabel = $derived(mode === 'insert' ? 'database default' : 'unchanged');

  function update(name: string, change: Partial<FieldState>): void {
    fields = fields.map((f) => (f.column === name ? { ...f, ...change } : f));
    localError = null;
  }

  function setSource(name: string, source: Source): void {
    update(name, {
      touched: source !== 'skip',
      isNull: source === 'null',
    });
  }

  /** Typing is an answer: it moves the field to 'value' without a second
   *  control having to be operated first. */
  function setText(name: string, text: string): void {
    update(name, { text, touched: true, isNull: false });
  }

  function submit(event: Event): void {
    event.preventDefault();
    if (busy) return;
    const built = buildPayload(columns, fields, mode);
    if (!built.ok) {
      localError = built.error;
      return;
    }
    onsubmit(built.values);
  }

  const lockNote: Record<NonNullable<FieldState['lock']>, string> = {
    'primary-key': 'primary key - identifies the row being edited',
    privilege: 'your role may not write this column',
    'hint-readonly': 'marked read-only by this schema\'s UI hints',
    unrepresentable: 'this app cannot represent the stored value as text',
  };

  /** The foreign key a column participates in, as a hint. A composite key is
   *  named by the whole reference: which column of it this one lines up with is
   *  not something the relation record spells out. */
  function fkHint(name: string): string | null {
    const rel = relations.find((r) => (r.fields ?? [r.field]).includes(name));
    if (rel === undefined) return null;
    const ref = rel.references;
    const target = (ref.columns ?? [ref.column]).join(', ');
    return `${ref.schema}.${ref.table}(${target})`;
  }

  const required = (column: ColumnView): boolean =>
    !column.nullable && (column.defaultExpr === null || column.defaultExpr === undefined);
</script>

<form class="rowform" data-testid="row-form" onsubmit={submit}>
  <div class="head">
    <strong data-testid="row-form-mode">{mode === 'insert' ? 'New row' : 'Edit row'}</strong>
    <span class="hint">
      {mode === 'insert'
        ? 'Fields left at "database default" are not sent, so the database fills them in.'
        : 'Only the fields you change are sent.'}
    </span>
  </div>

  {#if seeded.anyReserialized}
    <p class="note" data-testid="row-form-reserialized">
      One or more values were re-serialized to fill this form (a json document, or a value with no
      textual form of its own). Saving such a field can differ from what is stored in formatting or
      number precision - a field you do not change is not sent at all.
    </p>
  {/if}

  <div class="fields">
    {#each fields as field (field.column)}
      {@const column = byName.get(field.column)}
      {#if column !== undefined}
        {@const kind = controlKind(column)}
        {@const fk = fkHint(column.name)}
        <div class="field" data-testid={`field-row-${column.name}`}>
          <div class="meta">
            <span class="cname">{column.name}</span>
            <span class="ctype"
              >{column.dataType}{column.nullable ? '' : ' NOT NULL'}{required(column)
                ? ' *'
                : ''}</span
            >
            {#if fk}<span class="fk" title="foreign key target">&rarr; {fk}</span>{/if}
          </div>

          {#if field.lock !== undefined}
            <div class="locked" data-testid={`field-locked-${column.name}`}>
              {#if field.text !== '' || field.isNull}
                <span class="frozen">{field.isNull ? 'NULL' : field.text}</span>
              {/if}
              <span class="why">{lockNote[field.lock]}</span>
            </div>
          {:else}
            <div class="control">
              <select
                data-testid={`field-source-${column.name}`}
                value={sourceOf(field)}
                disabled={busy}
                onchange={(e) => setSource(column.name, e.currentTarget.value as Source)}
              >
                <option value="skip">{skipLabel}</option>
                <option value="value">value</option>
                {#if column.nullable}<option value="null">NULL</option>{/if}
              </select>

              {#if kind === 'boolean'}
                <select
                  data-testid={`field-${column.name}`}
                  value={field.text === 'true' ? 'true' : 'false'}
                  disabled={busy || field.isNull}
                  onchange={(e) => setText(column.name, e.currentTarget.value)}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              {:else if kind === 'enum'}
                <select
                  data-testid={`field-${column.name}`}
                  value={field.text}
                  disabled={busy || field.isNull}
                  onchange={(e) => setText(column.name, e.currentTarget.value)}
                >
                  {#if !(column.enumValues ?? []).includes(field.text)}
                    <!-- The stored value is outside the type's labels (or the
                         field is unset): shown rather than silently replaced by
                         whichever label happens to be first. -->
                    <option value={field.text}>{field.text === '' ? '(choose)' : field.text}</option>
                  {/if}
                  {#each column.enumValues ?? [] as v (v)}
                    <option value={v}>{v}</option>
                  {/each}
                </select>
              {:else if kind === 'textarea'}
                <textarea
                  data-testid={`field-${column.name}`}
                  rows="3"
                  value={field.text}
                  disabled={busy || field.isNull}
                  oninput={(e) => setText(column.name, e.currentTarget.value)}
                ></textarea>
              {:else}
                <input
                  data-testid={`field-${column.name}`}
                  type="text"
                  value={field.text}
                  disabled={busy || field.isNull}
                  oninput={(e) => setText(column.name, e.currentTarget.value)}
                />
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  {#if localError}
    <p class="err" data-testid="row-form-invalid">{localError}</p>
  {/if}
  {#if error}
    <!-- The database's answer, re-authored by the worker: a fixed sentence for
         every status except 400, which describes the input. -->
    <p class="err" data-testid="row-form-error">{error}</p>
  {/if}

  <div class="actions">
    <button type="submit" data-testid="row-form-save" disabled={busy}>
      {busy ? 'saving...' : mode === 'insert' ? 'Insert row' : 'Save changes'}
    </button>
    <button type="button" data-testid="row-form-cancel" onclick={oncancel} disabled={busy}
      >cancel</button
    >
  </div>
</form>

<style>
  .rowform {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    border: 1px solid #d8e0f0;
    border-radius: 6px;
    background: #fbfcff;
    padding: 0.5rem 0.6rem;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .hint,
  .note {
    color: #888;
    font-size: 0.72rem;
    margin: 0;
  }
  .fields {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-height: 220px;
    overflow-y: auto;
  }
  .field {
    display: grid;
    grid-template-columns: 12rem 1fr;
    align-items: start;
    gap: 0.4rem;
  }
  .meta {
    display: flex;
    flex-direction: column;
    line-height: 1.2;
  }
  .cname {
    font-family: ui-monospace, monospace;
    font-size: 0.76rem;
  }
  .ctype,
  .fk,
  .why {
    color: #888;
    font-size: 0.68rem;
  }
  .fk {
    color: #1c5c38;
  }
  .control {
    display: flex;
    gap: 0.3rem;
    align-items: flex-start;
  }
  .control input,
  .control textarea,
  .control select,
  .actions button {
    font: inherit;
    font-size: 0.76rem;
    padding: 0.15rem 0.3rem;
    border: 1px solid #ccc;
    border-radius: 5px;
    background: #fff;
  }
  .control input,
  .control textarea {
    flex: 1;
    min-width: 0;
  }
  .control textarea {
    font-family: ui-monospace, monospace;
    resize: vertical;
  }
  .control input:disabled,
  .control textarea:disabled,
  .control select:disabled {
    background: #f4f4f4;
    color: #999;
  }
  .locked {
    display: flex;
    flex-direction: column;
    line-height: 1.2;
  }
  .frozen {
    font-family: ui-monospace, monospace;
    font-size: 0.74rem;
    color: #666;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .err {
    margin: 0;
    color: #a00;
    font-size: 0.75rem;
  }
  .actions {
    display: flex;
    gap: 0.4rem;
  }
  .actions button {
    cursor: pointer;
  }
  .actions button:disabled {
    color: #aaa;
    cursor: default;
  }
</style>
