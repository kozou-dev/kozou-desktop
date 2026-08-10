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
    asButton = false,
    onrowaccess,
  }: {
    profile: string;
    level: RowAccess;
    /** True while this profile is the one waiting on a native approval dialog.
     *  The dialog is modal to the window, so at most one request is ever in
     *  flight app-wide. */
    pending: boolean;
    /** Whether this host can hold a real <button>. Only the profile bar can: the
     *  overview card is itself a <button> that selects the profile, and a <button>
     *  inside a <button> is invalid HTML — the accessibility tree of a nested
     *  interactive element is not defined, and screen readers disagree about what
     *  to announce.
     *
     *  (What it is NOT: a rendering failure. Svelte builds the card and this block
     *  as separate templates and joins them by DOM insertion, so the parser's
     *  repair — which would close the card's <button> early — never runs, and the
     *  nesting simply survives. An earlier version of this comment claimed
     *  otherwise. Measured, the card keeps all its children either way.)
     *
     *  Declared by the host and OFF by default, so that the answer a host gets by
     *  forgetting is the one that renders correctly anywhere. The default used to
     *  be spelled the other way round, `insideButton = false`, which read as the
     *  safe default and was the opposite of one. */
    asButton?: boolean;
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

  /** Keyboard/click helper for the controls. `stopPropagation` is unconditional:
   *  on the overview card these sit inside the card's own <button> (which selects
   *  the profile), and a click that enables browsing must not also select. In the
   *  profile bar there is nothing above them to stop, so it costs nothing there.
   *
   *  The span branch adds a keydown handler for Enter only. A real button answers
   *  Enter AND Space; this does not, and on the card Space is worse than inert —
   *  the key reaches the card's own <button> and selects the profile instead, and
   *  Enter fires both, because Chromium's default handlers walk the event path and
   *  are gated on preventDefault rather than on propagation. That is pre-existing
   *  (the bar's own spans behaved the same before this control had a box) and it is
   *  recorded rather than fixed here. It is also the sharper reason the bar takes a
   *  real button: on that surface the keyboard simply works. */
  const act = (e: Event, fn: () => void): void => {
    e.stopPropagation();
    fn();
  };

  /** The grants this level offers, in the order they are offered. One list so the
   *  two element kinds above cannot drift into offering different things. */
  const controls = $derived.by((): { testid: string; cls: string; label: string; run: () => void }[] =>
    level === 'off'
      ? [
          {
            testid: `rowaccess-enable-${profile}`,
            cls: 'grant',
            label: 'enable browsing',
            run: () => onrowaccess(profile, 'read'),
          },
        ]
      : [
          ...(level === 'read'
            ? [
                {
                  testid: `rowaccess-edit-${profile}`,
                  cls: 'grant danger',
                  label: 'enable editing',
                  run: () => onrowaccess(profile, 'readwrite'),
                },
              ]
            : []),
          {
            testid: `rowaccess-off-${profile}`,
            cls: 'grant danger',
            label: 'turn off',
            run: () => onrowaccess(profile, 'off'),
          },
        ],
  );
</script>

<div class="row rowaccess" data-testid={`rowaccess-${profile}`}>
  <span class={`ra-badge ${ra.cls}`} data-testid={`rowaccess-badge-${profile}`}>{ra.text}</span>
  {#if pending}
    <span class="ra-wait">waiting for approval...</span>
  {:else}
    <!-- Browsing first, editing as its own step. Each level is a separate
         native approval, so nobody arrives at write access by clicking
         once — and the dialog for editing says what editing costs. -->
    {#each controls as c (c.testid)}
      {#if !asButton}
        <span
          class={c.cls}
          role="button"
          tabindex="0"
          data-testid={c.testid}
          onclick={(e) => act(e, c.run)}
          onkeydown={(e) => e.key === 'Enter' && act(e, c.run)}>{c.label}</span
        >
      {:else}
        <button type="button" class={c.cls} data-testid={c.testid} onclick={(e) => act(e, c.run)}
          >{c.label}</button
        >
      {/if}
    {/each}
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
  /* These look like controls, which they had not until now. What they were: blue
     0.75rem text with `cursor: pointer` and nothing else — no border, no
     background, no padding — sitting next to a status badge that DID have a
     border. An operator reading that row sees one bordered thing (the state) and
     some coloured words, and the words are the only way to grant anything.
     Two attempts at this failed, and both changed the wording; the settled scope
     for the discoverability of this control is "wording and presentation", and
     presentation had never been touched. So: a box, a background, and room to be
     pressed, the same shape as every other control in the app.
     Written to cover both element kinds, since the card cannot use a <button>. */
  .grant {
    border: 1px solid #2f6fed;
    border-radius: 6px;
    background: #eef3ff;
    padding: 0.15rem 0.55rem;
    color: #2f6fed;
    /* `font: inherit` is for the button, which would otherwise take the platform's
       own family and size. Nothing else about the type is set here: an earlier
       version added `font-size: 0.72rem` "for the button", which the button was
       already inheriting from `.rowaccess` — so all it did was shrink the label
       from 12px to 11.52px on both kinds. Making the words 4% smaller is the
       wrong direction for a control two people could not find. */
    font: inherit;
    cursor: pointer;
  }
  .grant:hover {
    background: #dfe9ff;
  }
  .grant.danger {
    border-color: #a00;
    background: #fff2f2;
    color: #a00;
  }
  .grant.danger:hover {
    background: #ffe6e6;
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
