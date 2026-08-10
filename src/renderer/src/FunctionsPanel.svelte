<script lang="ts">
  import type { AiViews } from '../../shared/types';
  import type { FunctionView } from '../../shared/contextView';
  import AiView from './AiView.svelte';
  import { functionsAiBlocks } from './lib/aiViewBlocks';

  let { functions, aiViews }: { functions: FunctionView[]; aiViews: AiViews } = $props();
  let showAi = $state(false);

  const blocks = $derived(functionsAiBlocks(aiViews));
</script>

<!-- The body only; the label and whether it is showing belong to the workspace's
     bottom row (see EnumsPanel for why). -->
<div class="functions" data-testid="functions-panel">
  <ul>
    {#each functions as f (f.qualifiedName)}
      <li>
        <code>{f.qualifiedName}({f.args.map((a) => `${a.name} ${a.typeName}`).join(', ')})</code>
        <span class="ret">-&gt; {f.returns.typeName}</span>
        <span class="attrs">{f.volatility}, security {f.security}</span>
        {#if f.description}<div class="desc">{f.description.split('\n', 1)[0]}</div>{/if}
      </li>
    {/each}
  </ul>
  {#if blocks.length > 0}
    <button class="toggle" onclick={() => (showAi = !showAi)}>
      {showAi ? 'Hide' : 'Show'} AI view (describe_functions)
    </button>
    {#if showAi}<AiView {blocks} testid="functions-ai-view" />{/if}
  {/if}
</div>

<style>
  .functions {
    border: 1px solid #e2e2e2;
    border-radius: 8px;
    background: #fff;
    padding: 0.5rem 0.9rem;
    font-size: 0.82rem;
  }
  ul {
    padding-left: 1.2rem;
    margin: 0 0 0.4rem;
  }
  code {
    font-size: 0.78rem;
  }
  .ret {
    color: #666;
  }
  .attrs {
    color: #999;
    font-size: 0.72rem;
    margin-left: 0.5rem;
  }
  .desc {
    color: #555;
    font-size: 0.78rem;
  }
  .toggle {
    border: 1px solid #ccc;
    border-radius: 6px;
    background: #fff;
    padding: 0.15rem 0.6rem;
    cursor: pointer;
    font-size: 0.75rem;
  }
</style>
