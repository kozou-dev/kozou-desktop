import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('backs up a corrupt profiles.json before starting empty', () => {
    const { store, dir } = freshStore();
    store.upsert({ name: 'keep', url: 'postgresql://u:pw@h:5432/db', schemas: ['public'] });
    const file = join(dir, 'profiles.json');
    const original = 'not json {';
    writeFileSync(file, original);
    expect(store.list()).toEqual([]);
    expect(existsSync(`${file}.corrupt`)).toBe(true);
    expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe(original);
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

  it('rejects zero, negative, NaN, and fractional timeouts', () => {
    for (const timeoutMs of [0, -5, Number.NaN, 1.5]) {
      expect(() => validateProfileInput({ ...base, timeoutMs })).toThrow(/positive integer/);
    }
    expect(validateProfileInput({ ...base, timeoutMs: 30_000 }).timeoutMs).toBe(30_000);
  });

  it('drops empty/non-string label and color instead of persisting junk', () => {
    const out = validateProfileInput({ ...base, label: '', color: 7 });
    expect(out.label).toBeUndefined();
    expect(out.color).toBeUndefined();
  });
});
