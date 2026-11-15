import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KEYCHAIN_UNAVAILABLE_MESSAGE, ProfileStore } from '../src/main/profileStore.js';
import { createSafeStorageEncryptor, type SafeStorageLike } from '../src/main/safeStorageEncryptor.js';

type FakeOptions = {
  available?: boolean;
  backend?: string;
  /** The tag Chromium would prefix: which key encrypted the text. */
  tag?: string;
  encryptFails?: boolean;
  shouldReEncrypt?: boolean;
};

type FakeSafeStorage = SafeStorageLike & { backendCalls: number; encryptCalls: number; syncCalls: number };

/** Every fake a test made, checked after that test. */
const fakes: FakeSafeStorage[] = [];

afterEach(() => {
  // A call to a synchronous method fails the test that made it even when the
  // adapter catches what the method throws.
  for (const fake of fakes.splice(0)) expect(fake.syncCalls).toBe(0);
});

/** A stand-in for Electron's safeStorage. The ciphertext is the tag followed
 *  by the reversed plaintext — enough to tell whether the adapter passes the
 *  bytes through untouched. The synchronous methods Electron 46 removes are
 *  present; they throw and count their calls, and afterEach requires none. */
function fakeSafeStorage(options: FakeOptions = {}): FakeSafeStorage {
  const tag = options.tag ?? 'v11';
  const removed = (): never => {
    fake.syncCalls += 1;
    throw new Error('synchronous safeStorage API called (removed in Electron 46)');
  };
  const fake = {
    backendCalls: 0,
    encryptCalls: 0,
    syncCalls: 0,
    isAsyncEncryptionAvailable: async () => options.available ?? true,
    encryptStringAsync: async (plainText: string) => {
      fake.encryptCalls += 1;
      if (options.encryptFails) {
        throw new Error('Error while encrypting the text provided to safeStorage.encryptStringAsync.');
      }
      return Buffer.from(tag + [...plainText].reverse().join(''), 'latin1');
    },
    decryptStringAsync: async (encrypted: Buffer) => ({
      result: [...encrypted.subarray(3).toString('latin1')].reverse().join(''),
      shouldReEncrypt: options.shouldReEncrypt ?? false,
    }),
    getSelectedStorageBackend: () => {
      fake.backendCalls += 1;
      return options.backend ?? 'gnome_libsecret';
    },
    isEncryptionAvailable: removed,
    encryptString: removed,
    decryptString: removed,
  };
  fakes.push(fake);
  return fake;
}

describe('createSafeStorageEncryptor', () => {
  it('is available when the async encryptor is and, on Linux, a keyring backend was selected', async () => {
    expect(await createSafeStorageEncryptor(fakeSafeStorage(), 'linux').available()).toBe(true);
    expect(await createSafeStorageEncryptor(fakeSafeStorage(), 'darwin').available()).toBe(true);
    expect(await createSafeStorageEncryptor(fakeSafeStorage({ available: false }), 'darwin').available()).toBe(
      false,
    );
    expect(await createSafeStorageEncryptor(fakeSafeStorage({ available: false }), 'linux').available()).toBe(false);
  });

  it('refuses the basic_text backend on Linux only', async () => {
    const linux = fakeSafeStorage({ backend: 'basic_text' });
    expect(await createSafeStorageEncryptor(linux, 'linux').available()).toBe(false);
    // Electron defines getSelectedStorageBackend on Linux only: elsewhere it
    // must not be called at all.
    for (const platform of ['darwin', 'win32'] as const) {
      const other = fakeSafeStorage({ backend: 'basic_text' });
      expect(await createSafeStorageEncryptor(other, platform).available()).toBe(true);
      expect(other.backendCalls).toBe(0);
    }
  });

  it('round-trips through base64 without touching the ciphertext', async () => {
    const encryptor = createSafeStorageEncryptor(fakeSafeStorage(), 'linux');
    const blob = await encryptor.encrypt('s3cr3t');
    expect(Buffer.from(blob, 'base64').toString('latin1')).toBe('v11t3rc3s');
    expect(await encryptor.decrypt(blob)).toBe('s3cr3t');
  });

  it('refuses ciphertext made with the hardcoded key on Linux, whatever the backend name says', async () => {
    // The backend reads as a keyring, but Chromium fell back to its built-in
    // key: only the tag shows it.
    const linux = createSafeStorageEncryptor(fakeSafeStorage({ tag: 'v10', backend: 'gnome_libsecret' }), 'linux');
    expect(await linux.available()).toBe(true);
    await expect(linux.encrypt('s3cr3t')).rejects.toThrow(KEYCHAIN_UNAVAILABLE_MESSAGE);
  });

  it('accepts v10 on macOS and Windows, where it is the Keychain or DPAPI key', async () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const encryptor = createSafeStorageEncryptor(fakeSafeStorage({ tag: 'v10' }), platform);
      expect(await encryptor.decrypt(await encryptor.encrypt('s3cr3t'))).toBe('s3cr3t');
    }
  });

  it('reports a failed encryption as the keychain being unavailable', async () => {
    const encryptor = createSafeStorageEncryptor(fakeSafeStorage({ encryptFails: true }), 'darwin');
    await expect(encryptor.encrypt('s3cr3t')).rejects.toThrow(KEYCHAIN_UNAVAILABLE_MESSAGE);
  });

  it('returns the plaintext when Chromium asks for a re-encryption, and does not re-encrypt', async () => {
    const fake = fakeSafeStorage({ shouldReEncrypt: true });
    const encryptor = createSafeStorageEncryptor(fake, 'darwin');
    expect(await encryptor.decrypt(Buffer.from('v10t3rc3s', 'latin1').toString('base64'))).toBe('s3cr3t');
    expect(fake.encryptCalls).toBe(0);
  });

  it('carries a password through the profile store end to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kozou-desktop-safestorage-test-'));
    const store = new ProfileStore(dir, createSafeStorageEncryptor(fakeSafeStorage(), 'darwin'));
    await store.upsert({ name: 'a', url: 'postgresql://app:s3cr3t@h:5432/db', schemas: ['public'] });
    expect((await store.connectionUrl('a')).url).toBe('postgresql://app:s3cr3t@h:5432/db');
  });

  it('makes the profile store refuse a password on Linux with the hardcoded key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kozou-desktop-safestorage-test-'));
    const store = new ProfileStore(dir, createSafeStorageEncryptor(fakeSafeStorage({ tag: 'v10' }), 'linux'));
    await expect(
      store.upsert({ name: 'a', url: 'postgresql://app:s3cr3t@h:5432/db', schemas: ['public'] }),
    ).rejects.toThrow(/encryption is unavailable/);
    expect(store.list()).toEqual([]);
  });
});
