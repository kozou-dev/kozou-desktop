<script lang="ts">
  // Row browsing for one relation. This is the first renderer code that calls a
  // `data:*` channel at all: everything above it (the main-owned gate, the
  // resident worker, @kozou/api) has been reachable only from tests until now.
  //
  // Four properties are deliberate rather than incidental:
  //
  //   * Paging is keyset, never offset. The worker asks for `count=none`, so
  //     there is no total to page against — and a cursor walk stays O(page) at
  //     any depth. A resource with no primary key has no total order, so kozou
  //     offers it no cursors; that case shows one page and says why.
  //   * Changing the sort invalidates the cursors. They encode the ORDER BY
  //     they were issued for and the query builder rejects a mismatch, so a
  //     sort change restarts the traversal instead of sending a stale cursor.
  //   * A superseded response never lands. Every request carries a sequence
  //     number and only the newest one may write to the panel; the panel is
  //     also remounted when the profile's identity changes, so rows fetched
  //     from a previous database cannot survive into the next one.
  //   * This pane is a preview, not a viewer. The worker cuts values that
  //     exceed DATA_VALUE_BUDGET before a page is serialized, so nothing here
  //     can show a large value in full — and every cut is reported and shown
  //     rather than left to look like the value. The same limit applies to the
  //     cursors: sorting by a column whose values are too large to fit one ends
  //     the walk, and the pane says so instead of offering a dead button.

  import type { ColumnView } from '../../shared/contextView';
  import {
    DATA_CELL_PREVIEW_CHARS,
    DATA_VALUE_BUDGET,
    type DataListParams,
    type DataResult,
    type DataTruncation,
  } from '../../shared/types';

  let {
    profile,
    resource,
    columns,
    primaryKey,
  }: {
    profile: string;
    /** Schema-qualified name — what the worker's resource lookup resolves. */
    resource: string;
    columns: ColumnView[];
    /** Empty for a view or a table without one: no total order, no cursors. */
    primaryKey: string[];
  } = $props();

  const api = window.kozouDesktop;

  /** Page sizes offered. The ceiling is the wire limit main validates against
   *  (DATA_MAX_PAGE_SIZE); the default is small because this pane is narrow. */
  const PAGE_SIZES = [10, 25, 50, 100, 200];

  /** Longest cell text rendered (and put in the tooltip). Shared with the wire
   *  budget so the two cannot cross: a json or text column can hold far more
   *  than a browse cell should carry into the DOM, and more than the worker
   *  will hand over in the first place. */
  const MAX_CELL_CHARS = DATA_CELL_PREVIEW_CHARS;

  const keyset = $derived(primaryKey.length > 0);

  /** Columns offered for sorting. The REST layer's sort grammar splits on
   *  commas and has no identifier escaping, so a column whose name contains one
   *  cannot be expressed in it — offering it would only ever produce a 400. */
  const sortable = $derived(columns.filter((c) => !c.name.includes(',')));
  const unsortable = $derived(columns.length - sortable.length);

  let pageSize = $state(25);
  let sortColumn = $state('');
  let sortDir = $state<'asc' | 'desc'>('asc');

  /** Where the rows on screen came from. Committed only when a page lands, so a
   *  failed navigation leaves the panel describing what it is actually showing
   *  — otherwise a reload would fetch the page we failed to reach and label it
   *  with the position we never left.
   *
   *  `step` counts the successful hops of this traversal, and that is all it
   *  claims to be. There is no total (`count=none`) and no snapshot, so it is
   *  deliberately not shown as a page index: concurrent inserts and deletes
   *  shift what an ordinal page would mean, and after an emptied page the
   *  counter could name a page that exists in no ordering. A cursor walk knows
   *  how far it has walked, not where that lands in the table. */
  type Position = { after: string | null; before: string | null; step: number };
  const START: Position = { after: null, before: null, step: 1 };
  let pos = $state<Position>(START);

  let rows = $state<Record<string, unknown>[]>([]);
  let nextCursor = $state<string | null>(null);
  let prevCursor = $state<string | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let loaded = $state(false);

  /** The cuts the worker made in the page on screen, keyed by row index and
   *  column. Rebuilt with every page — a cut describes the rows it was made in
   *  and must never outlive them onto a page that was not cut. */
  let cuts = $state(new Map<string, DataTruncation>());
  const cutKey = (row: number, column: string): string => `${row}\u0000${column}`;
  const cutsByCell = (list: DataTruncation[] | undefined): Map<string, DataTruncation> =>
    new Map((list ?? []).map((cut) => [cutKey(cut.row, cut.column), cut]));

  /** Directions the worker refused to hand a cursor for, because the boundary
   *  row's ordering value would not fit one. The button is dead either way —
   *  there is no cursor — and this is what turns that into an explanation
   *  instead of a pager that just stops. */
  let droppedCursors = $state<('next' | 'prev')[]>([]);

  const atStart = $derived(pos.after === null && pos.before === null);

  /** Only the newest request may write to the panel. Bumped on every load, so
   *  a slow first page cannot overwrite the page the operator has moved on to. */
  let seq = 0;

  const sortSpec = $derived(sortColumn === '' ? undefined : `${sortColumn}.${sortDir}`);

  type ListPage = {
    rows: Record<string, unknown>[];
    nextCursor: string | null;
    prevCursor: string | null;
  };

  /** The worker hands back @kozou/api's wire body as `unknown`. Read it
   *  defensively: a shape we do not recognize is an error to show, not a
   *  half-rendered table. */
  function parsePage(body: unknown): ListPage | null {
    if (typeof body !== 'object' || body === null) return null;
    const b = body as { rows?: unknown; nextCursor?: unknown; prevCursor?: unknown };
    if (!Array.isArray(b.rows)) return null;
    return {
      rows: b.rows as Record<string, unknown>[],
      nextCursor: typeof b.nextCursor === 'string' ? b.nextCursor : null,
      prevCursor: typeof b.prevCursor === 'string' ? b.prevCursor : null,
    };
  }

  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  /** `target` is the position this request navigates to. Nothing about it is
   *  committed until the rows land: advancing on the click would label the page
   *  still on screen as the next one, and leaving the cursor behind on a failure
   *  would make the next reload fetch the page we failed to reach under the page
   *  number we never left. */
  async function load(target: Position): Promise<void> {
    const mine = ++seq;
    loading = true;
    error = null;
    const params: DataListParams = {
      pageSize,
      ...(sortSpec !== undefined ? { sort: sortSpec } : {}),
      ...(target.after !== null ? { after: target.after } : {}),
      ...(target.before !== null ? { before: target.before } : {}),
    };
    let result: DataResult;
    try {
      result = await api.dataList(profile, resource, params);
    } catch (err) {
      // A rejection is main's gate refusing the call — the profile's grant was
      // revoked while this panel was open, or the profile is gone.
      if (mine !== seq) return;
      loading = false;
      loaded = true;
      rows = [];
      cuts = new Map();
      droppedCursors = [];
      error = message(err);
      return;
    }
    if (mine !== seq) return;
    loading = false;
    loaded = true;
    if (!result.ok) {
      rows = [];
      cuts = new Map();
      droppedCursors = [];
      nextCursor = null;
      prevCursor = null;
      error = result.message;
      return;
    }
    const page = parsePage(result.body);
    if (page === null) {
      rows = [];
      cuts = new Map();
      droppedCursors = [];
      nextCursor = null;
      prevCursor = null;
      error = 'The database returned rows in a shape this build does not understand.';
      return;
    }
    rows = page.rows;
    cuts = cutsByCell(result.truncated);
    droppedCursors = result.droppedCursors ?? [];
    nextCursor = page.nextCursor;
    prevCursor = page.prevCursor;
    pos = target;
  }

  /** Restart the traversal: used on mount, whenever a control the cursors
   *  depend on changes, and as the way out of a position with no cursors —
   *  a page that came back empty (every row past the boundary was deleted)
   *  yields neither a next nor a prev, so "back to the start" has to exist. */
  function first(): void {
    void load(START);
  }

  function next(): void {
    if (nextCursor === null) return;
    void load({ after: nextCursor, before: null, step: pos.step + 1 });
  }

  function prev(): void {
    if (prevCursor === null) return;
    void load({ after: null, before: prevCursor, step: Math.max(1, pos.step - 1) });
  }

  function reload(): void {
    void load(pos);
  }

  function changeSort(column: string): void {
    sortColumn = column;
    first();
  }

  function changeDir(dir: 'asc' | 'desc'): void {
    sortDir = dir;
    first();
  }

  function changePageSize(size: number): void {
    pageSize = size;
    first();
  }

  /** A value as one line of text. Dates survive structured clone as Dates, and
   *  bytea arrives as a byte array — neither has a useful default rendering. */
  function formatCell(value: unknown): string {
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array) return `${value.byteLength} bytes`;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return '(unrenderable value)';
    }
  }

  function cellText(value: unknown): string {
    const text = formatCell(value);
    return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}...` : text;
  }

  /** How a cut is worded. Text and bytes kept a leading slice, so the cell shows
   *  it and says it is not the whole value; a json value was dropped entirely,
   *  so there is nothing to show and the cell says that instead of NULL. */
  function cutNote(cut: DataTruncation): string {
    if (cut.kind === 'text') return `Truncated by this app: ${cut.size} characters in the database.`;
    if (cut.kind === 'bytes') return `Truncated by this app: ${cut.size} bytes in the database.`;
    if (cut.kind === 'json') return `Not shown: a json value larger than ${cut.size} characters.`;
    // Deliberately not phrased as "too large": its size was never established,
    // which is exactly why it was not carried.
    return 'Not shown: this app could not establish how large this value is.';
  }

  /** A cell whose value did not travel at all, so the cell has to say what is
   *  missing rather than render a null the database never returned. */
  const dropped = (cut: DataTruncation | undefined): boolean =>
    cut !== undefined && (cut.kind === 'json' || cut.kind === 'unmeasurable');

  const droppedLabel = (cut: DataTruncation): string =>
    cut.kind === 'json' ? '(json value too large)' : '(value not measurable)';

  first();
</script>

<div class="data" data-testid="data-panel">
  <div class="controls">
    <label>
      sort
      <select
        data-testid="data-sort-column"
        value={sortColumn}
        onchange={(e) => changeSort(e.currentTarget.value)}
      >
        <option value="">(default order)</option>
        {#each sortable as c (c.name)}
          <option value={c.name}>{c.name}</option>
        {/each}
      </select>
    </label>
    <!-- Disabled under "(default order)": no sort is sent then, so an enabled
         direction would report one the rows do not have. -->
    <select
      data-testid="data-sort-dir"
      value={sortDir}
      disabled={sortColumn === ''}
      onchange={(e) => changeDir(e.currentTarget.value as 'asc' | 'desc')}
    >
      <option value="asc">asc</option>
      <option value="desc">desc</option>
    </select>
    <label>
      rows
      <select
        data-testid="data-page-size"
        value={pageSize}
        onchange={(e) => changePageSize(Number(e.currentTarget.value))}
      >
        {#each PAGE_SIZES as size (size)}
          <option value={size}>{size}</option>
        {/each}
      </select>
    </label>
    <button data-testid="data-reload" onclick={reload} disabled={loading}>reload</button>
    {#if !atStart}
      <button data-testid="data-first" onclick={first} disabled={loading}>&laquo; first page</button>
    {/if}
  </div>

  {#if !keyset}
    <p class="note" data-testid="data-no-keyset">
      No primary key, so this relation has no total order and kozou offers no page cursors - the
      first {pageSize} rows in the chosen order are all this pane can reach.
    </p>
  {/if}
  {#if unsortable > 0}
    <p class="note" data-testid="data-unsortable">
      {unsortable} column{unsortable === 1 ? '' : 's'} cannot be sorted here: the sort grammar
      separates columns with commas, and their names contain one.
    </p>
  {/if}
  {#if cuts.size > 0}
    <p class="note" data-testid="data-truncated">
      {cuts.size} value{cuts.size === 1 ? '' : 's'} on this page {cuts.size === 1 ? 'was' : 'were'} cut
      before the rows left the database connection: text and binary values keep their first {DATA_VALUE_BUDGET}
      characters or bytes, and a larger json value is dropped. This pane is a preview, not a viewer.
    </p>
  {/if}
  {#if droppedCursors.length > 0}
    <p class="note" data-testid="data-cursor-limit">
      The walk stops here ({droppedCursors.join(' and ')}): a page cursor carries the sort values of
      the row it stops at, and this one is too large to hand back. Sort by another column, or start
      again from the first page.
    </p>
  {/if}

  {#if error}
    <p class="err" data-testid="data-error">{error}</p>
  {/if}

  {#if loading && !loaded}
    <p class="note" data-testid="data-loading">Loading rows...</p>
  {:else if loaded && !error && rows.length === 0}
    <p class="note" data-testid="data-empty">No rows.</p>
  {/if}

  {#if rows.length > 0}
    <!-- While a request is in flight the previous page is still on screen; dim
         it so it is not read as the page the controls now describe. -->
    <div class="grid-wrap" class:stale={loading}>
      <table class="grid" data-testid="data-grid">
        <thead>
          <tr>
            {#each columns as c (c.name)}
              <th class:pk={c.isPrimaryKey} title={c.dataType}>{c.name}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each rows as row, i (i)}
            <tr>
              {#each columns as c (c.name)}
                {@const cut = cuts.get(cutKey(i, c.name))}
                <td>
                  {#if cut !== undefined && dropped(cut)}
                    <!-- The value was replaced by null on the way here, so this
                         must not be rendered as a NULL the database returned. -->
                    <span class="dropped" data-testid="data-cut" title={cutNote(cut)}
                      >{droppedLabel(cut)}</span
                    >
                  {:else if row[c.name] === null || row[c.name] === undefined}
                    <span class="null">NULL</span>
                  {:else}
                    {@const text = cellText(row[c.name])}
                    <span
                      class="val"
                      title={cut === undefined ? text : `${text}\n\n${cutNote(cut)}`}>{text}</span
                    >{#if cut !== undefined}<span class="cut" data-testid="data-cut">cut</span>{/if}
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if keyset}
    <div class="pager">
      <button data-testid="data-prev" onclick={prev} disabled={loading || prevCursor === null}
        >&larr; prev</button
      >
      <!-- A traversal position, deliberately not a page index: with count=none
           there is no total to index into, and nothing here licenses the
           arithmetic a page number invites. -->
      <span
        class="pos"
        data-testid="data-position"
        title="Steps taken in this cursor walk. There is no row count, so this is not a page number - it says how far the walk has come, not how many rows lie before these."
        >step {pos.step} - {rows.length} rows</span
      >
      <button data-testid="data-next" onclick={next} disabled={loading || nextCursor === null}
        >next &rarr;</button
      >
    </div>
  {:else if rows.length > 0}
    <div class="pager"><span class="pos" data-testid="data-position">{rows.length} rows</span></div>
  {/if}
</div>

<style>
  .data {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: 0.78rem;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .controls label {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    color: #666;
  }
  .controls select,
  .controls button {
    font: inherit;
    padding: 0.15rem 0.3rem;
    border: 1px solid #ccc;
    border-radius: 6px;
    background: #fff;
  }
  .controls button {
    cursor: pointer;
  }
  .controls button:disabled,
  .controls select:disabled {
    color: #aaa;
    cursor: default;
  }
  .note {
    margin: 0;
    color: #888;
    font-size: 0.75rem;
  }
  .err {
    margin: 0;
    color: #a00;
  }
  .grid-wrap {
    overflow-x: auto;
    border: 1px solid #eee;
    border-radius: 6px;
  }
  .grid-wrap.stale {
    opacity: 0.5;
  }
  table.grid {
    border-collapse: collapse;
    font-size: 0.75rem;
  }
  table.grid th {
    text-align: left;
    font-weight: 600;
    color: #555;
    background: #fafafa;
    border-bottom: 1px solid #e6e6e6;
    padding: 0.2rem 0.45rem;
    white-space: nowrap;
    position: sticky;
    top: 0;
  }
  table.grid th.pk {
    color: #35577d;
  }
  table.grid td {
    border-bottom: 1px solid #f2f2f2;
    padding: 0.15rem 0.45rem;
    vertical-align: top;
  }
  .val {
    display: inline-block;
    max-width: 22ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
    font-family: ui-monospace, monospace;
  }
  .null {
    color: #bbb;
    font-style: italic;
  }
  /* A cut value must not look like a whole one: the badge rides next to the
     text, and a dropped json value reads differently from a NULL. */
  .cut {
    margin-left: 0.25rem;
    padding: 0 0.2rem;
    border-radius: 4px;
    background: #f4ece0;
    color: #8a6d3b;
    font-size: 0.65rem;
    vertical-align: text-top;
  }
  .dropped {
    color: #8a6d3b;
    font-style: italic;
  }
  .pager {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .pager button {
    font: inherit;
    padding: 0.15rem 0.5rem;
    border: 1px solid #ccc;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
  }
  .pager button:disabled {
    color: #bbb;
    cursor: default;
  }
  .pos {
    color: #777;
  }
</style>
