<script lang="ts">
  import type { ContextView } from '../../shared/contextView';
  import type { AiViews, RowAccess } from '../../shared/types';
  import AiView from './AiView.svelte';
  import CommentEditor from './CommentEditor.svelte';
  import DataPanel from './DataPanel.svelte';
  import JsonTree from './JsonTree.svelte';
  import { relationAiBlocks } from './lib/aiViewBlocks';
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
  // One block per tool result. A view that backs a concept produces two of
  // them, because that is two calls an agent makes — not one payload with a
  // separator line, which is what this used to render (see lib/aiViewBlocks).
  const aiBlocks = $derived.by(() => {
    if (table) return relationAiBlocks('table', selected, aiViews, null);
    if (view) return relationAiBlocks('view', selected, aiViews, concept?.name ?? null);
    return [];
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

  type OpenEditor = {
    /** What the editor was opened against: the relation, and the payload the
     *  seed was copied out of. Both are CHECKED rather than cleared by an
     *  effect. An effect runs after the DOM has been rendered from the new
     *  selection, so a column of the same name on another relation would render
     *  the previous relation's text for a frame — with the previous relation as
     *  its emit target. Deriving the answer instead means there is no frame in
     *  which that is true. */
    for: string;
    from: ContextView;
    target: CommentTarget;
    label: string;
    current: string | null | undefined;
    /** What has been typed so far. Held HERE rather than in the editor
     *  component: the editor renders inside the Semantics branch, so visiting
     *  another tab unmounts it — and a value that lived in the child would come
     *  back as the database seed, with the operator's text discarded and nothing
     *  said about it. */
    text: string;
  };
  let editing = $state<OpenEditor | null>(null);

  /** The open editor, if it still belongs to what is on screen. A different
   *  relation, or the same one re-inspected, invalidates it: its seed is a copy
   *  of a payload that no longer applies. */
  const activeEditor = $derived(
    editing !== null && editing.for === selected && editing.from === context ? editing : null,
  );

  function editRelation(): void {
    if (relationTarget === null || !entity) return;
    editing = {
      for: selected,
      from: context,
      target: relationTarget,
      label: describeTarget(relationTarget),
      current: entity.rawComment,
      text: entity.rawComment ?? '',
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
    editing = {
      for: selected,
      from: context,
      target,
      label: describeTarget(target),
      current,
      text: current ?? '',
    };
  }

  function draft(sql: string): void {
    if (activeEditor === null) return;
    ondraft(activeEditor.label, sql);
    editing = null;
  }

  function retype(next: string): void {
    if (editing === null) return;
    editing = { ...editing, text: next };
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
        {:else if entity.rawComment}
          <!-- The rendered description is empty while the COMMENT is not: one
               made only of `@widget:`/`@example:` lifts entirely out of that
               field. Answering "no COMMENT" from it would be the same mistake
               this feature exists to avoid, so the verbatim text answers. -->
          <p class="hint">
            This COMMENT is made entirely of tags that are surfaced elsewhere - Edit shows it as
            written.
          </p>
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
      {#if activeEditor !== null && activeEditor.target.kind !== 'column'}
        <CommentEditor
          target={activeEditor.target}
          label={activeEditor.label}
          current={activeEditor.current}
          text={activeEditor.text}
          ontext={retype}
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
              {#if activeEditor !== null && activeEditor.target.kind === 'column' && activeEditor.target.column === c.name}
                <tr>
                  <td colspan="4">
                    <CommentEditor
                      target={activeEditor.target}
                      label={activeEditor.label}
                      current={activeEditor.current}
                      text={activeEditor.text}
                      ontext={retype}
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
      <AiView blocks={aiBlocks} testid="ai-view" />
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
    /* Was a hard 460px, which ignored the window: a tall display gained nothing
       and the pane an operator edits and browses rows in stayed the same size.
       The grid row above supplies the height now. */
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
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
