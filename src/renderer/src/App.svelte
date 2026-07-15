<script lang="ts">
  import type { InspectResult, ProfileView } from '../../shared/types';
  import { displayConnection } from '../../shared/url';
  import JsonTree from './JsonTree.svelte';

  const api = window.kozouDesktop;

  let profiles = $state<ProfileView[]>([]);
  let selected = $state<string | null>(null);
  let result = $state<InspectResult | null>(null);
  let inspecting = $state(false);
  let formError = $state<string | null>(null);

  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  // Add-profile form
  let fName = $state('');
  let fUrl = $state('');
  let fSchemas = $state('public');
  let fTimeout = $state('');

  async function refresh(): Promise<void> {
    try {
      profiles = await api.listProfiles();
    } catch (err) {
      formError = message(err);
    }
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    formError = null;
    try {
      profiles = await api.saveProfile({
        name: fName.trim(),
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
    } catch (err) {
      formError = message(err);
    }
  }

  async function remove(name: string): Promise<void> {
    try {
      profiles = await api.deleteProfile(name);
    } catch (err) {
      formError = message(err);
      return;
    }
    if (selected === name) {
      selected = null;
      result = null;
    }
  }

  async function inspect(name: string): Promise<void> {
    selected = name;
    inspecting = true;
    result = null;
    try {
      result = await api.inspect(name);
    } catch (err) {
      // An IPC rejection (e.g. the OS keychain refused to decrypt) must
      // surface in the UI, not vanish as an unhandled rejection.
      result = { ok: false, error: message(err) };
    } finally {
      inspecting = false;
    }
  }

  void refresh();
</script>

<main>
  <h1>kozou Desktop <span class="tag">Semantic Map MVP — M1</span></h1>

  <section class="profiles">
    <h2>Profiles</h2>
    {#if profiles.length === 0}
      <p class="empty">No profiles yet. Add a database below.</p>
    {/if}
    <ul>
      {#each profiles as p (p.name)}
        <li class:active={selected === p.name}>
          <span class="dot" style:background={p.color ?? '#888'}></span>
          <strong>{p.name}</strong>
          <!-- Compact host/db form: no scheme, no username — keeps
               screenshots of this list low on identifiers. -->
          <code>{displayConnection(p.url)}</code>
          <span class="schemas">[{p.schemas.join(', ')}]</span>
          <button onclick={() => inspect(p.name)} disabled={inspecting}>Inspect</button>
          <button class="danger" onclick={() => remove(p.name)}>Delete</button>
        </li>
      {/each}
    </ul>

    <form onsubmit={save}>
      <input placeholder="name" bind:value={fName} required />
      <input placeholder="postgresql://user:password@host:5432/db" bind:value={fUrl} required size="42" />
      <input placeholder="schemas (comma-separated)" bind:value={fSchemas} />
      <input placeholder="timeout ms (optional)" bind:value={fTimeout} size="12" />
      <button type="submit">Save profile</button>
    </form>
    {#if formError}<p class="error" data-testid="form-error">{formError}</p>{/if}
  </section>

  <section class="result">
    <h2>Compiled semantic model {selected ? `— ${selected}` : ''}</h2>
    {#if inspecting}
      <p data-testid="inspect-running">Introspecting…</p>
    {:else if result === null}
      <p class="empty">Select a profile and press Inspect.</p>
    {:else if result.ok}
      <p class="stats" data-testid="inspect-stats">
        introspect {result.stats.introspectMs}ms · build {result.stats.buildMs}ms · full
        {(result.stats.fullBytes / 1024).toFixed(1)}KiB · sent {(result.stats.trimmedBytes / 1024).toFixed(1)}KiB
      </p>
      <div class="tree" data-testid="context-tree">
        <JsonTree name="SchemaContext" value={result.context} open />
      </div>
    {:else}
      <p class="error" data-testid="inspect-error">{result.error}</p>
    {/if}
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, sans-serif;
    color: #1a1a1a;
    background: #fafafa;
  }
  main {
    max-width: 1100px;
    margin: 0 auto;
    padding: 1rem 1.5rem 3rem;
  }
  h1 {
    font-size: 1.2rem;
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
  section {
    margin-top: 1.5rem;
  }
  ul {
    list-style: none;
    padding: 0;
  }
  li {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    padding: 0.35rem 0.5rem;
    border-radius: 6px;
  }
  li.active {
    background: #eef3ff;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
  }
  code {
    color: #555;
    font-size: 0.85em;
  }
  .schemas {
    color: #888;
    font-size: 0.8em;
  }
  form {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 0.75rem;
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
  .danger {
    color: #a00;
  }
  .error {
    color: #a00;
  }
  .empty {
    color: #888;
  }
  .stats {
    color: #555;
    font-size: 0.85em;
  }
  .tree {
    background: #fff;
    border: 1px solid #e2e2e2;
    border-radius: 8px;
    padding: 0.75rem;
    overflow-x: auto;
  }
</style>
