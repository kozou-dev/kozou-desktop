import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProfileStore, type Encryptor } from '../src/main/profileStore.js';

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
});
