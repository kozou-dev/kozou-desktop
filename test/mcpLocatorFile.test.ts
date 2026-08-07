// The writing side of the locator: permissions, atomicity, and the rule that
// a stop only withdraws its own publication.

import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileMcpLocatorWriter } from '../src/main/mcpLocatorFile.js';
import { locatorFileName, parseLocator } from '../src/shared/mcpLocator.js';

const ID = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const ENTRY = { id: ID, port: 3335, path: '/mcp-0123456789abcdef0123456789abcdef' };

function writerIn(): { dir: string; writer: FileMcpLocatorWriter } {
  const dir = join(mkdtempSync(join(tmpdir(), 'kozou-desktop-locator-')), 'mcp-locators');
  return { dir, writer: new FileMcpLocatorWriter(dir) };
}

describe('FileMcpLocatorWriter', () => {
  it('publishes a parseable locator readable only by this user', () => {
    const { dir, writer } = writerIn();
    const generation = writer.write(ENTRY);
    const file = join(dir, locatorFileName(ID));
    const locator = parseLocator(readFileSync(file, 'utf8'), ID);
    expect(locator).toEqual({ v: 1, ...ENTRY, generation });
    // 0600: the capability path in here is the secret the whole locator
    // scheme exists to keep out of other applications' config files.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('leaves no temporary file behind, so the directory is never half a record', () => {
    const { dir, writer } = writerIn();
    writer.write(ENTRY);
    writer.write(ENTRY);
    expect(readdirSync(dir)).toEqual([locatorFileName(ID)]);
  });

  it('withdraws only its own generation', () => {
    const { dir, writer } = writerIn();
    const first = writer.write(ENTRY);
    const second = writer.write(ENTRY); // a restart republished it
    expect(second).not.toBe(first);

    // The older stop must not delete what the newer start published.
    writer.remove(ID, first);
    expect(readdirSync(dir)).toEqual([locatorFileName(ID)]);

    writer.remove(ID, second);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes a locator it cannot parse rather than leaving a false claim', () => {
    const { dir, writer } = writerIn();
    writer.write(ENTRY);
    writeFileSync(join(dir, locatorFileName(ID)), 'not json');
    writer.remove(ID, 'whatever');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('tolerates removing what is not there', () => {
    const { writer } = writerIn();
    expect(() => writer.remove(OTHER, 'gen')).not.toThrow();
  });

  it('sweeps every locator at launch and tolerates a missing directory', () => {
    const { dir, writer } = writerIn();
    writer.write(ENTRY);
    writer.write({ ...ENTRY, id: OTHER });
    writeFileSync(join(dir, `${OTHER}.json.tmp`), '{}'); // an interrupted write
    writer.clearAll();
    expect(readdirSync(dir)).toEqual([]);

    const fresh = new FileMcpLocatorWriter(join(dir, 'nope'));
    expect(() => fresh.clearAll()).not.toThrow();
  });
});
