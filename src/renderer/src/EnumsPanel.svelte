<script lang="ts">
  import type { EnumView } from '../../shared/contextView';

  let { enums }: { enums: EnumView[] } = $props();
</script>

{#if enums.length > 0}
  <details class="enums" data-testid="enums-panel">
    <summary>Enum types ({enums.length})</summary>
    <ul>
      {#each enums as e (`${e.schema}.${e.name}`)}
        <li>
          <code>{e.schema}.{e.name}</code>
          <span class="values">[{e.values.join(' | ')}]</span>
          {#if e.description}<div class="desc">{e.description.split('\n', 1)[0]}</div>{/if}
        </li>
      {/each}
    </ul>
  </details>
{/if}

<style>
  .enums {
    border: 1px solid #e2e2e2;
    border-radius: 8px;
    background: #fff;
    padding: 0.5rem 0.9rem;
    font-size: 0.82rem;
  }
  summary {
    cursor: pointer;
    color: #444;
  }
  ul {
    padding-left: 1.2rem;
  }
  code {
    font-size: 0.78rem;
  }
  .values {
    color: #666;
    font-size: 0.75rem;
  }
  .desc {
    color: #555;
    font-size: 0.78rem;
  }
</style>
