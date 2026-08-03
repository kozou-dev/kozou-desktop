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

  it('distinguishes remote-only from off for a profile with no declaration', () => {
    // The whole point: without this, both modes render a blank card row and an
    // operator cannot tell which one is in force from the profile alone.
    const remoteOnly = servingNote('remote-only', false);
    const off = servingNote('off', false);
    expect(remoteOnly).not.toBeNull();
    expect(remoteOnly?.text).toBe('no serving server declared');
    expect(off).toBeNull();
    expect(remoteOnly?.text).not.toBe(off?.text);
  });

  it('shows the same declaration text in both non-local modes', () => {
    expect(servingNote('off', true)?.text).toBe(servingNote('remote-only', true)?.text);
  });
});

describe('rowAccessNote', () => {
  it('states the second approval while still off, not only after granting', () => {
    const off = rowAccessNote('off');
    expect(off).toContain('approval');
    expect(off).toContain('second');
  });

  it('says where rows appear once a grant is in force', () => {
    expect(rowAccessNote('read')).toContain('Data tab');
    expect(rowAccessNote('readwrite')).toContain('Data tab');
  });

  it('still points at the second approval at the browsing level', () => {
    expect(rowAccessNote('read')).toContain('second');
  });

  it('says at the editing level that revoking is prompt-free', () => {
    // Revoking deliberately has no prompt, so the badge is the only warning a
    // grant is live; saying so is what makes "turn off" an obvious escape.
    expect(rowAccessNote('readwrite')).toContain('no approval');
  });

  it('gives every level its own text', () => {
    expect(new Set(LEVELS.map(rowAccessNote)).size).toBe(3);
  });
});
