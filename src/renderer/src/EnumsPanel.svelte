<script lang="ts">
  import type { EnumView } from '../../shared/contextView';

  let { enums }: { enums: EnumView[] } = $props();
</script>

<!-- The body only. Whether this is showing, and the label that says so, belong to
     the workspace's bottom row: three panels each collapsing itself cost three
     rows of the workspace when all three were shut, which is what that row
     exists to reduce to one. -->
<div class="enums" data-testid="enums-panel">
  <ul>
    {#each enums as e (`${e.schema}.${e.name}`)}
      <li>
        <code>{e.schema}.{e.name}</code>
        <span class="values">[{e.values.join(' | ')}]</span>
        {#if e.description}<div class="desc">{e.description.split('\n', 1)[0]}</div>{/if}
      </li>
    {/each}
  </ul>
</div>

<style>
  .enums {
    border: 1px solid #e2e2e2;
    border-radius: 8px;
    background: #fff;
    padding: 0.5rem 0.9rem;
    font-size: 0.82rem;
  }
  ul {
    padding-left: 1.2rem;
    margin: 0;
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
