// Claims about what an operator can read off the screen, all of which regress
// silently in markup:
//
//   * the MCP permission's copy asks about permission and never answers a
//     question about running servers. The header used to answer it as a
//     question ("MCP served by:", then "This app may serve MCP:") and readers
//     took the answer for state; the copy moved to Settings, and what it must
//     not do is bring the old reading with it;
//   * the withdrawal prompt neither promises the servers will stop nor calls
//     them all "running";
//   * a declaration is reported without a mode and without claiming the app
//     checked anything;
//   * the row-access ladder is legible before its first step — that editing is
//     a second approval, and where rows appear once granted.

import { describe, expect, it } from 'vitest';
import {
  MCP_ALLOW_LABEL,
  MCP_ALLOW_NOTE,
  MCP_NOT_ALLOWED,
  mcpStopWarning,
  REMOTE_DECLARED,
  rowAccessNote,
  servingNote,
} from '../src/renderer/src/lib/statusCopy.js';
import type { RowAccess } from '../src/shared/types.js';

const LEVELS: RowAccess[] = ['off', 'read', 'readwrite'];

describe('MCP permission copy', () => {
  it('asks about being allowed, not about what is running', () => {
    // The label grants; it does not report. "Allow ... to serve" is a
    // permission — the infinitive says nothing about whether anything serves —
    // whereas a finite form ("serves", "is serving") or a badge word ("MCP on")
    // asserts a state this value cannot support, because it counts nothing.
    // That is the distinction the old header lost: its answer was grammatically
    // a state, and readers took it as one.
    //
    // "on" is deliberately NOT in the deny-list: the label says "on loopback",
    // where it is a preposition, and a list containing it fails on this very
    // wording (measured — it did). The badge words `MCP on :<port>` / `MCP off`
    // are the card's to avoid, and the card's own copy is checked below.
    expect(MCP_ALLOW_LABEL).toMatch(/\ballow\b/i);
    expect(MCP_ALLOW_LABEL).toMatch(/\bto serve\b/i);
    expect(MCP_ALLOW_LABEL).not.toMatch(/\bserves\b|\bserving\b|running|active|live|listening/i);
  });

  it('says that switching it on serves nothing by itself', () => {
    // The reader's actual mistake, measured: "allowed" was read as "up". The
    // note has to deny it in the same breath, and name the per-profile start as
    // what does the serving.
    expect(MCP_ALLOW_NOTE).toMatch(/nothing listens/i);
    expect(MCP_ALLOW_NOTE).toMatch(/start a profile/i);
  });

  it('says what withdrawing it does, in both directions', () => {
    // Withdrawal is two things, and an operator who is told only the first will
    // not expect the second: the servers that are up are asked to stop, and
    // further starts are refused.
    expect(MCP_ALLOW_NOTE).toMatch(/asks every server that is up to stop/i);
    expect(MCP_ALLOW_NOTE).toMatch(/refuses further starts/i);
  });

  it('never promises the note is about a server that exists', () => {
    expect(MCP_ALLOW_NOTE).not.toMatch(/is (now )?(running|serving|listening)/i);
  });

  it("names the permission on a card that cannot change it, without calling it a server state", () => {
    // 'MCP off' would read as a state the server is in; there is no server.
    expect(MCP_NOT_ALLOWED).toMatch(/not allowed/i);
    expect(MCP_NOT_ALLOWED).not.toMatch(/\boff\b|stopped|crashed/i);
    // A card cannot grant the permission, so it points at what can.
    expect(MCP_NOT_ALLOWED).toMatch(/settings/i);
  });
});

describe('mcpStopWarning', () => {
  it('does not promise the servers will stop', () => {
    // UtilityProcess.kill()'s failure result is ignored and the wait gives up
    // after three seconds, so a child that refuses to die leaves a listener
    // behind. "will stop" / "stops" would be a promise this cannot keep.
    for (const n of [1, 2, 7]) {
      const text = mcpStopWarning(n);
      expect(text).toMatch(/will be asked to stop/i);
      expect(text).not.toMatch(/will stop|stops (them|it)|are stopped|and stop\b/i);
    }
  });

  it('does not call the counted servers all running', () => {
    // The count includes 'starting' — a server whose listener has not been
    // confirmed yet — so naming only the confirmed ones undercounts what the
    // click affects. This is the assertion the previous copy failed.
    for (const n of [1, 3]) {
      const text = mcpStopWarning(n);
      expect(text).toMatch(/running or starting/i);
      expect(text).not.toMatch(/\d+ running server/i);
    }
  });

  it('agrees with itself about the number it was given', () => {
    expect(mcpStopWarning(1)).toContain('1 server ');
    expect(mcpStopWarning(2)).toContain('2 servers ');
    expect(mcpStopWarning(0)).toContain('0 servers ');
  });
});

describe('servingNote', () => {
  it('reports a declaration as a declaration, never as something checked', () => {
    const note = servingNote(true);
    expect(note?.text).toBe(REMOTE_DECLARED);
    expect(note?.text).toContain('declared');
    expect(note?.text).not.toMatch(/reachable|verified|responding|online|confirmed|up\b/i);
  });

  it('says nothing when nothing was declared', () => {
    // Silence is not a claim. "no serving server declared" made the card speak
    // about a database it knows nothing about: an operator not having recorded
    // anything is not evidence that nothing serves it.
    expect(servingNote(false)).toBeNull();
  });

  it('takes no mode, so the permission cannot change what it says', () => {
    // Structural, not textual: the badge used to be rendered from two branches
    // under two modes, which is how the app ended up saying different things
    // about the same declaration depending on a setting unrelated to it. A
    // second parameter is the regression, so pin the arity.
    expect(servingNote.length).toBe(1);
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
