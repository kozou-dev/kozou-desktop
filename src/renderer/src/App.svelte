<script lang="ts">
  import type { ContextView } from '../../shared/contextView';
  import type { InspectResult, McpMode, McpStatusEntry, ProfileView } from '../../shared/types';
  import DetailPane from './DetailPane.svelte';
  import EnumsPanel from './EnumsPanel.svelte';
  import FunctionsPanel from './FunctionsPanel.svelte';
  import OverviewCards from './OverviewCards.svelte';
  import SearchBar from './SearchBar.svelte';
  import SemanticMap from './SemanticMap.svelte';
  import { buildMcpClientSnippets } from '../../shared/mcpSnippet';

  const api = window.kozouDesktop;

  let profiles = $state<ProfileView[]>([]);
  let results = $state<Record<string, InspectResult>>({});
  let selectedProfile = $state<string | null>(null);
  let selectedEntity = $state<string | null>(null);
  let inspecting = $state<string | null>(null);
  let formError = $state<string | null>(null);
  let showAddForm = $state(false);
  // A profile's identity is not its name across delete/re-create or a
  // URL-changing re-save: bump a per-name token on every mutation and drop
  // in-flight inspect results whose token no longer matches.
  const profileTokens = new Map<string, number>();
  const bumpToken = (name: string): void => {
    profileTokens.set(name, (profileTokens.get(name) ?? 0) + 1);
  };

  // Add-profile form
  let fName = $state('');
  let fUrl = $state('');
  let fSchemas = $state('public');
  let fTimeout = $state('');
  let fRemoteDeclared = $state(false);
  let fRemoteUrl = $state('');
  // Send remoteMcp only when the user touched the checkbox: an untouched
  // re-save must preserve an earlier declaration (the store treats an
  // omitted field as "keep"), not silently clear the duplicate-warning
  // layer for that database.
  let fRemoteTouched = $state(false);

  // Local MCP serving state (live registry pushed from main; the store's
  // allocation/autoStart ride the same entries).
  let mcpMode = $state<McpMode>('off');
  let mcp = $state<Record<string, McpStatusEntry>>({});
  let duplicatePending = $state<{ profile: string; duplicates: string[] } | null>(null);
  let pendingMode = $state<McpMode | null>(null);
  let snippetFor = $state<string | null>(null);

  const runningCount = $derived(
    Object.values(mcp).filter((s) => s.status === 'running' || s.status === 'starting').length,
  );
  const snippet = $derived.by(() => {
    if (snippetFor === null) return null;
    const st = mcp[snippetFor];
    if (st?.port === undefined || st.path === undefined) return null;
    return buildMcpClientSnippets(snippetFor, st.port, st.path);
  });

  function applyMcpStatus(entries: McpStatusEntry[]): void {
    const next: Record<string, McpStatusEntry> = {};
    for (const e of entries) next[e.profile] = e;
    mcp = next;
  }

  async function initMcp(): Promise<void> {
    try {
      mcpMode = await api.mcpModeGet();
      applyMcpStatus(await api.mcpStatus());
    } catch (err) {
      formError = message(err);
    }
  }
  api.onMcpStatusChanged(applyMcpStatus);

  /** Mode switch: leaving 'local' with live servers asks first (they all
   *  stop; per-profile autoStart intents survive for the next launch).
   *  Re-picking the current mode acts as an undo of a pending confirm. */
  async function requestMode(next: McpMode): Promise<void> {
    if (next === mcpMode) {
      pendingMode = null;
      return;
    }
    if (mcpMode === 'local' && runningCount > 0) {
      pendingMode = next;
      return;
    }
    await applyMode(next);
  }

  async function applyMode(next: McpMode): Promise<void> {
    pendingMode = null;
    formError = null;
    try {
      mcpMode = await api.mcpModeSet(next);
      applyMcpStatus(await api.mcpStatus());
    } catch (err) {
      formError = message(err);
    }
  }

  async function mcpStart(name: string, override = false): Promise<void> {
    duplicatePending = null;
    formError = null;
    try {
      const out = await api.mcpStart(name, override ? { override: true } : undefined);
      applyMcpStatus(out.status);
      if (out.outcome === 'blocked-duplicate') {
        duplicatePending = { profile: name, duplicates: out.duplicates ?? [] };
      }
    } catch (err) {
      formError = message(err);
    }
  }

  async function mcpStop(name: string): Promise<void> {
    formError = null;
    try {
      applyMcpStatus(await api.mcpStop(name));
    } catch (err) {
      formError = message(err);
    }
  }

  async function mcpReassign(name: string): Promise<void> {
    formError = null;
    try {
      applyMcpStatus(await api.mcpReassignPort(name));
    } catch (err) {
      formError = message(err);
    }
  }

  function copyText(text: string): void {
    // Best-effort: the snippet stays visible for manual copy if the
    // clipboard API refuses.
    void navigator.clipboard.writeText(text).catch(() => {});
  }

  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  const current = $derived(selectedProfile ? (results[selectedProfile] ?? null) : null);
  const currentContext = $derived(current?.ok ? (current.context as ContextView) : null);

  // Successfully-inspected contexts, for cross-profile search.
  const searchable = $derived.by(() => {
    const out: Record<string, ContextView> = {};
    for (const [name, r] of Object.entries(results)) {
      if (r.ok) out[name] = r.context as ContextView;
    }
    return out;
  });

  function jumpTo(profile: string, id: string): void {
    selectedProfile = profile;
    selectedEntity = id;
  }

  async function refresh(): Promise<void> {
    try {
      profiles = await api.listProfiles();
      if (profiles.length === 0) showAddForm = true;
    } catch (err) {
      formError = message(err);
    }
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    formError = null;
    try {
      const name = fName.trim();
      profiles = await api.saveProfile({
        name,
        url: fUrl.trim(),
        schemas: fSchemas
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        ...(fTimeout.trim() !== '' ? { timeoutMs: Number(fTimeout) } : {}),
        ...(fRemoteTouched || fRemoteDeclared
          ? {
              remoteMcp: {
                declared: fRemoteDeclared,
                ...(fRemoteDeclared && fRemoteUrl.trim() !== '' ? { url: fRemoteUrl.trim() } : {}),
              },
            }
          : {}),
      });
      fName = '';
      fUrl = '';
      fSchemas = 'public';
      fTimeout = '';
      fRemoteDeclared = false;
      fRemoteUrl = '';
      fRemoteTouched = false;
      showAddForm = false;
      // The (re-)saved profile may point at a different database now — an
      // in-flight inspect for the same name must not land, and a pending
      // duplicate warning refers to the previous database.
      if (duplicatePending?.profile === name) duplicatePending = null;
      bumpToken(name);
      delete results[name];
      applyMcpStatus(await api.mcpStatus());
      await inspect(name);
    } catch (err) {
      formError = message(err);
    }
  }

  async function remove(name: string): Promise<void> {
    try {
      bumpToken(name);
      profiles = await api.deleteProfile(name);
    } catch (err) {
      formError = message(err);
      return;
    }
    delete results[name];
    if (duplicatePending?.profile === name) duplicatePending = null;
    if (snippetFor === name) snippetFor = null;
    if (selectedProfile === name) {
      selectedProfile = null;
      selectedEntity = null;
    }
  }

  async function inspect(name: string): Promise<void> {
    // One inspection at a time: a second worker for the same (or another)
    // profile mid-flight buys nothing and muddies the in-flight display.
    if (inspecting !== null) return;
    if (selectedProfile !== name) {
      // Selection belongs to the previous profile's map — never let it leak
      // into another database's detail pane.
      selectedEntity = null;
    }
    selectedProfile = name;
    inspecting = name;
    const token = profileTokens.get(name) ?? 0;
    let result: InspectResult;
    try {
      result = await api.inspect(name);
    } catch (err) {
      // An IPC rejection (e.g. the OS keychain refused to decrypt) must
      // surface in the UI, not vanish as an unhandled rejection.
      result = { ok: false, error: message(err) };
    } finally {
      inspecting = null;
    }
    // The profile may have been deleted or re-saved (possibly with another
    // URL) while the worker ran — a stale result must not render.
    if ((profileTokens.get(name) ?? 0) !== token) return;
    if (!profiles.some((p) => p.name === name)) return;
    results[name] = result;
  }

  function selectProfile(name: string): void {
    selectedProfile = name;
    selectedEntity = null;
    if (!results[name]) void inspect(name);
  }

  void refresh();
  void initMcp();
</script>

<main>
  <header class="top">
    <h1>kozou Desktop <span class="tag">Semantic Map</span></h1>
    <div class="top-actions">
      <label class="mcp-mode">
        MCP
        <select
          data-testid="mcp-mode"
          value={pendingMode ?? mcpMode}
          onchange={(e) => void requestMode(e.currentTarget.value as McpMode)}
        >
          <option value="off">Off</option>
          <option value="local">Local</option>
          <option value="remote-only">Remote only</option>
        </select>
      </label>
      {#if pendingMode !== null}
        <span class="mode-confirm" data-testid="mcp-mode-confirm">
          stop {runningCount} running server{runningCount === 1 ? '' : 's'} and switch to "{pendingMode}"?
          <button data-testid="mcp-mode-confirm-yes" onclick={() => pendingMode !== null && void applyMode(pendingMode)}
            >stop &amp; switch</button
          >
          <button data-testid="mcp-mode-confirm-no" onclick={() => (pendingMode = null)}>cancel</button>
        </span>
      {/if}
      <button class="add" data-testid="add-toggle" onclick={() => (showAddForm = !showAddForm)}>
        {showAddForm ? 'Close' : '+ Add database'}
      </button>
    </div>
  </header>

  {#if showAddForm}
    <form onsubmit={save}>
      <input placeholder="name" bind:value={fName} required />
      <input placeholder="postgresql://user:password@host:5432/db" bind:value={fUrl} required size="42" />
      <input placeholder="schemas (comma-separated)" bind:value={fSchemas} />
      <input placeholder="timeout ms (optional)" bind:value={fTimeout} size="12" />
      <label class="remote-decl">
        <input
          type="checkbox"
          data-testid="remote-declared"
          bind:checked={fRemoteDeclared}
          onchange={() => (fRemoteTouched = true)}
        />
        a remote MCP server already serves this database
      </label>
      {#if fRemoteDeclared}
        <input placeholder="remote MCP URL (optional)" bind:value={fRemoteUrl} size="30" />
      {/if}
      <button type="submit">Save profile</button>
      <p class="form-hint">
        Only relations in these schemas appear on the map; foreign keys pointing to other schemas
        are not shown - include those schemas here to see them.
      </p>
    </form>
  {/if}
  {#if formError}<p class="error" data-testid="form-error">{formError}</p>{/if}

  {#if Object.keys(searchable).length > 0}
    <SearchBar contexts={searchable} onjump={jumpTo} />
  {/if}

  <OverviewCards
    {profiles}
    {results}
    selected={selectedProfile}
    {inspecting}
    {mcpMode}
    {mcp}
    {duplicatePending}
    oninspect={(name) => void inspect(name)}
    onselect={selectProfile}
    ondelete={(name) => void remove(name)}
    onmcpstart={(name) => void mcpStart(name)}
    onmcpstop={(name) => void mcpStop(name)}
    onmcpoverride={(name) => void mcpStart(name, true)}
    onmcpcancel={() => (duplicatePending = null)}
    onmcpreassign={(name) => void mcpReassign(name)}
    onmcpconfig={(name) => (snippetFor = snippetFor === name ? null : name)}
  />

  {#if mcpMode === 'local' && snippet !== null && snippetFor !== null}
    <section class="snippets" data-testid="mcp-snippets">
      <div class="snippets-head">
        <strong>AI client config - {snippet.serverName}</strong>
        <button onclick={() => (snippetFor = null)}>close</button>
      </div>
      {#if mcp[snippetFor]?.status !== 'running'}
        <p class="form-hint">(server currently stopped - start it before connecting)</p>
      {/if}
      <div class="snippet-row">
        <span>Cursor (mcpServers JSON)</span>
        <button onclick={() => snippet !== null && copyText(snippet.mcpServersJson)}>copy</button>
      </div>
      <pre data-testid="mcp-snippet-json">{snippet.mcpServersJson}</pre>
      <div class="snippet-row">
        <span>Claude Code</span>
        <button onclick={() => snippet !== null && copyText(snippet.claudeCodeCommand)}>copy</button>
      </div>
      <pre data-testid="mcp-snippet-command">{snippet.claudeCodeCommand}</pre>
      <div class="snippet-row">
        <span>Claude Desktop (add as a custom connector - paste this URL)</span>
        <button onclick={() => snippet !== null && copyText(snippet.httpUrl)}>copy</button>
      </div>
      <pre data-testid="mcp-snippet-url">{snippet.httpUrl}</pre>
      <p class="form-hint">
        The URL embeds this profile's secret path - treat the pasted config like a
        credential-adjacent file. The server listens on 127.0.0.1 only and serves read-only
        describe tools.
      </p>
    </section>
  {/if}

  {#if selectedProfile}
    <section class="workspace">
      {#if inspecting === selectedProfile && !current}
        <p data-testid="inspect-running">Introspecting {selectedProfile}...</p>
      {:else if current && !current.ok}
        <p class="error" data-testid="inspect-error">{current.error}</p>
      {:else if current?.ok && currentContext}
        <p class="stats" data-testid="inspect-stats">
          {selectedProfile}: introspect {current.stats.introspectMs}ms - build {current.stats.buildMs}ms
          - full {(current.stats.fullBytes / 1024).toFixed(1)}KiB - sent
          {(current.stats.trimmedBytes / 1024).toFixed(1)}KiB context + {(
            current.stats.aiViewsBytes / 1024
          ).toFixed(1)}KiB AI views
        </p>
        <div class="split">
          <SemanticMap
            context={currentContext}
            selected={selectedEntity}
            onselect={(id) => (selectedEntity = id)}
          />
          {#if selectedEntity}
            <DetailPane context={currentContext} aiViews={current.aiViews} selected={selectedEntity} />
          {:else}
            <aside class="placeholder">Click a relation on the map to see its compiled semantics - and what a default-configured kozou server hands your AI for it.</aside>
          {/if}
        </div>
        <FunctionsPanel functions={currentContext.functions ?? []} aiText={current.aiViews.functions} />
        <EnumsPanel enums={currentContext.enums} />
      {:else}
        <p class="empty-note">
          {selectedProfile} is not inspected yet - use its card's inspect link{inspecting
            ? ` (waiting: ${inspecting} is being inspected)`
            : ''}.
        </p>
      {/if}
    </section>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, sans-serif;
    color: #1a1a1a;
    background: #fafafa;
  }
  main {
    max-width: 1280px;
    margin: 0 auto;
    padding: 1rem 1.5rem 3rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .top-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .mcp-mode {
    font-size: 0.8rem;
    color: #444;
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .mcp-mode select {
    padding: 0.25rem 0.4rem;
    border: 1px solid #ccc;
    border-radius: 6px;
    background: #fff;
    font: inherit;
  }
  .mode-confirm {
    font-size: 0.78rem;
    color: #7a5b00;
    background: #fffbe8;
    border: 1px solid #eedc9a;
    border-radius: 6px;
    padding: 0.2rem 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .remote-decl {
    font-size: 0.8rem;
    color: #444;
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .snippets {
    border: 1px solid #ddd;
    border-radius: 10px;
    background: #fff;
    padding: 0.6rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .snippets-head,
  .snippet-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.85rem;
  }
  .snippets pre {
    margin: 0;
    background: #f6f6f6;
    border-radius: 6px;
    padding: 0.5rem;
    font-size: 0.72rem;
    overflow-x: auto;
  }
  h1 {
    font-size: 1.15rem;
    margin: 0;
  }
  .tag {
    font-size: 0.7rem;
    font-weight: normal;
    color: #666;
    border: 1px solid #ccc;
    border-radius: 999px;
    padding: 0.1rem 0.5rem;
    vertical-align: middle;
  }
  form {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  input {
    padding: 0.35rem 0.5rem;
    border: 1px solid #ccc;
    border-radius: 6px;
  }
  button {
    padding: 0.35rem 0.8rem;
    border: 1px solid #bbb;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
  }
  button:hover {
    background: #f0f0f0;
  }
  .add {
    font-size: 0.85rem;
  }
  .error {
    color: #a00;
    margin: 0;
  }
  .form-hint {
    flex-basis: 100%;
    margin: 0;
    color: #888;
    font-size: 0.75rem;
  }
  .empty-note {
    color: #888;
    margin: 0;
  }
  .stats {
    color: #555;
    font-size: 0.8em;
    margin: 0;
  }
  .workspace {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .split {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(300px, 1fr);
    gap: 0.7rem;
  }
  .placeholder {
    border: 1px dashed #ccc;
    border-radius: 8px;
    color: #888;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    text-align: center;
    height: 460px;
    box-sizing: border-box;
  }
</style>
