// The locator record and the one path the bridge derives from it.
//
// BR-2's structural leg lives here: a locator carries four facts, and the
// parser rejects a file carrying anything else. The credential-field cases
// are not decoration — the whole reason this file format exists is that the
// alternative (reading profiles.json) would put an encrypted password blob in
// the bridge's memory.

import { describe, expect, it } from 'vitest';
import { locatorPathFor, readLocator, resolveUserDataDir } from '../src/bridge/locator.js';
import { LOCATOR_DIR_NAME, locatorFileName, parseLocator, serializeLocator } from '../src/shared/mcpLocator.js';

const ID = '0123456789abcdef0123456789abcdef';
const OTHER_ID = 'fedcba9876543210fedcba9876543210';
const VALID = { v: 1, id: ID, port: 3335, path: '/mcp-0123456789abcdef0123456789abcdef', generation: '0011223344556677' } as const;

describe('locator record', () => {
  it('round-trips', () => {
    expect(parseLocator(serializeLocator({ ...VALID }), ID)).toEqual(VALID);
  });

  it('writes only the four facts, whatever the caller passes', () => {
    const text = serializeLocator({ ...VALID, url: 'postgresql://u:pw@h/db' } as never);
    expect(text).not.toContain('postgresql');
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['generation', 'id', 'path', 'port', 'v']);
  });

  it('rejects a locator carrying any field it does not know', () => {
    for (const extra of ['url', 'password', 'encryptedPassword', 'schemas', 'host']) {
      const text = JSON.stringify({ ...VALID, [extra]: 'x' });
      expect(() => parseLocator(text, ID)).toThrow(/unexpected field/);
    }
  });

  it('rejects a locator belonging to another server', () => {
    expect(() => parseLocator(JSON.stringify({ ...VALID, id: OTHER_ID }), ID)).toThrow(/different server/);
  });

  it('rejects malformed records rather than guessing', () => {
    const cases: Array<[string, unknown]> = [
      ['version', { ...VALID, v: 2 }],
      ['port type', { ...VALID, port: '3335' }],
      ['port range', { ...VALID, port: 0 }],
      ['path shape', { ...VALID, path: '/etc/passwd' }],
      ['path traversal', { ...VALID, path: '/mcp-a/../../x' }],
      ['path query', { ...VALID, path: '/mcp-a?x=1' }],
      ['generation', { ...VALID, generation: 'nope' }],
      ['array', [VALID]],
    ];
    for (const [label, value] of cases) {
      expect(() => parseLocator(JSON.stringify(value), ID), label).toThrow();
    }
    expect(() => parseLocator('{', ID)).toThrow(/valid JSON/);
  });

  it('refuses to name a file for anything but a bridge id', () => {
    for (const bad of ['', 'x', '../profiles', `${ID}/..`, ID.toUpperCase()]) {
      expect(() => locatorFileName(bad)).toThrow(/32 lowercase hex/);
    }
    expect(locatorFileName(ID)).toBe(`${ID}.json`);
  });
});

describe('locator path resolution', () => {
  it('is a constant directory plus a checked id — no argument reaches the profile store', () => {
    expect(locatorPathFor(ID, '/data')).toBe(`/data/${LOCATOR_DIR_NAME}/${ID}.json`);
    for (const bad of ['../store/profiles', '/etc/passwd', `${ID}.json`]) {
      expect(() => locatorPathFor(bad, '/data')).toThrow(/32 lowercase hex/);
    }
  });

  it('follows the app data directory per platform, and the dev override wins', () => {
    expect(resolveUserDataDir({}, 'darwin', '/Users/x')).toBe('/Users/x/Library/Application Support/kozou-desktop');
    expect(resolveUserDataDir({ KOZOU_DESKTOP_USER_DATA: '/tmp/ud' }, 'darwin', '/Users/x')).toBe('/tmp/ud');
    expect(resolveUserDataDir({}, 'linux', '/home/x')).toBe('/home/x/.config/kozou-desktop');
  });

  it('reads exactly one path, and says so when there is nothing to read', () => {
    const asked: string[] = [];
    const missing = (path: string): string => {
      asked.push(path);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    expect(() => readLocator(ID, missing, '/data')).toThrow(/no local MCP server is published/);
    expect(asked).toEqual([`/data/${LOCATOR_DIR_NAME}/${ID}.json`]);
  });
});
