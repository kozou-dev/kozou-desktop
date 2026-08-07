<script lang="ts">
  // The row-access level, the way to change it, and what the level means —
  // rendered from one place because two surfaces show it: the overview card in
  // the all-databases view, and the bar above the workspace for the profile
  // being worked on. Written out twice, the pair drifts the moment one of them
  // is corrected, which is the failure this app has already paid for once (a
  // claim fixed in the UI and left standing in three other surfaces).
  //
  // The words themselves live in ./lib/statusCopy.ts and are not restated here.

  import type { RowAccess } from '../../shared/types';
  import { rowAccessNote } from './lib/statusCopy';

  let {
    profile,
    level,
    pending,
    onrowaccess,
  }: {
    profile: string;
    level: RowAccess;
    /** True while this profile is the one waiting on a native approval dialog.
     *  The dialog is modal to the window, so at most one request is ever in
     *  flight app-wide. */
    pending: boolean;
    onrowaccess: (name: string, level: RowAccess) => void;
  } = $props();

  /** Row access is shown unconditionally — including the 'off' default.
   *  Granting is prompt-guarded but revoking is not (a decline on a revocation
   *  prompt would leave the dangerous state in place), so the level is stated
   *  wherever a profile is stated rather than behind anything that has to be
   *  opened: this badge is what tells an operator that a grant they do not
   *  remember making is still in force.
   *
   *  What that no longer covers, since the working area shows one profile at a
   *  time: a grant on a database the operator is not looking at. The level for
   *  every profile at once is in the all-databases view, which is one click from
   *  the top of the rail but is a click. Whether the rail should carry a marker
   *  for it is an open question and deliberately not answered here — a marker
   *  would be a third surface speaking about the same state. */
  const rowAccessBadge = (l: RowAccess): { text: string; cls: string } => {
    switch (l) {
      case 'readwrite':
        return { text: 'rows: editing', cls: 'rw' };
      case 'read':
        return { text: 'rows: browsing', cls: 'ro' };
      default:
        return { text: 'rows: off', cls: '' };
    }
  };

  const ra = $derived(rowAccessBadge(level));

  /** Keyboard/click helper for the linkish span-buttons. `stopPropagation` is
   *  unconditional: on the overview card these sit inside the card's own
   *  <button> (which selects the profile), and a click that enables browsing
   *  must not also select. In the profile bar there is nothing above them to
   *  stop, so it costs nothing there. Spans rather than buttons for the same
   *  reason — a <button> inside a <button> is not valid HTML. */
  const act = (e: Event, fn: () => void): void => {
    e.stopPropagation();
    fn();
  };
</script>

<div class="row rowaccess" data-testid={`rowaccess-${profile}`}>
  <span class={`ra-badge ${ra.cls}`} data-testid={`rowaccess-badge-${profile}`}>{ra.text}</span>
  {#if pending}
    <span class="ra-wait">waiting for approval...</span>
  {:else if level === 'off'}
    <!-- Browsing first, editing as its own step. Each level is a separate
         native approval, so nobody arrives at write access by clicking
         once — and the dialog for editing says what editing costs. -->
    <span
      class="linkish"
      role="button"
      tabindex="0"
      data-testid={`rowaccess-enable-${profile}`}
      onclick={(e) => act(e, () => onrowaccess(profile, 'read'))}
      onkeydown={(e) => e.key === 'Enter' && act(e, () => onrowaccess(profile, 'read'))}
      >enable browsing</span
    >
  {:else}
    {#if level === 'read'}
      <span
        class="linkish danger"
        role="button"
        tabindex="0"
        data-testid={`rowaccess-edit-${profile}`}
        onclick={(e) => act(e, () => onrowaccess(profile, 'readwrite'))}
        onkeydown={(e) => e.key === 'Enter' && act(e, () => onrowaccess(profile, 'readwrite'))}
        >enable editing</span
      >
    {/if}
    <span
      class="linkish danger"
      role="button"
      tabindex="0"
      data-testid={`rowaccess-off-${profile}`}
      onclick={(e) => act(e, () => onrowaccess(profile, 'off'))}
      onkeydown={(e) => e.key === 'Enter' && act(e, () => onrowaccess(profile, 'off'))}
      >turn off</span
    >
  {/if}
</div>
<!-- Stated at every level, 'off' included: the second approval and the place
     rows appear are both things an operator otherwise discovers only after
     granting.

     `prose` because this is a paragraph that is not a <p> — it cannot be one
     inside the card's <button> — so the shell's `:global(main p)` cap never
     reached it. Inside a 300px card that was invisible; in the profile bar it
     measured 982px at the default window, setting a 270-character sentence as
     ~180 characters per line. -->
<div class="row ra-note prose" data-testid={`rowaccess-note-${profile}`}>{rowAccessNote(level)}</div>

<style>
  /* Layout only. Repeated in the surfaces that host this block rather than
     hoisted to a global: these rules say nothing, so a copy of them cannot
     drift into saying something else. */
  .row {
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .rowaccess {
    font-size: 0.75rem;
    border-top: 1px dashed #eee;
    padding-top: 0.3rem;
  }
  .linkish {
    color: #2f6fed;
    cursor: pointer;
  }
  .linkish.danger {
    color: #a00;
  }
  .ra-badge {
    border: 1px solid #ccc;
    border-radius: 999px;
    padding: 0.05rem 0.5rem;
    color: #666;
    font-size: 0.72rem;
  }
  .ra-badge.ro {
    border-color: #35577d;
    color: #35577d;
    background: #f2f6fd;
  }
  .ra-badge.rw {
    border-color: #a04a00;
    color: #a04a00;
    background: #fff6ef;
  }
  .ra-wait {
    color: #7a5b00;
  }
  .ra-note {
    color: #666;
    font-size: 0.72rem;
    line-height: 1.45;
  }
</style>
