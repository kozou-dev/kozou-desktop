<script lang="ts">
  import type { ContextView } from '../../shared/contextView';
  import type { AiViews, RowAccess } from '../../shared/types';
  import CommentEditor from './CommentEditor.svelte';
  import DataPanel from './DataPanel.svelte';
  import JsonTree from './JsonTree.svelte';
  import { describeTarget, type CommentTarget } from './lib/commentEmit';

  let {
    context,
    aiViews,
    selected,
    profile,
    rowAccess,
    epoch,
    ondraft,
  }: {
    context: ContextView;
    aiViews: AiViews;
    selected: string;
    profile: string;
    /** Hand a generated statement to the app's session draft list. The pane
     *  never applies one: emitting is the whole of what this does. */
    ondraft: (target: string, sql: string) => void;
    /** This profile's row-data grant. 'off' hides the Data tab entirely: with
     *  no grant, main refuses every `data:*` call, so offering the tab would
     *  only promise something the gate would then deny. */
    rowAccess: RowAccess;
    /** Bumped by the app whenever a profile's identity or grant changes, so a
     *  browse panel cannot carry cursors across that boundary. */
    epoch: number;
  } = $props();

  type Tab = 'human' | 'ai' | 'raw' | 'data';
  let tab = $state<Tab>('human');

  const canBrowse = $derived(rowAccess !== 'off');
  // Revoking the grant while the Data tab is open must take the tab away, not
  // leave a dead panel selected.
  const activeTab = $derived<Tab>(tab === 'data' && !canBrowse ? 'human' : tab);

  const table = $derived(context.tables.find((t) => t.qualifiedName === selected) ?? null);
  const view = $derived(context.views.find((v) => v.qualifiedName === selected) ?? null);
  const entity = $derived(table ?? view);
  // Ghost-ness is derived from the CURRENT context, never from a snapshot
  // taken at click time: after a re-inspect (e.g. the user added the schema,
  // exactly as this pane suggests) the same id may now be a real relation —
  // a stale snapshot would keep asserting a false explanation.
  const isGhost = $derived(
    !entity &&
      context.views.some((v) => v.underlyingTables.some((u) => `${u.schema}.${u.name}` === selected)),
  );
  /** Whether the browse panel may offer write controls for what is selected.
   *  Three conditions, each of which is a different kind of "no":
   *
   *    * the grant: 'readwrite' is what main's gate requires, so anything less
   *      would only produce a refusal;
   *    * a view: kozou answers a write to one with a 405, and offering the
   *      controls anyway would be a promise the REST layer never made;
   *    * no primary key: an item route is addressed by one, so there is no id
   *      to send and no row to send it about.
   *
   *  Nothing below this depends on the grant alone — the panel is handed the
   *  conclusion, not the level. */
  const canEdit = $derived(
    rowAccess === 'readwrite' && table !== null && table.primaryKey.length > 0,
  );

  const concept = $derived(view ? (context.concepts.find((c) => c.name === view.name) ?? null) : null);
  const aiText = $derived.by(() => {
    if (table) return aiViews.tables[selected] ?? null;
    if (view) {
      const parts = [aiViews.views[selected]];
      if (concept && aiViews.concepts[concept.name]) {
        parts.push(`// get_concept_context("${concept.name}")`, aiViews.concepts[concept.name]!);
      }
      return parts.filter(Boolean).join('\n\n');
    }
    return null;
  });

  const aiLines = (text: string | null): string[] => (text ? text.split('\n').filter((l) => l.trim() !== '') : []);

  /** The relation as a COMMENT target, or null when it cannot be named in DDL.
   *  The one case that happens: a view whose relkind could not be established —
   *  `COMMENT ON VIEW` and `COMMENT ON MATERIALIZED VIEW` are not
   *  interchangeable, and each is an error against the other kind, so guessing
   *  would emit a statement the database rejects. Columns are unaffected:
   *  `COMMENT ON COLUMN` addresses all three relation kinds alike. */
  const relationTarget = $derived.by<CommentTarget | null>(() => {
    if (table) return { kind: 'table', schema: table.schema, name: table.name };
    if (view && view.materialized !== undefined) {
      return { kind: 'view', schema: view.schema, name: view.name, materialized: view.materialized };
    }
    return null;
  });

  type OpenEditor = { target: CommentTarget; label: string; current: string | null | undefined };
  let editing = $state<OpenEditor | null>(null);

  $effect(() => {
    // A different relation — or the same one re-inspected — invalidates an open
    // editor: its seed is a copy of a payload that no longer applies.
    void selected;
    void context;
    editing = null;
  });

  function editRelation(): void {
    if (relationTarget === null || !entity) return;
    editing = {
      target: relationTarget,
      label: describeTarget(relationTarget),
      current: entity.rawComment,
    };
  }

  function editColumn(name: string, current: string | null | undefined): void {
    if (!entity) return;
    const target: CommentTarget = {
      kind: 'column',
      schema: entity.schema,
      relation: entity.name,
      column: name,
    };
    editing = { target, label: describeTarget(target), current };
  }

  function draft(sql: string): void {
    if (editing === null) return;
    ondraft(editing.label, sql);
    editing = null;
  }
</script>

<aside class="detail" data-testid="detail-pane">
  {#if isGhost}
    <p class="empty">
      <code>{selected}</code> is outside this profile's configured schemas - it appears because a
      view reads from it. Add its schema to the profile to inspect it.
    </p>
  {:else if !entity}
    <!-- Never claim "outside configured schemas" from mere absence: a stale
         selection would turn that into a false insight. -->
    <p class="empty">This relation is not part of the currently selected profile.</p>
  {:else}
    <header>
      <span class="kind {table ? 'table' : 'view'}">{table ? 'TABLE' : 'VIEW'}</span>
      <h3>{entity.qualifiedName}</h3>
    </header>

    <nav class="tabs">
      <button class:active={activeTab === 'human'} onclick={() => (tab = 'human')}>Semantics</button>
      <button class:active={activeTab === 'ai'} onclick={() => (tab = 'ai')} data-testid="tab-ai">AI view</button>
      <button class:active={activeTab === 'raw'} onclick={() => (tab = 'raw')}>Raw</button>
      {#if canBrowse}
        <button class:active={activeTab === 'data'} onclick={() => (tab = 'data')} data-testid="tab-data"
          >Data</button
        >
      {/if}
    </nav>

    {#if activeTab === 'human'}
      <section>
        <h4>
          Comment
          {#if relationTarget !== null}
            <button class="edit" data-testid="edit-relation-comment" onclick={editRelation}>Edit</button>
          {/if}
        </h4>
        {#if entity.description}
          <pre class="comment">{entity.description}</pre>
        {:else}
          <p class="hint">No COMMENT on this relation.</p>
        {/if}
        {#if view && view.materialized === undefined}
          <p class="hint" data-testid="relkind-unknown">
            Whether this view is materialized could not be read from the catalog, and the two need
            different <code>COMMENT ON</code> keywords - so no statement is offered for the view
            itself. Its columns can still be commented. Re-inspect to try again.
          </p>
        {/if}
      </section>
      {#if editing !== null && editing.target.kind !== 'column'}
        <CommentEditor
          target={editing.target}
          label={editing.label}
          current={editing.current}
          ondraft={draft}
          oncancel={() => (editing = null)}
        />
      {/if}
      {#if entity.aiDescription}
        <section>
          <h4>@ai</h4>
          <ul class="ai">{#each aiLines(entity.aiDescription) as line}<li>{line}</li>{/each}</ul>
        </section>
      {/if}
      {#if (entity.policy ?? []).length > 0}
        <section>
          <h4>@policy <span class="hint">(advisory - enforced by your database, not kozou)</span></h4>
          <ul class="policy">{#each entity.policy ?? [] as p}<li>{p}</li>{/each}</ul>
        </section>
      {/if}
      {#if table?.rowSecurity?.enabled}
        <section>
          <h4>Row-level security</h4>
          <p class="rls">
            enabled{table.rowSecurity.forced ? ', forced' : ''}{table.rowSecurity.hasPolicies
              ? ', policies present'
              : ', no policies (default-deny for non-owners)'} - results seen through a role may be filtered.
          </p>
        </section>
      {/if}

      <section>
        <h4>Columns ({entity.columns.length})</h4>
        <table class="cols">
          <tbody>
            {#each entity.columns as c (c.name)}
              <tr>
                <td class="cname">{c.name}{c.isPrimaryKey ? ' *' : ''}{c.isForeignKey ? ' ->' : ''}</td>
                <td class="ctype">{c.dataType}{c.nullable ? '' : ' NOT NULL'}</td>
                <td class="cdesc"
                  >{c.description ? c.description.split('\n', 1)[0] : ''}{c.enumValues
                    ? ` [${c.enumValues.join(' | ')}]`
                    : ''}</td
                >
                <td class="cedit">
                  <button
                    class="edit"
                    data-testid={`edit-column-comment-${c.name}`}
                    onclick={() => editColumn(c.name, c.rawComment)}>Edit</button
                  >
                </td>
              </tr>
              {#if editing !== null && editing.target.kind === 'column' && editing.target.column === c.name}
                <tr>
                  <td colspan="4">
                    <CommentEditor
                      target={editing.target}
                      label={editing.label}
                      current={editing.current}
                      ondraft={draft}
                      oncancel={() => (editing = null)}
                    />
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </section>

      {#if table && table.relations.length > 0}
        <section>
          <h4>Relations</h4>
          <ul class="rels">
            {#each table.relations as r}
              <li>
                <code>{(r.fields ?? [r.field]).join(', ')}</code> -&gt;
                <code>{r.references.schema}.{r.references.table}</code>
                {#if r.meaning}<span class="meaning">- {r.meaning}</span>{/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if view}
        <section>
          <h4>Reads from</h4>
          <ul class="rels">
            {#each view.underlyingTables as u}<li><code>{u.schema}.{u.name}</code></li>{/each}
          </ul>
        </section>
      {/if}

      {#if concept && concept.joinSuggestions.length > 0}
        <section>
          <h4>Join suggestions</h4>
          <ul class="rels">
            {#each concept.joinSuggestions as j}
              <li><code>{j.table}</code> on <code>{j.on}</code>{#if j.meaning}<span class="meaning"> - {j.meaning}</span>{/if}</li>
            {/each}
          </ul>
        </section>
      {/if}
      {#if concept && concept.exampleQueries.length > 0}
        <section>
          <h4>Example queries</h4>
          {#each concept.exampleQueries as ex}
            <p class="hint">{ex.description}</p>
            <pre class="sql">{ex.sql}</pre>
          {/each}
        </section>
      {/if}
    {:else if activeTab === 'data'}
      <!-- Keyed so a profile re-save, a grant change or a different relation
           builds a fresh panel: cursors and rows belong to the connection and
           the grant they were fetched under, never to the name on the card. -->
      {#key `${profile}|${epoch}|${entity.qualifiedName}`}
        <DataPanel
          {profile}
          resource={entity.qualifiedName}
          columns={entity.columns}
          primaryKey={table?.primaryKey ?? []}
          relations={table?.relations ?? []}
          {canEdit}
        />
      {/key}
    {:else if activeTab === 'ai'}
      <p class="hint">
        What an AI agent receives from the MCP describe tools of a default-configured kozou server
        for this relation - same functions, same serialization. Server-side opt-ins (RPC exposure
        config, privilege-aware annotations) are not reproduced here yet.
      </p>
      <pre class="aiview" data-testid="ai-view">{aiText ?? '(no AI view available)'}</pre>
    {:else}
      <div class="rawtree"><JsonTree name={entity.qualifiedName} value={entity} open /></div>
    {/if}
  {/if}
</aside>

<style>
  .detail {
    border: 1px solid #e2e2e2;
    border-radius: 8px;
    background: #fff;
    padding: 0.75rem 1rem;
    overflow-y: auto;
    height: 460px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  h3 {
    margin: 0;
    font-size: 0.95rem;
    font-family: ui-monospace, monospace;
  }
  h4 {
    margin: 0.4rem 0 0.25rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #666;
  }
  .kind {
    font-size: 0.65rem;
    font-weight: 700;
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
    background: #e8eefb;
    color: #35577d;
  }
  .kind.view {
    background: #f0e8fb;
    color: #6a3d8f;
  }
  .tabs {
    display: flex;
    gap: 0.4rem;
    margin: 0.6rem 0;
  }
  .tabs button {
    padding: 0.2rem 0.7rem;
    border: 1px solid #ccc;
    border-radius: 999px;
    background: #fff;
    cursor: pointer;
    font-size: 0.78rem;
  }
  .tabs button.active {
    background: #eef3ff;
    border-color: #2f6fed;
  }
  pre {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.78rem;
    background: #fafafa;
    border: 1px solid #eee;
    border-radius: 6px;
    padding: 0.5rem;
    margin: 0.2rem 0;
  }
  .aiview {
    font-family: ui-monospace, monospace;
  }
  ul {
    margin: 0.2rem 0;
    padding-left: 1.2rem;
    font-size: 0.82rem;
  }
  .policy li {
    color: #7a4b00;
  }
  .ai li {
    color: #1c5c38;
  }
  .rls {
    font-size: 0.82rem;
    color: #5d3a8e;
  }
  table.cols {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.78rem;
  }
  table.cols td {
    padding: 0.15rem 0.4rem 0.15rem 0;
    border-bottom: 1px solid #f0f0f0;
    vertical-align: top;
  }
  .cname {
    font-family: ui-monospace, monospace;
    white-space: nowrap;
  }
  .ctype {
    color: #666;
    white-space: nowrap;
  }
  .cdesc {
    color: #555;
  }
  .cedit {
    text-align: right;
    white-space: nowrap;
  }
  button.edit {
    margin-left: 0.4rem;
    padding: 0.05rem 0.4rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
    font-size: 0.7rem;
    color: #35577d;
    text-transform: none;
    letter-spacing: 0;
  }
  .meaning {
    color: #1c5c38;
  }
  .hint {
    color: #888;
    font-size: 0.75rem;
  }
  .empty {
    color: #888;
  }
  .rawtree {
    overflow-x: auto;
  }
  .sql {
    font-family: ui-monospace, monospace;
  }
</style>
