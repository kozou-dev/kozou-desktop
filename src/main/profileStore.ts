// Profile persistence: a shell-local minimal store.
//
// profiles.json holds only non-secret fields plus an OS-keychain-encrypted
// password blob (Electron safeStorage) — never a plaintext password. The
// encryptor is injected so unit tests can run without Electron.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/** Upper bound for the per-statement introspection timeout (5 minutes). */
export const MAX_TIMEOUT_MS = 300_000;

/** Validate untrusted IPC input into a well-typed ProfileInput. All renderer
 *  input crosses this before touching the store (a compromised renderer must
 *  not be able to persist junk state). */
export function validateProfileInput(input: unknown): ProfileInput {
  if (typeof input !== 'object' || input === null) throw new Error('profile input must be an object');
  const p = input as Record<string, unknown>;
  if (typeof p.name !== 'string' || !PROFILE_NAME_RE.test(p.name)) {
    throw new Error('profile name must be a string of 1-64 chars: letters, digits, ".", "_", "-"');
  }
  if (typeof p.url !== 'string') throw new Error('connection URL must be a string');
  if (
    !Array.isArray(p.schemas) ||
    p.schemas.length === 0 ||
    !p.schemas.every((s): s is string => typeof s === 'string' && s.length > 0)
  ) {
    throw new Error('schemas must be a non-empty array of non-empty strings');
  }
  if (
    p.timeoutMs !== undefined &&
    (!Number.isInteger(p.timeoutMs) || (p.timeoutMs as number) <= 0 || (p.timeoutMs as number) > MAX_TIMEOUT_MS)
  ) {
    // 0 would mean "no statement timeout" in PostgreSQL — never allow that
    // here; and an unbounded value would stretch the worker hang guard
    // (per-statement budget x statement count) into hours.
    throw new Error(`timeoutMs must be a positive integer <= ${MAX_TIMEOUT_MS}`);
  }
  return {
    name: p.name,
    ...(typeof p.label === 'string' && p.label !== '' ? { label: p.label } : {}),
    ...(typeof p.color === 'string' && p.color !== '' ? { color: p.color } : {}),
    url: p.url,
    schemas: p.schemas,
    ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs as number } : {}),
  };
}

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
    if (!existsSync(this.file)) return { version: 1, profiles: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StoreFile;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.profiles)) return parsed;
    } catch {
      // fall through to the corrupt path below
    }
    // Corrupt store: preserve it before starting empty — encrypted password
    // blobs are not re-derivable, so the user may want to recover them.
    // Timestamped so a second corruption never overwrites the first backup.
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      copyFileSync(this.file, `${this.file}.corrupt-${stamp}`);
    } catch {
      // If even the backup fails there is nothing more we can do safely.
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

  upsert(rawInput: unknown): ProfileView[] {
    const input = validateProfileInput(rawInput);
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
    if (typeof name !== 'string') throw new Error('profile name must be a string');
    const data = this.read();
    data.profiles = data.profiles.filter((p) => p.name !== name);
    this.write(data);
    return this.list();
  }

  /** Rebuild the full connection URL (with password) for spawning a worker.
   *  Callers must keep it out of argv and logs. */
  connectionUrl(name: string): { url: string; schemas: string[]; timeoutMs?: number } {
    if (typeof name !== 'string') throw new Error('profile name must be a string');
    const p = this.read().profiles.find((x) => x.name === name);
    if (!p) throw new Error(`unknown profile "${name}"`);
    const password = p.encryptedPassword !== undefined ? this.encryptor.decrypt(p.encryptedPassword) : null;
    return { url: joinDbUrl(p.url, password), schemas: p.schemas, timeoutMs: p.timeoutMs };
  }
}
