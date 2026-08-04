// Two claims about what an operator can read off the screen, both of which
// regress silently in markup:
//
//   * the MCP setting answers a question about THIS APP, and a profile's
//     declaration that something else serves its database is reported whatever
//     that setting says. A third mode ('remote-only') used to carry those
//     declarations while branching no behaviour at all, and the first person to
//     use a build could not tell what choosing it would do;
//   * the row-access ladder is legible before its first step — that editing is
//     a second approval, and where rows appear once granted.

import { describe, expect, it } from 'vitest';
import {
  mcpModeLabel,
  REMOTE_DECLARED,
  rowAccessNote,
  servingNote,
} from '../src/renderer/src/lib/statusCopy.js';
import type { McpMode, RowAccess } from '../src/shared/types.js';

const MODES: McpMode[] = ['off', 'local'];
const LEVELS: RowAccess[] = ['off', 'read', 'readwrite'];

describe('mcpModeLabel', () => {
  it('answers whether this app may serve, rather than naming the setting', () => {
    expect(mcpModeLabel('off')).toBe('No');
    expect(mcpModeLabel('local')).toBe('Yes, one per profile');
  });

  it('answers about permission, not about what is running', () => {
    // 'local' allows a profile to start a server and starts none by itself, so
    // every card reads `MCP off` until one is started — the e2e asserts exactly
    // that, one line after the mode switch. A label phrased as observed state
    // contradicts those cards on the same screen, which is what the first draft
    // of this change did: it said "Yes, one per profile" under the heading "This
    // app serves MCP", and a reviewer found the contradiction in my own test.
    for (const mode of MODES) {
      expect(mcpModeLabel(mode)).not.toMatch(/serving|serves|running|active|live|listening/i);
    }
  });

  it('gives the two modes two different labels', () => {
    expect(new Set(MODES.map(mcpModeLabel)).size).toBe(2);
  });

  it('never shows the raw setting value', () => {
    // The setting's identifier leaking into the UI names the mechanism instead
    // of its effect, and 'local' as a label reads as a restriction rather than
    // as an answer.
    for (const mode of MODES) expect(mcpModeLabel(mode)).not.toBe(mode);
  });

  it('never speaks for servers this app does not run', () => {
    // The label used to answer "who serves", and "Nobody (off)" was false the
    // moment a profile declared a remote server — the same screen could print
    // the contradiction. Whatever this setting says, it may only speak about us.
    for (const mode of MODES) {
      expect(mcpModeLabel(mode)).not.toMatch(/nobody|no one|none|remote|elsewhere|only/i);
    }
  });
});

describe('servingNote', () => {
  it('reports a declaration as a declaration, not as a verified fact', () => {
    const note = servingNote(true);
    expect(note?.text).toBe(REMOTE_DECLARED);
    expect(note?.text).toContain('declared');
  });

  it('says nothing when nothing is declared', () => {
    // The common case. "None declared" on every card would make the quiet state
    // the loud one, and the absence is already visible where it is set — the
    // profile's own edit form.
    expect(servingNote(false)).toBeNull();
  });

  it('does not take this app own mode into account', () => {
    // A declaration is a fact about someone else's server: it does not stop
    // being true when our setting is off. Taking the mode is what made the note
    // vanish under 'off' and appear under a mode that did nothing else — so the
    // signature carries the declaration alone.
    expect(servingNote).toHaveLength(1);
  });

  it('never claims the app checked anything', () => {
    // There may not even be an address to have checked: a declaration is valid
    // with no URL at all.
    for (const declared of [false, true]) {
      const text = servingNote(declared)?.text ?? '';
      expect(text).not.toMatch(/reachable|verified|responding|online|confirmed/i);
    }
  });
});

describe('rowAccessNote', () => {
  it('names editing as its own approval while still off, not only after granting', () => {
    expect(rowAccessNote('off')).toContain('editing needs an approval of its own');
  });

  it('still names it at the browsing level', () => {
    expect(rowAccessNote('read')).toContain('an approval of its own');
  });

  it('says where a grant is used once it is in force', () => {
    expect(rowAccessNote('read')).toContain('Data tab');
    expect(rowAccessNote('readwrite')).toContain('Data tab');
  });

  it('says at the editing level that revoking is prompt-free', () => {
    // Revoking deliberately has no prompt, so the badge is the only warning a
    // grant is live; saying so is what makes "turn off" an obvious escape.
    expect(rowAccessNote('readwrite')).toContain('no approval');
  });

  it('does not claim editing comes after browsing', () => {
    // The main-owned gate prompts once per raise in level, so 'off' ->
    // 'readwrite' is a single approval: the ladder is this UI's offer, not an
    // invariant. Wording that ordered the two approvals would describe the
    // affordance as if it were the trust boundary.
    for (const level of LEVELS) {
      expect(rowAccessNote(level)).not.toMatch(/second|after that|first, then/i);
    }
  });

  it('does not claim rows have never been read', () => {
    // 'off' is the level in force, not a history: a browse followed by a
    // prompt-free revoke lands back here.
    expect(rowAccessNote('off')).not.toContain('yet');
    expect(rowAccessNote('off')).toContain('while this is off');
  });

  it('leaves the database as the authority on what a grant can reach', () => {
    // A grant opens the tab and lets the app ask; a revoked privilege or an RLS
    // policy answers with a refusal. Promising rows would be promising
    // something this app does not decide. The database is the authority on what
    // a grant reaches — for writing it is not the only limit, which is what the
    // next test is about.
    expect(rowAccessNote('read')).toContain('your database decides');
    expect(rowAccessNote('readwrite')).toContain('your database decides');
  });

  it('attributes our own write limits to this app, not to the database', () => {
    // `canEdit` (DetailPane.svelte) requires a table and a primary key on top of
    // the grant, and both refusals are ours: kozou answers a write to a view
    // with a 405, and a table without a primary key leaves no id to address a
    // row by. Wording that named only the database would make an operator who
    // granted editing and then selected a view read our refusal as its answer.
    //
    // Asserted as three things the text must contain rather than as a phrase it
    // must avoid: a deny-list on the database clause is satisfied by one
    // rewording, whereas dropping the attribution or the two relation shapes it
    // names is exactly the regression. Rewording these on purpose fails here,
    // which is the point — the text and this test say the same thing twice.
    //
    // What this does not catch, measured rather than assumed: text that keeps
    // all three and appends a false cause ("...because your database refuses
    // those writes"). A deny-list that caught that would also have to catch the
    // database clause this level legitimately carries, so the hole stays open.
    const rw = rowAccessNote('readwrite');
    expect(rw).toMatch(/this app offers no write controls/i);
    expect(rw).toMatch(/\bview\b/i);
    expect(rw).toMatch(/primary key/i);
  });

  it('gives every level its own text', () => {
    expect(new Set(LEVELS.map(rowAccessNote)).size).toBe(3);
  });
});
