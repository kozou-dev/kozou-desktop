<script lang="ts">
  import type { ContextView } from '../../shared/contextView';
  import type { AiViews } from '../../shared/types';
  import JsonTree from './JsonTree.svelte';

  let {
    context,
    aiViews,
    selected,
  }: { context: ContextView; aiViews: AiViews; selected: string } = $props();

  type Tab = 'human' | 'ai' | 'raw';
  let tab = $state<Tab>('human');

  const table = $derived(context.tables.find((t) => t.qualifiedName === selected) ?? null);
  const view = $derived(context.views.find((v) => v.qualifiedName === selected) ?? null);
  const entity = $derived(table ?? view);
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
</script>

<aside class="detail" data-testid="detail-pane">
  {#if !entity}
    <p class="empty">Ghost relation - outside this profile's configured schemas. Add its schema to the profile to inspect it.</p>
  {:else}
    <header>
      <span class="kind {table ? 'table' : 'view'}">{table ? 'TABLE' : 'VIEW'}</span>
      <h3>{entity.qualifiedName}</h3>
    </header>

    <nav class="tabs">
      <button class:active={tab === 'human'} onclick={() => (tab = 'human')}>Semantics</button>
      <button class:active={tab === 'ai'} onclick={() => (tab = 'ai')} data-testid="tab-ai">AI view</button>
      <button class:active={tab === 'raw'} onclick={() => (tab = 'raw')}>Raw</button>
    </nav>

    {#if tab === 'human'}
      {#if entity.description}
        <section><h4>Comment</h4><pre class="comment">{entity.description}</pre></section>
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
                <td class="cdesc">{c.description ? c.description.split('\n', 1)[0] : ''}</td>
              </tr>
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
    {:else if tab === 'ai'}
      <p class="hint">
        Exactly what an AI agent receives from the MCP describe tools for this relation - same
        functions, same serialization.
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
