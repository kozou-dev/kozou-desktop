<script lang="ts">
  // The bar above the workspace: everything about the profile being worked on
  // that is not the schema itself. It is where the rail's one line per database
  // gets qualified — the connection, the two actions that change what the
  // profile is, and the two blocks that state what this app is allowed to do
  // with it.
  //
  // Both state blocks are the same components the overview card renders. That is
  // the point: while a profile is selected its card is not on screen, and a
  // second hand-written copy of those rows is how one of them ends up corrected
  // and the other left standing.

  import type { InspectResult, McpMode, McpStatusEntry, ProfileView, RowAccess } from '../../shared/types';
  import { displayConnection } from '../../shared/url';
  import McpBlock from './McpBlock.svelte';
  import RowAccessBlock from './RowAccessBlock.svelte';

  let {
    profile,
    result,
    inspecting,
    mcpMode,
    mcpKnown,
    mcp,
    duplicatePending,
    rowAccessPending,
    oninspect,
    ondelete,
    onrowaccess,
    onmcpstart,
    onmcpstop,
    onmcpoverride,
    onmcpcancel,
    onmcpreassign,
    onmcpconfig,
  }: {
    profile: ProfileView;
    result: InspectResult | undefined;
    /** Which profile is being introspected, if any. Inspections are serialized
     *  app-wide, so this bar's own link goes inert while another one runs
     *  instead of silently doing nothing. */
    inspecting: string | null;
    mcpMode: McpMode;
    mcpKnown: boolean;
    mcp: Record<string, McpStatusEntry>;
    duplicatePending: { profile: string; duplicates: string[] } | null;
    rowAccessPending: string | null;
    oninspect: (name: string) => void;
    ondelete: (name: string) => void;
    onrowaccess: (name: string, level: RowAccess) => void;
    onmcpstart: (name: string) => void;
    onmcpstop: (name: string) => void;
    onmcpoverride: (name: string) => void;
    onmcpcancel: () => void;
    onmcpreassign: (name: string) => void;
    onmcpconfig: (name: string) => void;
  } = $props();

  const busy = $derived(inspecting !== null);
</script>

<section class="profile-bar" data-testid="profile-bar">
  <div class="row">
    <span class="dot" style:background={profile.color ?? '#888'}></span>
    <strong>{profile.label ?? profile.name}</strong>
    <span class="conn">{displayConnection(profile.url)}</span>
    <!-- Real buttons, unlike the same two actions on the card. There they are
         `role="button"` spans because a <button> inside the card's own <button>
         is not valid HTML; here nothing wraps them, and the difference is not
         cosmetic — a span with an Enter-only handler does nothing on Space, and
         one of these two deletes a profile with no confirmation. Measured before
         the change: Space on the span did not fire the action, Space on a rail
         item did. -->
    <span class="actions">
      <button
        class="linkish"
        class:disabled={busy && inspecting !== profile.name}
        disabled={busy && inspecting !== profile.name}
        data-testid={`profile-inspect-${profile.name}`}
        onclick={() => !busy && oninspect(profile.name)}
        >{inspecting === profile.name ? 'inspecting...' : result ? 'refresh' : 'inspect'}</button
      >
      <button
        class="linkish danger"
        data-testid={`profile-delete-${profile.name}`}
        onclick={() => ondelete(profile.name)}>delete</button
      >
    </span>
  </div>
  <!-- `asButton`: nothing here is an interactive host (the bar's own `delete` has
       been a real button since this component existed), so the grant can be one
       too and take Enter and Space from the browser. -->
  <RowAccessBlock
    profile={profile.name}
    level={profile.rowAccess}
    pending={rowAccessPending === profile.name}
    asButton
    {onrowaccess}
  />
  <McpBlock
    {profile}
    {mcpMode}
    {mcpKnown}
    status={mcp[profile.name]}
    {duplicatePending}
    {onmcpstart}
    {onmcpstop}
    {onmcpoverride}
    {onmcpcancel}
    {onmcpreassign}
    {onmcpconfig}
  />
</section>

<style>
  .profile-bar {
    border: 1px solid #ddd;
    border-radius: 10px;
    background: #fff;
    padding: 0.5rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
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
  .actions {
    display: flex;
    gap: 0.6rem;
    font-size: 0.75rem;
    margin-left: auto;
  }
  /* Buttons that read as links: the shell's own <button> rule does not reach
     here (it is scoped to App.svelte), so the reset is explicit. */
  .linkish {
    color: #2f6fed;
    cursor: pointer;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 0.75rem;
  }
  .linkish.danger {
    color: #a00;
  }
  .linkish.disabled {
    color: #aaa;
    cursor: default;
  }
</style>
