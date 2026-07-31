<script lang="ts">
  // Row browsing for one relation. This is the first renderer code that calls a
  // `data:*` channel at all: everything above it (the main-owned gate, the
  // resident worker, @kozou/api) has been reachable only from tests until now.
  //
  // Three properties are deliberate rather than incidental:
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

  import type { ColumnView } from '../../shared/contextView';
  import type { DataListParams, DataResult } from '../../shared/types';

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

  /** Longest cell text rendered (and put in the tooltip). A json or text column
   *  can hold far more than a browse cell should carry into the DOM. */
  const MAX_CELL_CHARS = 500;

  const keyset = $derived(primaryKey.length > 0);

  let pageSize = $state(25);
  let sortColumn = $state('');
  let sortDir = $state<'asc' | 'desc'>('asc');
  let after = $state<string | null>(null);
  let before = $state<string | null>(null);

  let rows = $state<Record<string, unknown>[]>([]);
  let nextCursor = $state<string | null>(null);
  let prevCursor = $state<string | null>(null);
  let pageNo = $state(1);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let loaded = $state(false);

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

  /** `target` is the position this request navigates to. It is applied only
   *  once the rows land: advancing the counter on the click would label the
   *  page still on screen as the next one, which is both a lie and a way for a
   *  reader to attribute rows to the wrong page. */
  async function load(target: number = pageNo): Promise<void> {
    const mine = ++seq;
    loading = true;
    error = null;
    const params: DataListParams = {
      pageSize,
      ...(sortSpec !== undefined ? { sort: sortSpec } : {}),
      ...(after !== null ? { after } : {}),
      ...(before !== null ? { before } : {}),
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
      error = message(err);
      return;
    }
    if (mine !== seq) return;
    loading = false;
    loaded = true;
    if (!result.ok) {
      rows = [];
      nextCursor = null;
      prevCursor = null;
      error = result.message;
      return;
    }
    const page = parsePage(result.body);
    if (page === null) {
      rows = [];
      nextCursor = null;
      prevCursor = null;
      error = 'The database returned rows in a shape this build does not understand.';
      return;
    }
    rows = page.rows;
    nextCursor = page.nextCursor;
    prevCursor = page.prevCursor;
    pageNo = target;
  }

  /** Restart the traversal: used on mount and whenever a control that the
   *  cursors depend on changes. */
  function first(): void {
    after = null;
    before = null;
    void load(1);
  }

  function next(): void {
    if (nextCursor === null) return;
    after = nextCursor;
    before = null;
    void load(pageNo + 1);
  }

  function prev(): void {
    if (prevCursor === null) return;
    before = prevCursor;
    after = null;
    void load(Math.max(1, pageNo - 1));
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
        {#each columns as c (c.name)}
          <option value={c.name}>{c.name}</option>
        {/each}
      </select>
    </label>
    <select
      data-testid="data-sort-dir"
      value={sortDir}
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
    <button data-testid="data-reload" onclick={() => void load()} disabled={loading}>reload</button>
  </div>

  {#if !keyset}
    <p class="note" data-testid="data-no-keyset">
      No primary key, so this relation has no total order and kozou offers no page cursors - the
      first {pageSize} rows in the chosen order are all this pane can reach.
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
                <td>
                  {#if row[c.name] === null || row[c.name] === undefined}
                    <span class="null">NULL</span>
                  {:else}
                    {@const text = cellText(row[c.name])}
                    <span class="val" title={text}>{text}</span>
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
      <span class="pos" data-testid="data-position">page {pageNo} - {rows.length} rows</span>
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
  .controls button:disabled {
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
