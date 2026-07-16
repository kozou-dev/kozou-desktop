<script lang="ts">
  import type { ContextView } from '../../shared/contextView';
  import type { InspectResult, McpMode, McpStatusEntry, ProfileView } from '../../shared/types';
  import { displayConnection } from '../../shared/url';
  import { computeCoverage } from './lib/coverage';

  let {
    profiles,
    results,
    selected,
    inspecting,
    mcpMode,
    mcp,
    duplicatePending,
    oninspect,
    onselect,
    ondelete,
    onmcpstart,
    onmcpstop,
    onmcpoverride,
    onmcpcancel,
    onmcpreassign,
    onmcpconfig,
  }: {
    profiles: ProfileView[];
    results: Record<string, InspectResult>;
    selected: string | null;
    inspecting: string | null;
    mcpMode: McpMode;
    mcp: Record<string, McpStatusEntry>;
    duplicatePending: { profile: string; duplicates: string[] } | null;
    oninspect: (name: string) => void;
    onselect: (name: string) => void;
    ondelete: (name: string) => void;
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

  const mcpBadge = (st: McpStatusEntry | undefined): { text: string; cls: string } => {
    switch (st?.status) {
      case 'running':
        return { text: `MCP on :${st.port}`, cls: 'on' };
      case 'starting':
        return { text: 'MCP starting...', cls: '' };
      case 'stopped-crashed':
        return { text: 'MCP crashed', cls: 'err' };
      case 'error-port-busy':
        return { text: 'MCP port busy', cls: 'err' };
      case 'error':
        return { text: 'MCP error', cls: 'err' };
      case 'blocked-duplicate':
        return { text: 'MCP blocked (duplicate)', cls: 'warn' };
      case 'stopped-profile-updated':
        return { text: 'MCP stopped (profile updated)', cls: '' };
      default:
        return { text: 'MCP off', cls: '' };
    }
  };

  const stoppedish = (st: McpStatusEntry | undefined): boolean =>
    st === undefined || (st.status !== 'running' && st.status !== 'starting');

  /** Keyboard/click helper for the linkish span-buttons inside the card. */
  const act = (e: Event, fn: () => void): void => {
    e.stopPropagation();
    fn();
  };
</script>

<div class="cards" data-testid="overview-cards">
  {#each profiles as p (p.name)}
    {@const result = results[p.name]}
    {@const cov = result?.ok ? computeCoverage(result.context as ContextView) : null}
    <button
      class="card"
      class:active={selected === p.name}
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
      {#if mcpMode === 'local'}
        {@const st = mcp[p.name]}
        {@const badge = mcpBadge(st)}
        <div class="row mcp" data-testid={`mcp-${p.name}`}>
          <span class={`mcp-badge ${badge.cls}`} data-testid={`mcp-badge-${p.name}`} title={st?.error ?? ''}
            >{badge.text}</span
          >
          {#if stoppedish(st)}
            <span
              class="linkish"
              role="button"
              tabindex="0"
              data-testid={`mcp-start-${p.name}`}
              onclick={(e) => act(e, () => onmcpstart(p.name))}
              onkeydown={(e) => e.key === 'Enter' && act(e, () => onmcpstart(p.name))}>start</span
            >
          {:else}
            <span
              class="linkish"
              role="button"
              tabindex="0"
              data-testid={`mcp-stop-${p.name}`}
              onclick={(e) => act(e, () => onmcpstop(p.name))}
              onkeydown={(e) => e.key === 'Enter' && act(e, () => onmcpstop(p.name))}>stop</span
            >
          {/if}
          {#if st?.status === 'error-port-busy'}
            <span
              class="linkish"
              role="button"
              tabindex="0"
              data-testid={`mcp-reassign-${p.name}`}
              onclick={(e) => act(e, () => onmcpreassign(p.name))}
              onkeydown={(e) => e.key === 'Enter' && act(e, () => onmcpreassign(p.name))}>move port</span
            >
          {/if}
          <!-- Not offered while a foreign process owns the port: pasting the
               config would hand the secret path to whatever squats there. -->
          {#if st?.port !== undefined && st?.path !== undefined && st?.status !== 'error-port-busy'}
            <span
              class="linkish"
              role="button"
              tabindex="0"
              data-testid={`mcp-config-${p.name}`}
              onclick={(e) => act(e, () => onmcpconfig(p.name))}
              onkeydown={(e) => e.key === 'Enter' && act(e, () => onmcpconfig(p.name))}>AI client config</span
            >
          {/if}
          {#if p.remoteMcp?.declared}
            <span class="mcp-badge remote" title={p.remoteMcp.url ?? ''}>remote declared</span>
          {/if}
        </div>
        {#if st?.error && (st.status === 'error' || st.status === 'error-port-busy' || st.status === 'stopped-crashed')}
          <div class="row mcp-error" data-testid={`mcp-error-${p.name}`}>{st.error}</div>
        {/if}
        {#if duplicatePending?.profile === p.name}
          <div class="row mcp-dup" data-testid={`mcp-dup-${p.name}`}>
            <span>same database as declared remote MCP: {duplicatePending.duplicates.join(', ')}</span>
            <span
              class="linkish"
              role="button"
              tabindex="0"
              data-testid={`mcp-dup-confirm-${p.name}`}
              onclick={(e) => act(e, () => onmcpoverride(p.name))}
              onkeydown={(e) => e.key === 'Enter' && act(e, () => onmcpoverride(p.name))}>start anyway</span
            >
            <span
              class="linkish"
              role="button"
              tabindex="0"
              data-testid={`mcp-dup-cancel-${p.name}`}
              onclick={(e) => act(e, () => onmcpcancel())}
              onkeydown={(e) => e.key === 'Enter' && act(e, () => onmcpcancel())}>cancel</span
            >
          </div>
        {/if}
      {:else if p.remoteMcp?.declared}
        <div class="row mcp">
          <span class="mcp-badge remote" title={p.remoteMcp.url ?? ''}>remote MCP declared</span>
        </div>
      {/if}
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
  .card.active {
    border-color: #2f6fed;
    box-shadow: 0 0 0 2px #eef3ff;
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
  .mcp {
    font-size: 0.75rem;
    border-top: 1px dashed #eee;
    padding-top: 0.3rem;
  }
  .mcp-badge {
    border: 1px solid #ccc;
    border-radius: 999px;
    padding: 0.05rem 0.5rem;
    color: #666;
    font-size: 0.72rem;
  }
  .mcp-badge.on {
    border-color: #1c7c3c;
    color: #1c7c3c;
    background: #f0faf3;
  }
  .mcp-badge.err {
    border-color: #a00;
    color: #a00;
    background: #fff5f5;
  }
  .mcp-badge.warn {
    border-color: #b8860b;
    color: #b8860b;
    background: #fffbe8;
  }
  .mcp-badge.remote {
    border-color: #6a5acd;
    color: #6a5acd;
    background: #f6f4ff;
  }
  .mcp-error {
    font-size: 0.72rem;
    color: #a00;
    white-space: pre-wrap;
  }
  .mcp-dup {
    font-size: 0.75rem;
    color: #7a5b00;
    background: #fffbe8;
    border: 1px solid #eedc9a;
    border-radius: 6px;
    padding: 0.3rem 0.5rem;
  }
</style>
