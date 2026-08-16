import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProfileStore, validateProfileInput, type Encryptor } from '../src/main/profileStore.js';

const fakeEncryptor: Encryptor = {
  available: () => true,
  encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`,
  decrypt: (b) => Buffer.from(b.slice(4), 'base64').toString(),
};

const unavailableEncryptor: Encryptor = {
  available: () => false,
  encrypt: () => {
    throw new Error('unavailable');
  },
  decrypt: () => {
    throw new Error('unavailable');
  },
};

function freshStore(encryptor: Encryptor = fakeEncryptor): { store: ProfileStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kozou-desktop-test-'));
  return { store: new ProfileStore(dir, encryptor), dir };
}

describe('ProfileStore', () => {
  it('stores no plaintext password on disk and round-trips the connection URL', () => {
    const { store, dir } = freshStore();
    store.upsert({
      name: 'demo',
      url: 'postgresql://app:s3cr3t@localhost:5432/db',
      schemas: ['public'],
    });
    const onDisk = readFileSync(join(dir, 'profiles.json'), 'utf8');
    expect(onDisk).not.toContain('s3cr3t');
    const view = store.list()[0]!;
    expect(view.url).not.toContain('s3cr3t');
    expect(view.hasPassword).toBe(true);
    expect(store.connectionUrl('demo').url).toBe('postgresql://app:s3cr3t@localhost:5432/db');
  });

  it('upserts by name and deletes', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/one', schemas: ['public'] });
    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/two', schemas: ['public', 'sales'] });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.url).toContain('/two');
    expect(store.list()[0]!.schemas).toEqual(['public', 'sales']);
    store.remove('a');
    expect(store.list()).toHaveLength(0);
  });

  it('refuses to store a password when OS encryption is unavailable', () => {
    const { store } = freshStore(unavailableEncryptor);
    expect(() =>
      store.upsert({ name: 'x', url: 'postgresql://u:pw@h:5432/db', schemas: ['public'] }),
    ).toThrow(/encryption is unavailable/);
    // A password-less profile is still fine.
    store.upsert({ name: 'x', url: 'postgresql://u@h:5432/db', schemas: ['public'] });
    expect(store.list()).toHaveLength(1);
  });

  it('validates profile names and schemas', () => {
    const { store } = freshStore();
    expect(() => store.upsert({ name: 'bad name!', url: 'postgresql://u@h/db', schemas: ['public'] })).toThrow(
      /profile name/,
    );
    expect(() => store.upsert({ name: 'ok', url: 'postgresql://u@h/db', schemas: [] })).toThrow(/schema/);
  });

  it('throws a clear error for an unknown profile', () => {
    const { store } = freshStore();
    expect(() => store.connectionUrl('nope')).toThrow(/unknown profile/);
  });

  it('backs up a corrupt profiles.json (timestamped) before starting empty', () => {
    const { store, dir } = freshStore();
    store.upsert({ name: 'keep', url: 'postgresql://u:pw@h:5432/db', schemas: ['public'] });
    const file = join(dir, 'profiles.json');
    const original = 'not json {';
    writeFileSync(file, original);
    expect(store.list()).toEqual([]);
    const backups = readdirSync(dir).filter((f) => f.startsWith('profiles.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe(original);
  });
});

describe('ProfileStore local MCP fields', () => {
  const base = { url: 'postgresql://u@h:5432/db', schemas: ['public'] };

  it('defaults mcpMode to off, persists an explicit set, and rejects junk', () => {
    const { store, dir } = freshStore();
    expect(store.mcpMode()).toBe('off');
    expect(store.setMcpMode('local')).toBe('local');
    expect(store.mcpMode()).toBe('local');
    expect(JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8')).mcpMode).toBe('local');
    expect(() => store.setMcpMode('on')).toThrow(/mcpMode/);
    expect(() => store.setMcpMode(true)).toThrow(/mcpMode/);
    // The retired third mode is no longer settable — it permitted nothing and
    // started nothing, so there is nothing for a caller to ask for.
    expect(() => store.setMcpMode('remote-only')).toThrow(/mcpMode/);
  });

  it('degrades junk on-disk mcpMode to off instead of propagating it', () => {
    const { store, dir } = freshStore();
    store.upsert({ name: 'a', ...base });
    const file = join(dir, 'profiles.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.mcpMode = 'evil';
    writeFileSync(file, JSON.stringify(data));
    expect(store.mcpMode()).toBe('off');
  });

  it("reads an earlier build's remote-only as off and leaves it on disk", () => {
    // The mode permitted no start, so reading it as 'off' preserves the
    // behaviour the file already had. A read must not migrate the file: the
    // format stays at version 1, and an older build reading it back would
    // otherwise find its own value gone.
    const { store, dir } = freshStore();
    store.upsert({ name: 'a', ...base });
    const file = join(dir, 'profiles.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.mcpMode = 'remote-only';
    writeFileSync(file, JSON.stringify(data));
    expect(store.mcpMode()).toBe('off');
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpMode).toBe('remote-only');
  });

  it('allocates sticky ports from 3335 and unique capability paths', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', ...base });
    store.upsert({ name: 'b', ...base });
    const a = store.ensureLocalMcpAllocation('a');
    const b = store.ensureLocalMcpAllocation('b');
    expect(a.port).toBe(3335);
    expect(b.port).toBe(3336);
    expect(a.path).toMatch(/^\/mcp-[0-9a-f]{32}$/);
    expect(b.path).toMatch(/^\/mcp-[0-9a-f]{32}$/);
    expect(a.path).not.toBe(b.path);
    expect(a.autoStart).toBe(false);
    // Sticky: a second ensure returns the same allocation.
    expect(store.ensureLocalMcpAllocation('a')).toEqual(a);
  });

  it('reassigns to the next free port, rotates the capability path, and keeps the bridge id', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', ...base });
    store.upsert({ name: 'b', ...base });
    const a = store.ensureLocalMcpAllocation('a');
    store.setLocalMcpAutoStart('a', true);
    store.ensureLocalMcpAllocation('b'); // occupies 3336
    const moved = store.reassignLocalMcpPort('a');
    expect(moved.port).toBe(3337);
    // The port move has already invalidated a pasted URL, so the path moves
    // with it: whatever held the old port learns nothing that finds the new one.
    expect(moved.path).not.toBe(a.path);
    expect(moved.path).toMatch(/^\/mcp-[0-9a-f]{32}$/);
    // The bridge entry names only this, and resolves port and path at run time.
    expect(moved.bridgeId).toBe(a.bridgeId);
    expect(moved.autoStart).toBe(true);
    const after = store.ensureLocalMcpAllocation('a');
    expect(after.port).toBe(3337);
    expect(after.path).toBe(moved.path);
  });

  it('round-trips autoStart via explicit set', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', ...base });
    store.ensureLocalMcpAllocation('a');
    expect(store.setLocalMcpAutoStart('a', true)?.autoStart).toBe(true);
    expect(store.list()[0]!.localMcp?.autoStart).toBe(true);
    expect(store.setLocalMcpAutoStart('a', false)?.autoStart).toBe(false);
  });

  it('treats stopping a never-allocated profile as a no-op (no port burned)', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', ...base });
    expect(store.setLocalMcpAutoStart('a', false)).toBeUndefined();
    expect(store.list()[0]!.localMcp).toBeUndefined();
    // An explicit start intent does allocate.
    expect(store.setLocalMcpAutoStart('a', true)?.port).toBe(3335);
  });

  it('degrades a shape-invalid on-disk localMcp to absent and self-heals', () => {
    const { store, dir } = freshStore();
    store.upsert({ name: 'a', ...base });
    const file = join(dir, 'profiles.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.profiles[0].localMcp = { port: '3335', path: 42 };
    writeFileSync(file, JSON.stringify(data));
    expect(store.list()[0]!.localMcp).toBeUndefined();
    // Junk does not reserve a port; the fresh allocation is valid.
    const healed = store.ensureLocalMcpAllocation('a');
    expect(healed.port).toBe(3335);
    expect(healed.path).toMatch(/^\/mcp-[0-9a-f]{32}$/);
  });

  it('never reuses a capability path when a freed port is recycled', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', ...base });
    const first = store.ensureLocalMcpAllocation('a');
    store.remove('a');
    store.upsert({ name: 'b', ...base });
    const second = store.ensureLocalMcpAllocation('b');
    // Same recycled port, but a fresh secret path — a stale pasted config
    // must never reach a different profile's server.
    expect(second.port).toBe(first.port);
    expect(second.path).not.toBe(first.path);
  });

  it('preserves main-owned localMcp and stored remoteMcp across renderer upserts that omit them', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', ...base });
    const alloc = store.ensureLocalMcpAllocation('a');
    store.upsert({ name: 'a', ...base, remoteMcp: { declared: true, url: 'https://mcp.example.com/mcp' } });
    // Edit without mcp fields (an older build's form would do the same).
    store.upsert({ name: 'a', ...base, label: 'renamed' });
    const view = store.list()[0]!;
    expect(view.localMcp).toEqual(alloc);
    expect(view.remoteMcp).toEqual({ declared: true, url: 'https://mcp.example.com/mcp' });
    // Explicit clear.
    store.upsert({ name: 'a', ...base, remoteMcp: { declared: false } });
    expect(store.list()[0]!.remoteMcp).toBeUndefined();
    expect(store.list()[0]!.localMcp).toEqual(alloc);
  });

  // The allocation is what an AI client's config points at, so it lives as long as
  // the DATABASE it was handed out for — a narrower rule than the row-access
  // grant's, because a preserved allocation only misleads when it makes a pasted
  // entry answer for another database under the same name.
  it('drops the local-MCP allocation when an edit repoints the profile at another database', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', ...base });
    const before = store.ensureLocalMcpAllocation('a');

    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/other', schemas: ['public'] });
    expect(store.list()[0]!.localMcp).toBeUndefined();

    // Both halves of a stale config have to stop resolving. A pasted URL 404s
    // because the capability path is new; a pasted bridge entry fails
    // explicitly because no locator answers for its id. The port may well be
    // handed out again — it is not what identifies the server.
    const after = store.ensureLocalMcpAllocation('a');
    expect(after.path).not.toBe(before.path);
    expect(after.bridgeId).not.toBe(before.bridgeId);
  });

  // The allocation is a destination, not an authorization, so it is anchored to
  // the database and nothing else. The grant is anchored to more, and these two
  // tests are the pair that says so.
  // A repoint is any of host, port or database — not just the database name, which
  // was the only one covered. A comparison on the pathname alone would pass that
  // one test while a prod-to-staging edit kept the port, path, bridge id and
  // autoStart of the database the config was pasted for.
  it('drops the allocation when the host or the port changes, not only the database name', () => {
    for (const repointed of [
      'postgresql://u@other-host:5432/db',
      'postgresql://u@h:5433/db',
      'postgresql://u@h:5432/other',
    ]) {
      const { store } = freshStore();
      store.upsert({ name: 'a', ...base });
      const before = store.ensureLocalMcpAllocation('a');
      store.upsert({ name: 'a', url: repointed, schemas: ['public'] });
      expect(store.list()[0]!.localMcp, repointed).toBeUndefined();
      const after = store.ensureLocalMcpAllocation('a');
      expect(after.path, repointed).not.toBe(before.path);
      expect(after.bridgeId, repointed).not.toBe(before.bridgeId);
    }
  });

  // The username is not part of `dbIdentityKey` on purpose (the same database
  // reached by two roles is one database), so a role change keeps the destination.
  // The grant is what re-asks, and it does.
  it('keeps the allocation across a role change, and still drops the grant', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', ...base });
    const alloc = store.ensureLocalMcpAllocation('a');
    store.setRowAccess('a', 'read');
    store.upsert({ name: 'a', url: 'postgresql://admin@h:5432/db', schemas: ['public'] });
    expect(store.list()[0]!.localMcp).toEqual(alloc);
    expect(store.list()[0]!.rowAccess).toBe('off');
  });

  // Spellings of one database. There is no edit form in this app, so a schema
  // change means retyping the URL, and every one of these is a plausible retype.
  it('keeps the allocation across spellings of the same database', () => {
    for (const same of [
      'postgresql://u@h/db',
      'postgres://u@h:5432/db',
      'postgresql://u:pw@h:5432/db',
    ]) {
      const { store } = freshStore();
      store.upsert({ name: 'a', ...base });
      const alloc = store.ensureLocalMcpAllocation('a');
      store.upsert({ name: 'a', url: same, schemas: ['public'] });
      expect(store.list()[0]!.localMcp, same).toEqual(alloc);
    }
  });

  // `dbIdentityKey` declines URLs whose query params can redirect the connection
  // (`?host=`, `?dbname=`, ...), and two declines are not evidence of sameness. The
  // normalized-string fallback is what keeps a byte-identical re-save of one of
  // those from reading as a repoint - which matters because main would not stop the
  // server for it, and a discarded allocation would leave its locator behind.
  it('falls back to the normalised URL for forms the identity key declines', () => {
    const declined = 'postgresql://u@h:5432/db?dbname=other';
    const { store } = freshStore();
    store.upsert({ name: 'a', url: declined, schemas: ['public'] });
    const alloc = store.ensureLocalMcpAllocation('a');

    // Same string back: kept.
    store.upsert({ name: 'a', url: declined, schemas: ['public'] });
    expect(store.list()[0]!.localMcp).toEqual(alloc);

    // A real edit to it: dropped, even though the key declines both sides.
    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/db?dbname=third', schemas: ['public'] });
    expect(store.list()[0]!.localMcp).toBeUndefined();
  });

  // autoStart is the field whose new survival is the point, and it is false in a
  // fresh allocation - so every other test here would pass with autoStart hard-wired
  // to false. These set it true first.
  it('carries autoStart through a narrowing schema edit and clears it on a widening one', () => {
    const wide = { name: 'a', url: base.url, schemas: ['public', 'sales'] };

    const narrowing = freshStore().store;
    narrowing.upsert(wide);
    narrowing.ensureLocalMcpAllocation('a');
    narrowing.setLocalMcpAutoStart('a', true);
    narrowing.upsert({ name: 'a', url: base.url, schemas: ['public'] });
    expect(narrowing.list()[0]!.localMcp?.autoStart).toBe(true);

    const widening = freshStore().store;
    widening.upsert({ name: 'a', ...base });
    const alloc = widening.ensureLocalMcpAllocation('a');
    widening.setLocalMcpAutoStart('a', true);
    widening.upsert(wide);
    const after = widening.list()[0]!.localMcp;
    // The destination survives - what you pasted still names this database - and
    // only the intent goes, so the wider set is served after a deliberate start.
    expect(after?.port).toBe(alloc.port);
    expect(after?.path).toBe(alloc.path);
    expect(after?.bridgeId).toBe(alloc.bridgeId);
    expect(after?.autoStart).toBe(false);
  });

  it('keeps the local-MCP allocation when the schema set changes, and still drops the grant', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', ...base });
    const alloc = store.ensureLocalMcpAllocation('a');
    store.setRowAccess('a', 'read');

    // Adding a schema does not repoint anything, and this app tells the operator
    // to do it (the detail pane's words for an out-of-schema relation are "Add
    // its schema to the profile to inspect it"). A pasted config surviving that
    // is the point: it names the same database, which is still the same database.
    store.upsert({ name: 'a', url: base.url, schemas: ['public', 'sales'] });
    expect(store.list()[0]!.localMcp).toEqual(alloc);
    // The grant is a different question: widened schemas reach rows the approval
    // dialog did not name.
    expect(store.list()[0]!.rowAccess).toBe('off');
  });

  // The hole the narrowing closed. A hand-edited profiles.json can carry a
  // password in `url` (this app never writes one there). Saving that URL back
  // unchanged looks identical to main - which compares the URL with the password
  // joined in, so it does not stop the server - while the store used to see the
  // credential state flip and throw the allocation away underneath it, leaving a
  // locator nothing would clean up until the next launch. Normalized and
  // database-only, both sides now agree that nothing moved.
  it('keeps the allocation when a hand-written password is normalised out of the stored URL', () => {
    const { store, dir } = freshStore();
    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/db', schemas: ['public'] });
    const alloc = store.ensureLocalMcpAllocation('a');

    // Put the password into the url field the way a hand edit would.
    const file = join(dir, 'profiles.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.profiles[0].url = 'postgresql://u:pw@h:5432/db';
    writeFileSync(file, JSON.stringify(data));
    expect(store.list()[0]!.localMcp).toEqual(alloc);

    // The same URL saved back: main sees no change, and neither does this.
    store.upsert({ name: 'a', url: 'postgresql://u:pw@h:5432/db', schemas: ['public'] });
    expect(store.list()[0]!.localMcp).toEqual(alloc);
  });

  it('keeps the local-MCP allocation across a password rotation and across a change of credential state', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', url: 'postgresql://u:old@h:5432/db', schemas: ['public'] });
    const alloc = store.ensureLocalMcpAllocation('a');
    store.setRowAccess('a', 'read');

    // Same server, same database, same role: a client's config still points
    // where it did, so invalidating it would cost the user a repaste for
    // nothing.
    store.upsert({ name: 'a', url: 'postgresql://u:new@h:5432/db', schemas: ['public'] });
    expect(store.list()[0]!.localMcp).toEqual(alloc);

    // Dropping the stored password changes which credentials the served database
    // is reached with, which is the grant's business and not the destination's.
    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/db', schemas: ['public'] });
    expect(store.list()[0]!.localMcp).toEqual(alloc);
    expect(store.list()[0]!.rowAccess).toBe('off');
  });

  it('validates remoteMcp input at the IPC boundary', () => {
    const { store } = freshStore();
    expect(() => store.upsert({ name: 'a', ...base, remoteMcp: 'yes' })).toThrow(/remoteMcp must be an object/);
    expect(() => store.upsert({ name: 'a', ...base, remoteMcp: { declared: 'yes' } })).toThrow(
      /declared must be a boolean/,
    );
    expect(() => store.upsert({ name: 'a', ...base, remoteMcp: { declared: true, url: '' } })).toThrow(
      /remoteMcp\.url/,
    );
    expect(() => store.upsert({ name: 'a', ...base, remoteMcp: { declared: true, url: 'not a url' } })).toThrow(
      /http\(s\) URL/,
    );
    expect(() =>
      store.upsert({ name: 'a', ...base, remoteMcp: { declared: true, url: 'javascript:alert(1)' } }),
    ).toThrow(/http\(s\) URL/);
    // profiles.json holds only non-secret fields — reject pasted userinfo
    // credentials instead of persisting them in plaintext.
    expect(() =>
      store.upsert({ name: 'a', ...base, remoteMcp: { declared: true, url: 'https://user:pw@host/mcp' } }),
    ).toThrow(/must not contain credentials/);
    store.upsert({ name: 'a', ...base, remoteMcp: { declared: true, url: 'https://host.example.com/mcp' } });
    expect(store.list()[0]!.remoteMcp?.url).toBe('https://host.example.com/mcp');
  });
});

describe('ProfileStore row access', () => {
  const base = { url: 'postgresql://u@h:5432/db', schemas: ['public'] };

  it('defaults to off and writes no rowAccess key until one is granted', () => {
    const { store, dir } = freshStore();
    store.upsert({ name: 'a', ...base });
    expect(store.list()[0]!.rowAccess).toBe('off');
    expect(store.rowAccess('a')).toBe('off');
    const stored = JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8'));
    expect(stored.profiles[0]).not.toHaveProperty('rowAccess');
    expect(stored.version).toBe(1);
  });

  it('persists an explicit grant, revokes back to absent, and rejects junk levels', () => {
    const { store, dir } = freshStore();
    store.upsert({ name: 'a', ...base });
    expect(store.setRowAccess('a', 'read')).toBe('read');
    expect(store.rowAccess('a')).toBe('read');
    expect(store.setRowAccess('a', 'readwrite')).toBe('readwrite');
    expect(store.list()[0]!.rowAccess).toBe('readwrite');
    const file = join(dir, 'profiles.json');
    expect(JSON.parse(readFileSync(file, 'utf8')).profiles[0].rowAccess).toBe('readwrite');
    // Revoking clears the key rather than storing an explicit 'off' — the
    // fail-closed state stays the absent one.
    expect(store.setRowAccess('a', 'off')).toBe('off');
    expect(JSON.parse(readFileSync(file, 'utf8')).profiles[0]).not.toHaveProperty('rowAccess');
    // The store file never leaves version 1 (older builds share userData).
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
    for (const junk of ['write', 'ON', true, 1, null]) {
      expect(() => store.setRowAccess('a', junk)).toThrow(/rowAccess must be/);
    }
    expect(() => store.rowAccess('nope')).toThrow(/unknown profile/);
    expect(() => store.setRowAccess('nope', 'read')).toThrow(/unknown profile/);
  });

  it('ignores rowAccess smuggled into a profile upsert', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', ...base, rowAccess: 'readwrite' });
    expect(store.rowAccess('a')).toBe('off');
    // Nor can a form save escalate an existing grant.
    store.setRowAccess('a', 'read');
    store.upsert({ name: 'a', ...base, rowAccess: 'readwrite' });
    expect(store.rowAccess('a')).toBe('read');
  });

  it('preserves a granted rowAccess across renderer upserts that omit it', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', ...base });
    store.setRowAccess('a', 'readwrite');
    // A plain form edit must not silently revoke the grant the user approved:
    // losing row access on every label edit would be poor behaviour.
    store.upsert({ name: 'a', ...base, label: 'renamed', color: '#123456', timeoutMs: 4_000 });
    expect(store.list()[0]!.rowAccess).toBe('readwrite');
  });

  // The approval dialog names a DATABASE, so the grant lives exactly as long as
  // the facts it named do. These four pin both directions of that rule.
  it('drops a grant when an edit repoints the profile at another database', () => {
    const { store, dir } = freshStore();
    store.upsert({ name: 'a', ...base });
    store.setRowAccess('a', 'readwrite');
    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/other', schemas: ['public'] });

    expect(store.rowAccess('a')).toBe('off');
    expect(store.list()[0]!.rowAccess).toBe('off');
    // Absent, not an explicit 'off' — the fail-closed state stays the shape an
    // older build writes back.
    const raw = JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8'));
    expect(raw.profiles[0]).not.toHaveProperty('rowAccess');
  });

  it('drops a grant when the schema set changes', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', ...base });
    store.setRowAccess('a', 'read');
    store.upsert({ name: 'a', url: base.url, schemas: ['public', 'sales'] });
    expect(store.rowAccess('a')).toBe('off');
  });

  it('keeps a grant across a password rotation but not across a change of credential state', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', url: 'postgresql://u:old@h:5432/db', schemas: ['public'] });
    store.setRowAccess('a', 'readwrite');

    // Same server, same database, same role: nothing the user approved changed.
    store.upsert({ name: 'a', url: 'postgresql://u:new@h:5432/db', schemas: ['public'] });
    expect(store.rowAccess('a')).toBe('readwrite');

    // Dropping the stored password changes which credentials the grant would be
    // exercised with, so it has to be approved again.
    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/db', schemas: ['public'] });
    expect(store.rowAccess('a')).toBe('off');
  });

  it('keeps a grant when the same schema set is merely reordered or repeated', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', url: base.url, schemas: ['public', 'sales'] });
    store.setRowAccess('a', 'readwrite');

    // Order does not decide which rows are reachable: a bare relation name is
    // registered only when it is unique across the introspected schemas, and
    // this app addresses relations by qualified name. Revoking here would cost
    // an approval for an edit that changed nothing.
    store.upsert({ name: 'a', url: base.url, schemas: ['sales', 'public'] });
    expect(store.rowAccess('a')).toBe('readwrite');
    store.upsert({ name: 'a', url: base.url, schemas: ['public', 'sales', 'public'] });
    expect(store.rowAccess('a')).toBe('readwrite');

    // Adding a schema is still a change of what the grant reaches.
    store.upsert({ name: 'a', url: base.url, schemas: ['public', 'sales', 'ops'] });
    expect(store.rowAccess('a')).toBe('off');
  });

  it('re-grants normally after a connection edit dropped the grant', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', ...base });
    store.setRowAccess('a', 'read');
    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/other', schemas: ['public'] });
    expect(store.rowAccess('a')).toBe('off');
    // The cost of the rule is one more approval, not a profile stuck at 'off'.
    store.setRowAccess('a', 'read');
    expect(store.rowAccess('a')).toBe('read');
  });

  it('degrades a junk on-disk rowAccess to off instead of propagating it', () => {
    const { store, dir } = freshStore();
    store.upsert({ name: 'a', ...base });
    const file = join(dir, 'profiles.json');
    for (const junk of ['all', 'write', true, 7, { level: 'readwrite' }]) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      data.profiles[0].rowAccess = junk;
      writeFileSync(file, JSON.stringify(data));
      expect(store.rowAccess('a')).toBe('off');
      expect(store.list()[0]!.rowAccess).toBe('off');
    }
    // Junk is not carried forward by an upsert either.
    store.upsert({ name: 'a', ...base });
    expect(JSON.parse(readFileSync(file, 'utf8')).profiles[0]).not.toHaveProperty('rowAccess');
  });

  it('stays readable by a build that predates rowAccess (additive, version 1)', () => {
    const { store, dir } = freshStore();
    store.upsert({ name: 'a', ...base });
    store.setRowAccess('a', 'readwrite');
    const file = join(dir, 'profiles.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    // An older build accepts the file (version 1 + profiles array) and maps
    // it with the fields it knows; rowAccess is simply an unknown key.
    expect(raw.version).toBe(1);
    expect(Array.isArray(raw.profiles)).toBe(true);
    expect(raw.profiles[0].name).toBe('a');
    // Reading it back here must not have been a one-way trip.
    expect(store.rowAccess('a')).toBe('readwrite');
  });
});

describe('validateProfileInput (untrusted IPC boundary)', () => {
  const base = { name: 'ok', url: 'postgresql://u@h/db', schemas: ['public'] };

  it('rejects non-string and array-coerced names', () => {
    expect(() => validateProfileInput({ ...base, name: ['ok'] })).toThrow(/name must be a string/);
    expect(() => validateProfileInput({ ...base, name: 42 })).toThrow(/name must be a string/);
  });

  it('rejects a string where the schemas array is expected', () => {
    expect(() => validateProfileInput({ ...base, schemas: 'public' })).toThrow(/schemas must be/);
    expect(() => validateProfileInput({ ...base, schemas: ['public', 7] })).toThrow(/schemas must be/);
    expect(() => validateProfileInput({ ...base, schemas: [''] })).toThrow(/schemas must be/);
  });

  it('rejects zero, negative, NaN, fractional, and oversized timeouts', () => {
    for (const timeoutMs of [0, -5, Number.NaN, 1.5, 300_001]) {
      expect(() => validateProfileInput({ ...base, timeoutMs })).toThrow(/positive integer/);
    }
    expect(validateProfileInput({ ...base, timeoutMs: 30_000 }).timeoutMs).toBe(30_000);
    expect(validateProfileInput({ ...base, timeoutMs: 300_000 }).timeoutMs).toBe(300_000);
  });

  it('drops empty/non-string label and color instead of persisting junk', () => {
    const out = validateProfileInput({ ...base, label: '', color: 7 });
    expect(out.label).toBeUndefined();
    expect(out.color).toBeUndefined();
  });
});
