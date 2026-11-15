// The profile store's Encryptor, backed by Electron safeStorage.
//
// Only the asynchronous methods are used: isEncryptionAvailable,
// encryptString and decryptString are deprecated in Electron 45 and removed
// in 46. The asynchronous methods read the same per-platform key stores and
// produce the same ciphertext format, so a password an earlier build stored
// with the synchronous methods decrypts here unchanged.
//
// safeStorage is passed in structurally so the refusal rules below are
// unit-testable without Electron.

import { KEYCHAIN_UNAVAILABLE_MESSAGE, type Encryptor } from './profileStore.js';

/** The slice of Electron's safeStorage this adapter uses. */
export type SafeStorageLike = {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  /** Linux only — Electron does not define it on other platforms. */
  getSelectedStorageBackend(): string;
};

/** On Linux, Chromium prefixes ciphertext with the tag of the key that made
 *  it: "v11" for a key held by the keyring (Secret Service or KWallet), "v10"
 *  for the fallback key that is hardcoded into Chromium — obfuscation, not
 *  encryption. (On macOS and Windows "v10" is the Keychain or DPAPI key, so
 *  the tag means something else there.) */
const LINUX_HARDCODED_KEY_TAG = 'v10';

export function createSafeStorageEncryptor(
  safeStorage: SafeStorageLike,
  platform: NodeJS.Platform,
): Encryptor {
  return {
    async available() {
      // This resolves true once the encryptor has initialized, whatever key it
      // ended up with, so it cannot be the whole check.
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
      // basic_text is Electron reporting that it chose no keyring — for
      // instance because --password-store=basic asked it to (anyone can pass
      // that), or because the desktop environment is one it does not pair
      // with a keyring (LXQt, KDE3, or one it does not recognize). That is refused even where the
      // asynchronous encryptor would still have reached a keyring, which errs
      // toward not storing the password.
      if (platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    },

    async encrypt(plaintext) {
      let ciphertext: Buffer;
      try {
        ciphertext = await safeStorage.encryptStringAsync(plaintext);
      } catch {
        // After app ready, Chromium fails to encrypt only when it holds no key
        // to encrypt with — on macOS, for instance, when Keychain access was
        // denied.
        throw new Error(KEYCHAIN_UNAVAILABLE_MESSAGE);
      }
      // The backend name above is what Electron selected, not proof of which
      // key was used: when the keyring cannot be reached, Chromium encrypts
      // with the hardcoded key without saying so. The tag records what
      // actually happened.
      if (platform === 'linux' && ciphertext.subarray(0, 3).toString('latin1') === LINUX_HARDCODED_KEY_TAG) {
        throw new Error(KEYCHAIN_UNAVAILABLE_MESSAGE);
      }
      return ciphertext.toString('base64');
    },

    async decrypt(blob) {
      // shouldReEncrypt (the blob was made with a key that is no longer the
      // one Chromium encrypts with) is not acted on: decrypting is a read, and
      // a read never rewrites profiles.json. Saving the profile with its
      // password encrypts it afresh.
      const { result } = await safeStorage.decryptStringAsync(Buffer.from(blob, 'base64'));
      return result;
    },
  };
}
