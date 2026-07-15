<script lang="ts">
  import type { ContextView } from '../../shared/contextView';
  import { searchContexts, type SearchHit } from './lib/search';

  let {
    contexts,
    onjump,
  }: {
    contexts: Record<string, ContextView>;
    onjump: (profile: string, id: string) => void;
  } = $props();

  let query = $state('');
  const result = $derived(searchContexts(contexts, query));
  const open = $derived(query.trim().length >= 2);

  function jump(hit: SearchHit): void {
    onjump(hit.profile, hit.id);
    query = '';
  }
</script>

<div class="search" data-testid="search">
  <input
    type="search"
    placeholder="Search all databases: table / view name, comment, @ai..."
    bind:value={query}
    aria-label="Search compiled semantics across databases"
  />
  {#if open}
    <div class="results" data-testid="search-results">
      {#if result.hits.length === 0}
        <p class="none">No matches in the inspected databases.</p>
      {:else}
        <ul>
          {#each result.hits as hit (`${hit.profile}:${hit.id}`)}
            <li>
              <button onclick={() => jump(hit)}>
                <span class="where">{hit.profile}</span>
                <span class="kind {hit.kind}">{hit.kind}</span>
                <code>{hit.id}</code>
                <span class="badge">{hit.matchedIn}</span>
                <span class="snippet">{hit.snippet}</span>
              </button>
            </li>
          {/each}
        </ul>
        {#if result.truncated}
          <p class="none">Showing the first {result.hits.length} matches - refine the query for more.</p>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .search {
    position: relative;
  }
  input {
    width: 100%;
    padding: 0.4rem 0.6rem;
    border: 1px solid #ccc;
    border-radius: 8px;
    box-sizing: border-box;
    font-size: 0.9rem;
  }
  .results {
    position: absolute;
    z-index: 10;
    left: 0;
    right: 0;
    margin-top: 4px;
    background: #fff;
    border: 1px solid #ddd;
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.1);
    max-height: 340px;
    overflow-y: auto;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0.25rem;
  }
  li button {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 6px;
    padding: 0.35rem 0.5rem;
    cursor: pointer;
    font: inherit;
  }
  li button:hover {
    background: #eef3ff;
  }
  .where {
    font-size: 0.72rem;
    color: #35577d;
    background: #e8eefb;
    border-radius: 4px;
    padding: 0.05rem 0.35rem;
    white-space: nowrap;
  }
  .kind {
    font-size: 0.65rem;
    color: #666;
  }
  .kind.view {
    color: #6a3d8f;
  }
  code {
    font-size: 0.78rem;
    white-space: nowrap;
  }
  .badge {
    font-size: 0.65rem;
    font-weight: 700;
    color: #1c5c38;
  }
  .snippet {
    color: #777;
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .none {
    color: #888;
    font-size: 0.8rem;
    padding: 0.5rem;
    margin: 0;
  }
</style>
