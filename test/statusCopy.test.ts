// Two claims about what an operator can read off the screen, both of which
// regress silently in markup:
//
//   * the three MCP modes are distinguishable. 'off' and 'remote-only' used to
//     render identically, because no behaviour branches on 'remote-only' and
//     the card showed nothing for an undeclared profile in either mode;
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

const MODES: McpMode[] = ['off', 'local', 'remote-only'];
const LEVELS: RowAccess[] = ['off', 'read', 'readwrite'];

describe('mcpModeLabel', () => {
  it('names each mode by who serves, not by the setting value', () => {
    expect(mcpModeLabel('off')).toBe('Nobody (off)');
    expect(mcpModeLabel('local')).toBe('This app (local)');
    expect(mcpModeLabel('remote-only')).toBe('Remote servers only');
  });

  it('gives the three modes three different labels', () => {
    expect(new Set(MODES.map(mcpModeLabel)).size).toBe(3);
  });

  it('never shows the raw setting value', () => {
    // 'remote-only' as a label is the setting's identifier leaking into the UI;
    // it also reads as a restriction on the app rather than a statement about
    // who serves.
    for (const mode of MODES) expect(mcpModeLabel(mode)).not.toBe(mode);
  });
});

describe('servingNote', () => {
  it('says nothing extra under local - the card reports the app own MCP row', () => {
    expect(servingNote('local', false)).toBeNull();
    expect(servingNote('local', true)).toBeNull();
  });

  it('reports a declaration as a declaration, not as a verified fact', () => {
    const note = servingNote('remote-only', true);
    expect(note?.text).toBe(REMOTE_DECLARED);
    expect(note?.text).toContain('declared');
  });

  it('distinguishes remote-only from off in both declaration states', () => {
    // The whole point: without this, both modes render the same card and an
    // operator cannot tell which one is in force from the profile alone.
    for (const declared of [false, true]) {
      expect(servingNote('remote-only', declared)).not.toBeNull();
      expect(servingNote('off', declared)).toBeNull();
    }
    expect(servingNote('remote-only', false)?.text).toBe('no serving server declared');
  });

  it('says nothing at all under off, declaration or not', () => {
    // The header reads "Nobody (off)". A card answering "served remotely"
    // underneath it would contradict the header on the same screen, so under
    // 'off' the app makes no MCP claim at all.
    expect(servingNote('off', true)).toBeNull();
    expect(servingNote('off', false)).toBeNull();
  });

  it('never claims the app checked anything', () => {
    for (const mode of MODES) {
      for (const declared of [false, true]) {
        const text = servingNote(mode, declared)?.text ?? '';
        expect(text).not.toMatch(/reachable|verified|responding|online|confirmed/i);
      }
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
    // something this app does not decide.
    expect(rowAccessNote('read')).toContain('your database decides');
    expect(rowAccessNote('readwrite')).toContain('your database decides');
  });

  it('gives every level its own text', () => {
    expect(new Set(LEVELS.map(rowAccessNote)).size).toBe(3);
  });
});
