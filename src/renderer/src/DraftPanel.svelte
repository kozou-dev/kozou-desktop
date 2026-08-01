<script lang="ts">
  // Drafted COMMENT statements, waiting to be taken somewhere else.
  //
  // Session-only, and per profile. These are unapplied schema changes: a list
  // that outlived the app — or followed a profile that had been repointed at
  // another database — would offer statements for a schema they were never
  // written against. Persisting them would also put an app-owned copy of the
  // semantic model on disk, which is precisely what this product does not do.

  import { draftsToSqlFile, type CommentDraft } from './lib/commentEmit';

  let {
    drafts,
    status,
    onremove,
    onclear,
    oncopy,
    onsave,
  }: {
    drafts: CommentDraft[];
    /** Outcome of the last copy/save, owned by the app. */
    status: string | null;
    onremove: (id: number) => void;
    onclear: () => void;
    oncopy: (text: string) => void;
    onsave: (text: string) => void;
  } = $props();

  const sqlFile = $derived(draftsToSqlFile(drafts));
</script>

<section class="drafts" data-testid="draft-panel">
  <header>
    <h4>Drafted comments ({drafts.length})</h4>
    <div class="actions">
      <button type="button" data-testid="draft-copy" onclick={() => oncopy(sqlFile)}>Copy</button>
      <button type="button" data-testid="draft-save" onclick={() => onsave(sqlFile)}>Save .sql</button>
      <button type="button" data-testid="draft-clear" onclick={onclear}>Clear</button>
    </div>
  </header>

  <p class="hint">
    Not applied - this app never runs these. Apply them the way you apply any other schema change
    (psql, your migration tool, a pull request), then re-inspect to see them take effect.
  </p>

  {#if status !== null}
    <p class="status" data-testid="draft-status">{status}</p>
  {/if}

  <ul>
    {#each drafts as draft (draft.id)}
      <li>
        <code class="target">{draft.target}</code>
        <button
          type="button"
          class="drop"
          data-testid={`draft-remove-${draft.id}`}
          onclick={() => onremove(draft.id)}
          aria-label={`Remove the draft for ${draft.target}`}>x</button
        >
        <pre>{draft.sql}</pre>
      </li>
    {/each}
  </ul>
</section>

<style>
  .drafts {
    border: 1px solid #d4d9e6;
    border-radius: 8px;
    background: #fbfcff;
    padding: 0.6rem 0.8rem;
    margin-top: 0.75rem;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  h4 {
    margin: 0;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #666;
  }
  .actions {
    display: flex;
    gap: 0.4rem;
  }
  .actions button {
    padding: 0.2rem 0.7rem;
    border: 1px solid #ccc;
    border-radius: 999px;
    background: #fff;
    cursor: pointer;
    font-size: 0.78rem;
  }
  .hint {
    color: #888;
    font-size: 0.75rem;
    margin: 0.3rem 0;
  }
  .status {
    color: #1c5c38;
    font-size: 0.78rem;
    margin: 0.2rem 0;
  }
  ul {
    list-style: none;
    margin: 0.3rem 0 0;
    padding: 0;
  }
  li {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.2rem 0.4rem;
    border-top: 1px solid #eceff5;
    padding: 0.35rem 0;
  }
  .target {
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    color: #35577d;
  }
  .drop {
    border: 1px solid #ccc;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
    font-size: 0.7rem;
    line-height: 1;
    padding: 0.15rem 0.35rem;
  }
  pre {
    grid-column: 1 / -1;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    background: #fff;
    border: 1px solid #e4e4e4;
    border-radius: 4px;
    padding: 0.35rem;
    margin: 0;
  }
</style>
