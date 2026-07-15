// Profile persistence: a shell-local minimal store.
//
// profiles.json holds only non-secret fields plus an OS-keychain-encrypted
// password blob (Electron safeStorage) — never a plaintext password. The
// encryptor is injected so unit tests can run without Electron.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProfileInput, ProfileView } from '../shared/types.js';
import { joinDbUrl, splitDbUrl } from '../shared/url.js';

export type Encryptor = {
  available(): boolean;
  /** plaintext -> opaque printable blob */
  encrypt(plaintext: string): string;
  /** opaque printable blob -> plaintext */
  decrypt(blob: string): string;
};

type StoredProfile = {
  name: string;
  label?: string;
  color?: string;
  /** Password-free connection URL. */
  url: string;
  schemas: string[];
  timeoutMs?: number;
  /** Encrypted password blob (absent when the URL carried no password). */
  encryptedPassword?: string;
};

type StoreFile = { version: 1; profiles: StoredProfile[] };

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class ProfileStore {
  private readonly file: string;

  constructor(
    dir: string,
    private readonly encryptor: Encryptor,
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'profiles.json');
  }

  private read(): StoreFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StoreFile;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.profiles)) return parsed;
    } catch {
      // Missing or corrupt file — start empty. Corruption loses only
      // connection bookkeeping, never data.
    }
    return { version: 1, profiles: [] };
  }

  private write(data: StoreFile): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  list(): ProfileView[] {
    return this.read().profiles.map((p) => ({
      name: p.name,
      label: p.label,
      color: p.color,
      url: p.url,
      schemas: p.schemas,
      timeoutMs: p.timeoutMs,
      hasPassword: p.encryptedPassword !== undefined,
    }));
  }

  upsert(input: ProfileInput): ProfileView[] {
    if (!PROFILE_NAME_RE.test(input.name)) {
      throw new Error('profile name must be 1-64 chars: letters, digits, ".", "_", "-"');
    }
    if (input.schemas.length === 0) {
      throw new Error('at least one schema is required');
    }
    const { sansPassword, password } = splitDbUrl(input.url);
    let encryptedPassword: string | undefined;
    if (password !== null) {
      if (!this.encryptor.available()) {
        throw new Error(
          'OS keychain-backed encryption is unavailable; refusing to store a password. ' +
            'Store the profile without a password or run on a platform with safeStorage support.',
        );
      }
      encryptedPassword = this.encryptor.encrypt(password);
    }
    const next: StoredProfile = {
      name: input.name,
      ...(input.label ? { label: input.label } : {}),
      ...(input.color ? { color: input.color } : {}),
      url: sansPassword,
      schemas: input.schemas,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(encryptedPassword !== undefined ? { encryptedPassword } : {}),
    };
    const data = this.read();
    const i = data.profiles.findIndex((p) => p.name === input.name);
    if (i >= 0) data.profiles[i] = next;
    else data.profiles.push(next);
    this.write(data);
    return this.list();
  }

  remove(name: string): ProfileView[] {
    const data = this.read();
    data.profiles = data.profiles.filter((p) => p.name !== name);
    this.write(data);
    return this.list();
  }

  /** Rebuild the full connection URL (with password) for spawning a worker.
   *  Callers must keep it out of argv and logs. */
  connectionUrl(name: string): { url: string; schemas: string[]; timeoutMs?: number } {
    const p = this.read().profiles.find((x) => x.name === name);
    if (!p) throw new Error(`unknown profile "${name}"`);
    const password = p.encryptedPassword !== undefined ? this.encryptor.decrypt(p.encryptedPassword) : null;
    return { url: joinDbUrl(p.url, password), schemas: p.schemas, timeoutMs: p.timeoutMs };
  }
}
