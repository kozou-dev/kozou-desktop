<script lang="ts">
  import type { ContextView } from '../../shared/contextView';
  import type { InspectResult, ProfileView } from '../../shared/types';
  import DetailPane from './DetailPane.svelte';
  import EnumsPanel from './EnumsPanel.svelte';
  import FunctionsPanel from './FunctionsPanel.svelte';
  import OverviewCards from './OverviewCards.svelte';
  import SemanticMap from './SemanticMap.svelte';

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

  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  const current = $derived(selectedProfile ? (results[selectedProfile] ?? null) : null);
  const currentContext = $derived(current?.ok ? (current.context as ContextView) : null);

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
      });
      fName = '';
      fUrl = '';
      fSchemas = 'public';
      fTimeout = '';
      showAddForm = false;
      // The (re-)saved profile may point at a different database now — an
      // in-flight inspect for the same name must not land.
      bumpToken(name);
      delete results[name];
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
</script>

<main>
  <header class="top">
    <h1>kozou Desktop <span class="tag">Semantic Map</span></h1>
    <button class="add" onclick={() => (showAddForm = !showAddForm)}>
      {showAddForm ? 'Close' : '+ Add database'}
    </button>
  </header>

  {#if showAddForm}
    <form onsubmit={save}>
      <input placeholder="name" bind:value={fName} required />
      <input placeholder="postgresql://user:password@host:5432/db" bind:value={fUrl} required size="42" />
      <input placeholder="schemas (comma-separated)" bind:value={fSchemas} />
      <input placeholder="timeout ms (optional)" bind:value={fTimeout} size="12" />
      <button type="submit">Save profile</button>
      <p class="form-hint">
        Only relations in these schemas appear on the map; foreign keys pointing to other schemas
        are not shown - include those schemas here to see them.
      </p>
    </form>
  {/if}
  {#if formError}<p class="error" data-testid="form-error">{formError}</p>{/if}

  <OverviewCards
    {profiles}
    {results}
    selected={selectedProfile}
    {inspecting}
    oninspect={(name) => void inspect(name)}
    onselect={selectProfile}
    ondelete={(name) => void remove(name)}
  />

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
