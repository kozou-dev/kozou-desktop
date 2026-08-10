<script lang="ts">
  // The all-databases view: every profile side by side, which is what makes
  // annotation coverage comparable across them. Reached from the top of the
  // rail; not on screen while a profile is selected, because the profile being
  // worked on is described by the bar above the workspace instead.
  import type { ContextView } from '../../shared/contextView';
  import type {
    InspectResult,
    McpMode,
    McpStatusEntry,
    ProfileView,
    RowAccess,
  } from '../../shared/types';
  import { displayConnection } from '../../shared/url';
  import { computeCoverage } from './lib/coverage';
  import McpBlock from './McpBlock.svelte';
  import RowAccessBlock from './RowAccessBlock.svelte';

  let {
    profiles,
    results,
    inspecting,
    mcpMode,
    mcpKnown,
    mcp,
    duplicatePending,
    rowAccessPending,
    oninspect,
    onselect,
    ondelete,
    onrowaccess,
    onmcpstart,
    onmcpstop,
    onmcpoverride,
    onmcpcancel,
    onmcpreassign,
    onmcpconfig,
  }: {
    profiles: ProfileView[];
    results: Record<string, InspectResult>;
    inspecting: string | null;
    mcpMode: McpMode;
    /** False until both the permission and the registry have been read. While
     *  it is false no card says anything about its own MCP server: the
     *  placeholder permission would read as "not allowed" and the empty
     *  registry as "off", and neither has been established. */
    mcpKnown: boolean;
    mcp: Record<string, McpStatusEntry>;
    duplicatePending: { profile: string; duplicates: string[] } | null;
    rowAccessPending: string | null;
    oninspect: (name: string) => void;
    onselect: (name: string) => void;
    ondelete: (name: string) => void;
    onrowaccess: (name: string, level: RowAccess) => void;
    onmcpstart: (name: string) => void;
    onmcpstop: (name: string) => void;
    onmcpoverride: (name: string) => void;
    onmcpcancel: () => void;
    onmcpreassign: (name: string) => void;
    onmcpconfig: (name: string) => void;
  } = $props();

  // Inspections are serialized app-wide; while one runs, other cards'
  // inspect links are visibly inert instead of silently doing nothing.
  const busy = $derived(inspecting !== null);

  const pct = (x: number): string => `${Math.round(x * 100)}%`;
</script>

<div class="cards" data-testid="overview-cards">
  {#each profiles as p (p.name)}
    {@const result = results[p.name]}
    {@const cov = result?.ok ? computeCoverage(result.context as ContextView) : null}
    <button
      class="card"
      data-testid={`card-${p.name}`}
      onclick={() => onselect(p.name)}
    >
      <div class="row">
        <span class="dot" style:background={p.color ?? '#888'}></span>
        <strong>{p.label ?? p.name}</strong>
        <span class="conn">{displayConnection(p.url)}</span>
      </div>
      {#if cov}
        <div class="row stats">
          <span>{cov.relationCount.tables} tables</span>
          <span>{cov.relationCount.views} views</span>
          {#if cov.relationCount.functions > 0}<span>{cov.relationCount.functions} functions</span>{/if}
        </div>
        <div class="row coverage" title="How much of this schema carries meaning: relations (tables+views) and columns with a COMMENT or @ai annotation">
          <span>annotated: relations {pct(cov.relations)}</span>
          <span>columns {pct(cov.columns)}</span>
        </div>
      {:else if result && !result.ok}
        <div class="row error">{result.error}</div>
      {:else}
        <div class="row empty">not inspected yet</div>
      {/if}
      <div class="row actions">
        <span
          class="linkish"
          class:disabled={busy && inspecting !== p.name}
          role="button"
          tabindex="0"
          onclick={(e) => {
            e.stopPropagation();
            if (!busy) oninspect(p.name);
          }}
          onkeydown={(e) => e.key === 'Enter' && (e.stopPropagation(), !busy && oninspect(p.name))}
          >{inspecting === p.name ? 'inspecting...' : result ? 'refresh' : 'inspect'}</span
        >
        <span
          class="linkish danger"
          role="button"
          tabindex="0"
          onclick={(e) => {
            e.stopPropagation();
            ondelete(p.name);
          }}
          onkeydown={(e) => e.key === 'Enter' && (e.stopPropagation(), ondelete(p.name))}>delete</span
        >
      </div>
      <!-- No `asButton`: the card is itself a <button> that selects the profile, so
           the controls in here stay spans. That is also the default, so a host that
           says nothing cannot get this wrong. -->
      <RowAccessBlock
        profile={p.name}
        level={p.rowAccess}
        pending={rowAccessPending === p.name}
        {onrowaccess}
      />
      <McpBlock
        profile={p}
        {mcpMode}
        {mcpKnown}
        status={mcp[p.name]}
        {duplicatePending}
        {onmcpstart}
        {onmcpstop}
        {onmcpoverride}
        {onmcpcancel}
        {onmcpreassign}
        {onmcpconfig}
      />
    </button>
  {/each}
</div>

<style>
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 0.7rem;
  }
  .card {
    text-align: left;
    border: 1px solid #ddd;
    border-radius: 10px;
    background: #fff;
    padding: 0.6rem 0.8rem;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font: inherit;
  }
  .row {
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    align-self: center;
  }
  .conn {
    font-family: ui-monospace, monospace;
    font-size: 0.72rem;
    color: #777;
  }
  .stats {
    font-size: 0.8rem;
    color: #444;
  }
  .coverage {
    font-size: 0.75rem;
    color: #1c5c38;
  }
  .error {
    font-size: 0.75rem;
    color: #a00;
  }
  .empty {
    font-size: 0.75rem;
    color: #999;
  }
  .actions {
    font-size: 0.75rem;
  }
  .linkish {
    color: #2f6fed;
    cursor: pointer;
  }
  .linkish.danger {
    color: #a00;
  }
  .linkish.disabled {
    color: #aaa;
    cursor: default;
  }
</style>
