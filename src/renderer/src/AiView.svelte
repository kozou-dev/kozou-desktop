<script lang="ts">
  // The one place an AI view is rendered. Both surfaces that claim to show
  // "what your AI receives" go through here, so the note and the block shape
  // cannot drift apart between them — the previous split was exactly how one
  // surface ended up disclosing the fidelity boundary and the other not.
  import { AI_VIEW_NOTE, type AiViewBlock } from './lib/aiViewBlocks';

  let { blocks, testid }: { blocks: AiViewBlock[]; testid: string } = $props();
</script>

<div class="aiview-blocks" data-testid={testid}>
  <p class="hint">{AI_VIEW_NOTE}</p>
  {#if blocks.length === 0}
    <pre class="aiview">(no AI view available)</pre>
  {:else}
    {#each blocks as block (block.call)}
      <p class="call" data-testid="ai-view-call"><code>{block.call}</code></p>
      <pre class="aiview" data-testid="ai-view-block">{block.text}</pre>
    {/each}
  {/if}
</div>

<style>
  .hint {
    color: #666;
    font-size: 0.78rem;
    line-height: 1.5;
    margin: 0 0 0.6rem;
  }
  .call {
    margin: 0.7rem 0 0.25rem;
    font-size: 0.72rem;
    color: #555;
  }
  .call code {
    background: #f1f1f1;
    border-radius: 4px;
    padding: 0.1rem 0.35rem;
    word-break: break-all;
  }
  .aiview {
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    background: #fafafa;
    border: 1px solid #eee;
    border-radius: 6px;
    padding: 0.5rem;
    margin: 0;
  }
</style>
