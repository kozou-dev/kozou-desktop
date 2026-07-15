<script lang="ts">
  import JsonTree from './JsonTree.svelte';

  let {
    value,
    name = '',
    open = false,
  }: { value: unknown; name?: string; open?: boolean } = $props();

  const isObject = (v: unknown): v is Record<string, unknown> | unknown[] =>
    v !== null && typeof v === 'object';
</script>

{#if isObject(value)}
  <details {open}>
    <summary>
      <span class="key">{name}</span>
      <span class="hint">{Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`}</span>
    </summary>
    <div class="children">
      {#each Object.entries(value) as [k, v] (k)}
        <JsonTree name={k} value={v} />
      {/each}
    </div>
  </details>
{:else}
  <div class="leaf">
    <span class="key">{name}</span>: <span class="value">{JSON.stringify(value)}</span>
  </div>
{/if}

<style>
  details {
    font-family: ui-monospace, monospace;
    font-size: 0.82rem;
  }
  summary {
    cursor: pointer;
    user-select: none;
  }
  .children {
    margin-left: 1.1rem;
    border-left: 1px dotted #ddd;
    padding-left: 0.5rem;
  }
  .leaf {
    font-family: ui-monospace, monospace;
    font-size: 0.82rem;
    white-space: nowrap;
  }
  .key {
    color: #7a3e9d;
  }
  .hint {
    color: #999;
  }
  .value {
    color: #2a6f2a;
  }
</style>
