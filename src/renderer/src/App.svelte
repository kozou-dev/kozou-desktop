<script lang="ts">
  import type { ContextView } from '../../shared/contextView';
  import type {
    InspectResult,
    McpMode,
    McpStatusEntry,
    ProfileView,
    RowAccess,
  } from '../../shared/types';
  import DetailPane from './DetailPane.svelte';
  import DraftPanel from './DraftPanel.svelte';
  import EnumsPanel from './EnumsPanel.svelte';
  import FunctionsPanel from './FunctionsPanel.svelte';
  import OverviewCards from './OverviewCards.svelte';
  import SearchBar from './SearchBar.svelte';
  import SemanticMap from './SemanticMap.svelte';
  import { buildMcpClientSnippets } from '../../shared/mcpSnippet';
  import type { CommentDraft } from './lib/commentEmit';
  import { MCP_ALLOW_LABEL, MCP_ALLOW_NOTE, mcpStopWarning } from './lib/statusCopy';

  const api = window.kozouDesktop;

  let profiles = $state<ProfileView[]>([]);
  let results = $state<Record<string, InspectResult>>({});
  let selectedProfile = $state<string | null>(null);
  let selectedEntity = $state<string | null>(null);
  let inspecting = $state<string | null>(null);
  let formError = $state<string | null>(null);
  let showAddForm = $state(false);
  let showSettings = $state(false);
  // A profile's identity is not its name across delete/re-create or a
  // URL-changing re-save: bump a per-name token on every mutation and drop
  // in-flight inspect results whose token no longer matches.
  const profileTokens = new Map<string, number>();
  // The same invalidation, in a form the template can key on: row-data panels
  // hold their own cursors and pages, and a profile that now points elsewhere
  // must not keep paging a previous database's rows behind an unchanged name.
  let profileEpoch = $state(0);
  const bumpToken = (name: string): void => {
    profileTokens.set(name, (profileTokens.get(name) ?? 0) + 1);
    profileEpoch += 1;
  };
  /** Drop a profile's drafted statements. They name relations in a specific
   *  database, so a profile that was repointed, re-saved or deleted stops
   *  offering them rather than letting them follow the name somewhere they may
   *  not apply. Deliberately NOT part of bumpToken: the token is bumped BEFORE
   *  the store is asked, so that an in-flight inspect cannot land, and a refused
   *  delete would then have discarded work while changing nothing. */
  const dropDrafts = (name: string): void => {
    drafts = drafts.filter((d) => d.profile !== name);
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

  // Local MCP: the app-wide permission (owned by the Settings panel) and the
  // live per-profile registry pushed from main (the store's allocation and
  // autoStart ride the same entries).
  //
  // `mcpKnown` is false until BOTH have been read, and the 'off' below is a
  // placeholder rather than an answer. Either value alone lets a card state
  // something it cannot support: the permission without the registry cannot say
  // what is running, and the registry without the permission cannot say whether
  // a start is even allowed. Nothing that speaks for either is rendered while
  // this is false — not the card rows, and not the Settings control, whose
  // unchecked box would read as "not allowed" before anything was read.
  let mcpMode = $state<McpMode>('off');
  let mcp = $state<Record<string, McpStatusEntry>>({});
  let mcpKnown = $state(false);
  // Distinct from `!mcpKnown`: that one covers "not read yet" as well, and the
  // two need different words on screen.
  let mcpReadFailed = $state(false);
  let duplicatePending = $state<{ profile: string; duplicates: string[] } | null>(null);
  // A native approval dialog is modal to the window, so at most one row-access
  // request can be in flight; the name is held to show which card is waiting.
  let rowAccessPending = $state<string | null>(null);
  let pendingMode = $state<McpMode | null>(null);
  // True from the click that writes the permission until the write has settled.
  let applyingMode = $state(false);
  // Bumped when the checkbox has to be rebuilt from `mcpMode`: either its DOM
  // state has diverged from the permission in force — the one case Svelte cannot
  // repair on its own, since the box moved and `mcpMode` did not, leaving
  // nothing for `checked={...}` to re-apply — or a confirmation it opened has
  // closed and the focus has to come back to something.
  let modeControlEpoch = $state(0);
  // Whether the next rebuild should take the focus. Set only by the paths that
  // are a response to the operator's own click, and only while the panel
  // holding the control is open — an intent recorded while it is closed is
  // never consumed, and would then fire on whatever mount came next, taking the
  // focus the moment the panel was reopened. Cleared by the action that consumes
  // it and by closing the panel. Not $state: the action reads it while the
  // rebuild is applied, and nothing renders from it.
  let refocusMode = false;
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

  /** Both reads land together or neither does: `mcpKnown` gates every surface
   *  that speaks for the permission or for what is running, so flipping it
   *  after only one of the two had arrived would re-open the gap it exists to
   *  close.
   *
   *  A failure is its own state rather than a longer wait. "Reading the stored
   *  setting..." left up after the read has already failed is a false sentence
   *  of exactly the kind this screen exists to avoid, and there was nothing to
   *  retry with. */
  async function initMcp(): Promise<void> {
    mcpReadFailed = false;
    try {
      const mode = await api.mcpModeGet();
      const status = await api.mcpStatus();
      mcpMode = mode;
      applyMcpStatus(status);
      mcpKnown = true;
    } catch (err) {
      mcpReadFailed = true;
      formError = message(err);
    }
  }
  api.onMcpStatusChanged(applyMcpStatus);

  /** Withdrawing the permission while servers are up asks first (they are asked
   *  to stop; per-profile autoStart intents survive for the next launch). */
  async function requestMode(next: McpMode): Promise<void> {
    if (next === mcpMode) {
      // Reachable only if the box was already out of step with the permission
      // in force — the control is disabled while a confirmation is open, so
      // this is a resync rather than an undo.
      pendingMode = null;
      refocusMode = showSettings;
      modeControlEpoch += 1;
      return;
    }
    if (mcpMode === 'local' && runningCount > 0) {
      pendingMode = next;
      // The box has moved but nothing has been written yet, so it is showing an
      // answer that is not in force. Rebuild it from `mcpMode`: while the
      // confirmation is open the old permission still stands, cards can still
      // start servers, and cancelling leaves everything as it was. The focus
      // goes to the prompt instead of coming back here — it is what the
      // operator now has to answer.
      refocusMode = false;
      modeControlEpoch += 1;
      return;
    }
    await applyMode(next);
  }

  /** Writes the permission and leaves the control showing whatever is in force
   *  afterwards. Two reasons to rebuild: the write did not land on the value
   *  that was asked for (the box is asserting a permission the store refused),
   *  or a confirmation was open and its buttons are about to be removed with the
   *  focus still on one of them. A plain successful toggle rebuilds nothing —
   *  `mcpMode` moved, so Svelte re-applies `checked` and the focus never left.
   *
   *  Clearing `pendingMode` first (as an earlier version did) was the bug: the
   *  rebuild was keyed on the value being cleared, so a failed write left the
   *  box asserting the refused permission with nothing to trigger a repair. */
  async function applyMode(next: McpMode): Promise<void> {
    const wasConfirming = pendingMode !== null;
    applyingMode = true;
    formError = null;
    try {
      mcpMode = await api.mcpModeSet(next);
      applyMcpStatus(await api.mcpStatus());
    } catch (err) {
      formError = message(err);
    } finally {
      applyingMode = false;
      pendingMode = null;
      if (wasConfirming || mcpMode !== next) {
        // Only if the control is on screen to receive it: the write can settle
        // after the panel was closed, and an intent left set then would fire on
        // the next open.
        refocusMode = showSettings;
        modeControlEpoch += 1;
      }
    }
  }

  /** Cancelling writes nothing. The box already shows the permission in force
   *  (it was rebuilt when the confirmation opened), so this closes the prompt
   *  and hands the focus back to the control. */
  function cancelMode(): void {
    pendingMode = null;
    refocusMode = showSettings;
    modeControlEpoch += 1;
  }

  /** Closing the panel drops any focus intent with it. The control it named is
   *  gone, and the operator's next click was on the toggle, not on it. */
  function toggleSettings(): void {
    showSettings = !showSettings;
    if (!showSettings) refocusMode = false;
  }

  /** The `{#key}` rebuild throws the control away, and with it the focus and
   *  assistive-technology context of whoever was operating it. Every rebuild
   *  that answers the operator's own click puts the focus back; the first render
   *  and a panel simply being reopened do not, because nothing was operated and
   *  stealing the focus from the page would be wrong. */
  function refocusControl(node: HTMLElement): void {
    if (!refocusMode) return;
    refocusMode = false;
    node.focus();
  }

  /** Focus the confirmation's primary button as it appears. The prompt is
   *  announced by `role="alert"` and does not trap the focus: it is not modal
   *  (the cards behind it stay live, which is deliberate — a server can still
   *  be stopped by hand while it is open), so this places the focus rather than
   *  holding it. */
  function focusOnMount(node: HTMLElement): void {
    node.focus();
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

  /** Ask main to change a profile's row-access level. An escalation opens a
   *  native dialog owned by main, so this call can sit unresolved for as long
   *  as the operator takes; the returned value is the level actually in force
   *  afterwards, which is 'off' when the prompt was declined. */
  async function setRowAccess(name: string, level: RowAccess): Promise<void> {
    if (rowAccessPending !== null) return;
    formError = null;
    rowAccessPending = name;
    let applied: RowAccess | undefined;
    try {
      applied = await api.requestRowAccess(name, level);
    } catch (err) {
      formError = message(err);
    } finally {
      rowAccessPending = null;
    }
    // The returned value is the level in force in main's store afterwards, so
    // apply it here rather than waiting on a second round trip. The badge is
    // the only warning that a grant is live (revoking is prompt-free by
    // decision, so nothing else announces the level), and a badge that lags —
    // or that a failed refresh leaves lagging for good — is exactly the failure
    // that control exists to prevent. A rejection needs no fallback: every
    // throw on that path happens before the store is written, so the level the
    // card already shows is still the level in force.
    if (applied !== undefined) {
      profiles = profiles.map((p) => (p.name === name ? { ...p, rowAccess: applied } : p));
    }
    try {
      // Then reconcile: the profile may have been deleted while the prompt was
      // open, and the store is the authority on what still exists.
      profiles = await api.listProfiles();
    } catch (err) {
      formError = message(err);
    }
    // A revocation must not leave a browse panel holding rows it may no longer
    // fetch, and an escalation restarts the worker — either way the panel's
    // cursors belong to the previous grant.
    profileEpoch += 1;
  }

  function copyText(text: string): void {
    // Best-effort: the snippet stays visible for manual copy if the
    // clipboard API refuses.
    void navigator.clipboard.writeText(text).catch(() => {});
  }

  // -- Drafted COMMENT statements ------------------------------------------
  // Generated, never applied. Held for the session and per profile: a draft is
  // an unapplied schema change written against one specific database, so it is
  // dropped the moment that profile stops being the same thing (see bumpToken).
  let drafts = $state<CommentDraft[]>([]);
  let draftStatus = $state<string | null>(null);
  /** Which profile, and which exact draft set, the status was produced for. */
  let draftStatusKey = $state<string | null>(null);
  let nextDraftId = 0;

  const currentDrafts = $derived(drafts.filter((d) => d.profile === selectedProfile));
  /** The status describes a specific set of statements at a specific moment, so
   *  it is shown only while that is still what the panel holds. Switching
   *  profiles, or adding/removing a draft, makes "Copied"/"Saved" a claim about
   *  something the operator is no longer looking at. */
  const draftStatusFor = $derived(
    draftStatusKey === `${selectedProfile}|${currentDrafts.map((d) => d.id).join(',')}`
      ? draftStatus
      : null,
  );
  function setDraftStatus(text: string | null): void {
    draftStatus = text;
    draftStatusKey =
      text === null ? null : `${selectedProfile}|${currentDrafts.map((d) => d.id).join(',')}`;
  }

  function addDraft(target: string, sql: string): void {
    if (selectedProfile === null) return;
    setDraftStatus(null);
    drafts = [...drafts, { id: (nextDraftId += 1), profile: selectedProfile, target, sql }];
  }

  function removeDraft(id: number): void {
    drafts = drafts.filter((d) => d.id !== id);
  }

  function clearCurrentDrafts(): void {
    setDraftStatus(null);
    drafts = drafts.filter((d) => d.profile !== selectedProfile);
  }

  async function copyDrafts(text: string): Promise<void> {
    // Reported from the outcome, not from having asked. The clipboard API can
    // refuse (a window that is not focused, a platform that declines), and a
    // panel that says "Copied" when nothing was copied sends the operator to
    // paste something that is not there.
    try {
      await navigator.clipboard.writeText(text);
      setDraftStatus('Copied to the clipboard.');
    } catch {
      setDraftStatus('The clipboard refused - the statements are above, select and copy them.');
    }
  }

  async function saveDrafts(text: string): Promise<void> {
    const suggested = selectedProfile === null ? 'comments.sql' : `${selectedProfile}-comments.sql`;
    try {
      const { saved } = await api.saveSqlFile(suggested, text);
      setDraftStatus(saved ? 'Saved. Apply it yourself - this app runs nothing.' : null);
    } catch (err) {
      setDraftStatus(`Not saved: ${message(err)}`);
    }
  }

  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  const currentProfile = $derived(profiles.find((p) => p.name === selectedProfile) ?? null);
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
      dropDrafts(name);
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
    dropDrafts(name);
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
    <!-- Nothing here speaks for MCP. The permission lived here as an answered
         question ("MCP served by:", then "This app may serve MCP:") above cards
         reporting per-profile state, and both readings collapsed into "so is
         MCP running?" — which the permission cannot answer, because it counts
         nothing. It is a setting, so it is in Settings; what is running is said
         by the card whose server it is, and no aggregate is stated here (that
         would put the same claim on two surfaces again). -->
    <div class="top-actions">
      <button class="add" data-testid="settings-toggle" onclick={toggleSettings}>
        {showSettings ? 'Close' : 'Settings'}
      </button>
      <button class="add" data-testid="add-toggle" onclick={() => (showAddForm = !showAddForm)}>
        {showAddForm ? 'Close' : '+ Add database'}
      </button>
    </div>
  </header>

  {#if showSettings}
    <section class="settings" data-testid="settings">
      <strong>MCP</strong>
      {#if mcpKnown}
        <!-- Rebuilt whenever the box has diverged from the permission in force;
             see `modeControlEpoch`. Keying is what makes the repair possible at
             all: after a click Svelte sees an unchanged `mcpMode` and has
             nothing to re-apply. Note what this does NOT claim — while a
             straight toggle is being written the box holds the value that was
             clicked (disabled), because that value is the one about to be in
             force; it is rebuilt from `mcpMode` only if the write does not land
             there. The confirmation path is the one that shows the old
             permission throughout, and it has to: the servers are still up. -->
        {#key modeControlEpoch}
          <label class="mcp-allow">
            <input
              type="checkbox"
              data-testid="mcp-allow"
              checked={mcpMode === 'local'}
              disabled={pendingMode !== null || applyingMode}
              onchange={(e) => void requestMode(e.currentTarget.checked ? 'local' : 'off')}
              use:refocusControl
            />
            {MCP_ALLOW_LABEL}
          </label>
        {/key}
        <p class="form-hint">{MCP_ALLOW_NOTE}</p>
        {#if pendingMode !== null}
          <!-- Says what is affected and asks; it does not promise the servers
               will be gone (see `mcpStopWarning`). "turn it off" is the part
               this can guarantee: the permission is written and takes effect. -->
          <div class="mode-confirm" role="alert" data-testid="mcp-mode-confirm">
            <span>{mcpStopWarning(runningCount)}</span>
            <button
              data-testid="mcp-mode-confirm-yes"
              use:focusOnMount
              onclick={() => pendingMode !== null && void applyMode(pendingMode)}>turn it off</button
            >
            <button data-testid="mcp-mode-confirm-no" onclick={cancelMode}>cancel</button>
          </div>
        {/if}
      {:else if mcpReadFailed}
        <!-- Neither the control nor a claim of progress: the read is over and it
             failed, so the only honest things here are that it failed and a way
             to ask again. The reason is in the error line above. -->
        <p class="form-hint" data-testid="mcp-allow-failed">
          Could not read the stored setting, so this app cannot say whether profiles may serve MCP.
          <button data-testid="mcp-allow-retry" onclick={() => void initMcp()}>try again</button>
        </p>
      {:else}
        <!-- The stored permission has not been read yet, and an unchecked box
             would answer "not allowed" on its behalf. -->
        <p class="form-hint" data-testid="mcp-allow-unknown">Reading the stored setting...</p>
      {/if}
    </section>
  {/if}

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
    {mcpKnown}
    {mcp}
    {duplicatePending}
    {rowAccessPending}
    oninspect={(name) => void inspect(name)}
    onselect={selectProfile}
    ondelete={(name) => void remove(name)}
    onrowaccess={(name, level) => void setRowAccess(name, level)}
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
        <span>Server URL (for a client that takes a URL directly)</span>
        <button onclick={() => snippet !== null && copyText(snippet.httpUrl)}>copy</button>
      </div>
      <pre data-testid="mcp-snippet-url">{snippet.httpUrl}</pre>
      <p class="form-hint">
        The URL embeds this profile's secret path - treat the pasted config like a
        credential-adjacent file. The server listens on 127.0.0.1 only and serves read-only
        describe tools.
      </p>
      <p class="form-hint">
        Claude Desktop cannot reach this server: its custom connectors are opened from
        Anthropic's cloud and need a publicly reachable https address, and its own config
        file launches local commands rather than connecting to a URL. Reaching it from
        there needs a local stdio bridge, which this app does not provide.
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
          {#if selectedEntity && selectedProfile}
            <DetailPane
              context={currentContext}
              aiViews={current.aiViews}
              selected={selectedEntity}
              profile={selectedProfile}
              rowAccess={currentProfile?.rowAccess ?? 'off'}
              epoch={profileEpoch}
              ondraft={addDraft}
            />
          {:else}
            <!-- The sentence is a paragraph so it is capped like every other one;
                 the aside itself must keep filling the pane, so the cap cannot go
                 on the box. -->
            <aside class="placeholder"><p>Click a relation on the map to see its compiled semantics - and what a default-configured kozou server hands your AI for it.</p></aside>
          {/if}
        </div>
        {#if currentDrafts.length > 0}
          <DraftPanel
            drafts={currentDrafts}
            status={draftStatusFor}
            onremove={removeDraft}
            onclear={clearCurrentDrafts}
            oncopy={copyDrafts}
            onsave={saveDrafts}
          />
        {/if}
        <FunctionsPanel functions={currentContext.functions ?? []} aiViews={current.aiViews} />
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
  /* No width cap. The working surfaces here are a graph and a row grid, and
     both spend width on content rather than on line length — a 1280px cap left
     a wide window mostly empty while the pane an operator was editing in stayed
     at a fraction of it. Prose is the one thing that does not want the width,
     so prose caps itself (see the `:global(main p)` rule below).

     `height`, not `min-height`. This is the load-bearing line: a definite height
     is what reaches the grid row below and lets the panes scroll inside
     themselves. `min-height` is only a floor — the box stays content-sized, so
     nothing below it can resolve a height, `overflow-y: auto` on a pane never
     engages, and the pane grows instead. Measured that way at this app's default
     1280x840 window: opening the AI view tab made the shell 1799px tall in an
     812px viewport, the map a 1372px empty box, and the map legend unreachable
     below the fold. `100dvh` is `100vh` in an Electron window (no dynamic
     toolbars); it is spelled `dvh` as the statement of intent. `100%` would not
     work here — neither `html`, `body` nor `#app` carries a height. */
  main {
    box-sizing: border-box;
    height: 100dvh;
    /* The bottom padding does not reach the scrolled region, and there is no
       cheap way to make it: in the accepted overflow case (see .split) the
       content escapes from inside .workspace, past anything placed after it, so
       neither a spacer element here nor padding on .workspace ends up below the
       part that overflows. Measured: a 1.1rem spacer as the shell's last child
       still had 43px of workspace content scrolling below it. Left as it is —
       the last panel sits flush with the end of the scroll — rather than shipping
       an element that looks like it solves this and does not. */
    padding: 1rem 1.5rem 2rem;
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
  .settings {
    border: 1px solid #ddd;
    border-radius: 10px;
    background: #fff;
    padding: 0.6rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    align-items: flex-start;
  }
  .settings strong {
    font-size: 0.85rem;
  }
  .mcp-allow {
    font-size: 0.85rem;
    color: #444;
    display: flex;
    align-items: center;
    gap: 0.4rem;
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
  /* The one thing that does not want the window's full width: a sentence set
     across 1900px is harder to read than the same sentence at 78 characters.
     Capped on the text (see the rule below) rather than by capping the page,
     because the map and the row grid want every pixel.

     Declared once, globally, and keyed on the element rather than on a class,
     because both narrower forms had already leaked. Scoped to this file it missed
     DraftPanel entirely; keyed on `.hint`/`.form-hint` it missed `.error`,
     `.empty-note` and the placeholder's sentence — three more surfaces that are
     prose by any reading. Every paragraph in the shell is capped, whichever
     component renders it, and there is nothing to remember to add.

     `max-width` only ever constrains, so a paragraph in a container narrower than
     78ch is unaffected. Inline `<span class="hint">` (JsonTree, the @policy
     aside) is unaffected too — max-width does not apply to inline boxes.
     `.prose` stays as the opt-in for prose that is not a paragraph. */
  :global(main p),
  :global(.prose) {
    max-width: 78ch;
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
    flex: 1;
    min-height: 0;
  }
  /* An explicit single row rather than relying on an auto row stretching: the
     panes scroll inside themselves, and that needs a height they can resolve
     against.

     The floor is what the panes keep when the window cannot pay for them, and
     460px is what they used to be — a shorter window must not come out of this
     change with less room than it had. When the rest of the shell plus that floor
     exceeds the window, the content overflows its own `height` and the page
     scrolls; that is the accepted degradation, not a failure.

     Measured, because the reason here is easy to get wrong — I got it wrong twice
     — so these are numbers off the instrument in the built app at the default
     1280x840 window (812px of viewport), with two profiles: everything above
     .workspace is 328px, this row is at its 460px floor, and the shell's content
     comes to 855px, so it spills by 43px. What does not fit is the collapsed
     Functions and Enums panels BELOW this row inside .workspace — not the cards,
     which measure 208px at two profiles and 407px at five, so it would take nine
     or ten to fill the viewport on their own. What several profiles do is squeeze
     .workspace down onto this floor, which is a different thing from overflowing
     it. */
  .split {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(300px, 1fr);
    grid-template-rows: minmax(0, 1fr);
    gap: 0.7rem;
    flex: 1;
    min-height: 460px;
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
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
  }
  .placeholder p {
    margin: 0;
  }
</style>
