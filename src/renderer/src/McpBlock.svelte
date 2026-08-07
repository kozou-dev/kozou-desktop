<script lang="ts">
  // What a profile's own MCP server is doing, the controls for it, and what the
  // operator recorded about a remote server serving the same database —
  // rendered from one place because two surfaces show it: the overview card in
  // the all-databases view, and the bar above the workspace for the profile
  // being worked on. See RowAccessBlock.svelte for why this is one component
  // and not two copies.
  //
  // The words themselves live in ./lib/statusCopy.ts and are not restated here.

  import type { McpMode, McpStatusEntry, ProfileView } from '../../shared/types';
  import { MCP_NOT_ALLOWED, servingNote } from './lib/statusCopy';

  let {
    profile,
    mcpMode,
    mcpKnown,
    status,
    duplicatePending,
    onmcpstart,
    onmcpstop,
    onmcpoverride,
    onmcpcancel,
    onmcpreassign,
    onmcpconfig,
  }: {
    profile: ProfileView;
    mcpMode: McpMode;
    /** False until both the permission and the registry have been read. While it
     *  is false nothing here is rendered: the placeholder permission would read
     *  as "not allowed" and the empty registry as "off", and neither has been
     *  established. */
    mcpKnown: boolean;
    status: McpStatusEntry | undefined;
    duplicatePending: { profile: string; duplicates: string[] } | null;
    onmcpstart: (name: string) => void;
    onmcpstop: (name: string) => void;
    onmcpoverride: (name: string) => void;
    onmcpcancel: () => void;
    onmcpreassign: (name: string) => void;
    onmcpconfig: (name: string) => void;
  } = $props();

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

  /** See RowAccessBlock.svelte: `stopPropagation` is for the card, which wraps
   *  this in its own <button>, and is harmless in the profile bar. */
  const act = (e: Event, fn: () => void): void => {
    e.stopPropagation();
    fn();
  };

  const name = $derived(profile.name);
  const decl = $derived(servingNote(profile.remoteMcp?.declared === true));
</script>

<!-- The MCP row is present whatever the permission says. It used to appear only
     under 'local', so a reader who had not opened the permission had no way to
     learn that per-profile MCP existed at all — the same shape of defect as an
     opt-in whose control is invisible until you already know about it. -->
{#if mcpKnown && mcpMode === 'local'}
  {@const badge = mcpBadge(status)}
  <div class="row mcp" data-testid={`mcp-${name}`}>
    <span
      class={`mcp-badge ${badge.cls}`}
      data-testid={`mcp-badge-${name}`}
      title={status?.error ?? ''}>{badge.text}</span
    >
    {#if stoppedish(status)}
      <span
        class="linkish"
        role="button"
        tabindex="0"
        data-testid={`mcp-start-${name}`}
        onclick={(e) => act(e, () => onmcpstart(name))}
        onkeydown={(e) => e.key === 'Enter' && act(e, () => onmcpstart(name))}>start</span
      >
    {:else}
      <span
        class="linkish"
        role="button"
        tabindex="0"
        data-testid={`mcp-stop-${name}`}
        onclick={(e) => act(e, () => onmcpstop(name))}
        onkeydown={(e) => e.key === 'Enter' && act(e, () => onmcpstop(name))}>stop</span
      >
    {/if}
    {#if status?.status === 'error-port-busy'}
      <span
        class="linkish"
        role="button"
        tabindex="0"
        data-testid={`mcp-reassign-${name}`}
        onclick={(e) => act(e, () => onmcpreassign(name))}
        onkeydown={(e) => e.key === 'Enter' && act(e, () => onmcpreassign(name))}>move port</span
      >
    {/if}
    <!-- Not offered while a foreign process owns the port: pasting the config
         would hand the secret path to whatever squats there. -->
    {#if status?.port !== undefined && status?.path !== undefined && status?.status !== 'error-port-busy'}
      <span
        class="linkish"
        role="button"
        tabindex="0"
        data-testid={`mcp-config-${name}`}
        onclick={(e) => act(e, () => onmcpconfig(name))}
        onkeydown={(e) => e.key === 'Enter' && act(e, () => onmcpconfig(name))}>AI client config</span
      >
    {/if}
  </div>
  {#if status?.error && (status.status === 'error' || status.status === 'error-port-busy' || status.status === 'stopped-crashed')}
    <!-- `prose` for the same reason as the rows below: this is up to three lines
         of a worker's stderr, and in the profile bar it measured 2262px wide in a
         2560px window before the cap. -->
    <div class="row mcp-error prose" data-testid={`mcp-error-${name}`}>{status.error}</div>
  {/if}
  {#if duplicatePending?.profile === name}
    <!-- `prose` on the box rather than on the sentence: the sentence is a <span>
         and `max-width` does not apply to inline boxes. The two actions wrap
         below it once the box is capped, which is the right order anyway. -->
    <div class="row mcp-dup prose" data-testid={`mcp-dup-${name}`}>
      <!-- Say what the collision risks, not just that there is one — and stay
           inside what is known. About our own side we can be definite: our port
           is ours, our reads run read-only, and we cannot dispatch an execution
           tool. About the declared server we know nothing at all — not its
           port, not its options, not whether it is even up, since a declaration
           is never contacted and needs no URL. So the cost is stated as a
           possibility. -->
      <span
        >same database as declared remote MCP: {duplicatePending.duplicates.join(', ')}. Two servers
        could then answer the same question differently — this app does not reproduce a server's own
        opt-ins (RPC exposure, privilege-aware annotations).</span
      >
      <span
        class="linkish"
        role="button"
        tabindex="0"
        data-testid={`mcp-dup-confirm-${name}`}
        onclick={(e) => act(e, () => onmcpoverride(name))}
        onkeydown={(e) => e.key === 'Enter' && act(e, () => onmcpoverride(name))}>start anyway</span
      >
      <span
        class="linkish"
        role="button"
        tabindex="0"
        data-testid={`mcp-dup-cancel-${name}`}
        onclick={(e) => act(e, () => onmcpcancel())}
        onkeydown={(e) => e.key === 'Enter' && act(e, () => onmcpcancel())}>cancel</span
      >
    </div>
  {/if}
{:else if mcpKnown}
  <!-- No profile may run a server, so this row says that and nothing else. It
       states the permission it is subject to, not a state its server is in —
       there is no server to be in one. -->
  <div class="row mcp" data-testid={`mcp-${name}`}>
    <span class="mcp-badge" data-testid={`mcp-badge-${name}`}>{MCP_NOT_ALLOWED}</span>
  </div>
{/if}
<!-- Outside the permission branches on purpose: what the operator recorded
     about someone else's server is true whether or not this app may serve, and
     rendering it from one place is what stops the two branches from saying
     different things about the same declaration. The app never contacts that
     server, so nothing here reports its condition. -->
{#if decl !== null}
  <div class="row mcp" data-testid={`serving-${name}`}>
    <span class={`mcp-badge ${decl.cls}`} title={profile.remoteMcp?.url ?? ''}>{decl.text}</span>
  </div>
{/if}

<style>
  /* Layout only — see RowAccessBlock.svelte's note on the repeated rules. */
  .row {
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .mcp {
    font-size: 0.75rem;
    border-top: 1px dashed #eee;
    padding-top: 0.3rem;
  }
  .linkish {
    color: #2f6fed;
    cursor: pointer;
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
