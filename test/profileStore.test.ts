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

  it('reassigns to the next free port and keeps the capability path', () => {
    const { store } = freshStore();
    store.upsert({ name: 'a', ...base });
    store.upsert({ name: 'b', ...base });
    const a = store.ensureLocalMcpAllocation('a');
    store.ensureLocalMcpAllocation('b'); // occupies 3336
    const moved = store.reassignLocalMcpPort('a');
    expect(moved.port).toBe(3337);
    expect(moved.path).toBe(a.path);
    expect(store.ensureLocalMcpAllocation('a').port).toBe(3337);
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
