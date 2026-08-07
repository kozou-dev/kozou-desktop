<script lang="ts">
  // The left rail: one line per database, plus the all-databases view above
  // them. It exists to stop the profile list from eating the top of the window —
  // the overview cards grew with the number of databases (measured: 208px at
  // two profiles, 407px at five) and pushed the working surfaces down, so a
  // fifth database made the app worse at the thing it is for.
  //
  // Deliberately says nothing about a database beyond its identity. Row access
  // and MCP are claims about state, and they are made where there is room to
  // qualify them: on the card in the all-databases view, and in the bar above
  // the workspace for the selected profile. A badge squeezed onto a rail line
  // would be a third surface making the same claim in fewer words.

  import type { ProfileView } from '../../shared/types';

  let {
    profiles,
    selected,
    onselect,
    onall,
  }: {
    profiles: ProfileView[];
    /** null while the all-databases view is showing. */
    selected: string | null;
    onselect: (name: string) => void;
    onall: () => void;
  } = $props();
</script>

<nav class="rail" data-testid="profile-rail" aria-label="Databases">
  <button
    class="rail-item all"
    class:active={selected === null}
    data-testid="rail-all"
    aria-current={selected === null ? 'true' : undefined}
    onclick={onall}>All databases</button
  >
  {#each profiles as p (p.name)}
    <button
      class="rail-item"
      class:active={selected === p.name}
      data-testid={`rail-${p.name}`}
      aria-current={selected === p.name ? 'true' : undefined}
      onclick={() => onselect(p.name)}
    >
      <span class="dot" style:background={p.color ?? '#888'}></span>
      <span class="name">{p.label ?? p.name}</span>
    </button>
  {/each}
</nav>

<style>
  .rail {
    flex: 0 0 13rem;
    /* Its own scroll: enough databases will outgrow the window, and the rail
       overflowing the shell would put the workspace back where it started.

       The floor is what makes that scroll reachable. Without it this box is a
       flex item in a `min-height: 0` row, so every panel the shell opens above
       it comes out of the rail first — measured in the built app with five
       profiles, Settings open and a config panel open (the app's own README
       route): 124px and 3 of 6 items at the default 1280x840 window, then 0px
       and 0 of 6 at 1280x700, with 192px of rail content scrolling inside a box
       with no visible area. The workspace survived that, so the app kept a
       working pane and no way to change database. The floor is stated in rows —
       the all-databases item plus four — and when the shell cannot pay for even
       that, the page scrolls, which is the same accepted degradation as the
       pane floor in App.svelte. */
    min-height: 11rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .rail-item {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    /* One line per database, whatever the label's length. */
    text-align: left;
    padding: 0.35rem 0.5rem;
    border: 1px solid transparent;
    border-radius: 8px;
    background: none;
    font: inherit;
    font-size: 0.85rem;
    color: #333;
    cursor: pointer;
  }
  .rail-item:hover {
    background: #f0f0f0;
  }
  .rail-item.active {
    background: #fff;
    border-color: #2f6fed;
    box-shadow: 0 0 0 2px #eef3ff;
  }
  .rail-item.all {
    color: #555;
    margin-bottom: 0.3rem;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
