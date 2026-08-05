// Profile persistence: a shell-local minimal store.
//
// profiles.json holds only non-secret fields plus an OS-keychain-encrypted
// password blob (Electron safeStorage) — never a plaintext password. The
// encryptor is injected so unit tests can run without Electron.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  LocalMcpAllocation,
  McpMode,
  ProfileInput,
  ProfileView,
  RemoteMcpDeclaration,
  RowAccess,
} from '../shared/types.js';
import { joinDbUrl, splitDbUrl } from '../shared/url.js';
import { generateMcpPath, nextFreePort } from './mcpAllocation.js';

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
  /** Local-MCP allocation (main-owned; preserved across renderer upserts). */
  localMcp?: LocalMcpAllocation;
  /** Remote-MCP declaration (user-owned via the profile form). */
  remoteMcp?: RemoteMcpDeclaration;
  /** Row-data access grant (main-owned; absent means 'off'). Absent rather
   *  than an explicit 'off' so the fail-closed state is also the shape an
   *  older build writes back. */
  rowAccess?: 'read' | 'readwrite';
};

// The store stays at version 1 with additive optional fields: a version bump
// would make the file corrupt-equivalent to older builds sharing the same
// userData (their read() would back it up and start empty). Older builds
// preserve unknown top-level keys on write; editing a profile there drops
// only that profile's mcp fields.
//
// mcpMode (an app-wide setting) rides this file deliberately: one atomic
// store keeps the older-build compatibility analysis in a single place.
type StoreFile = { version: 1; mcpMode?: McpMode; profiles: StoredProfile[] };

/** Accept an on-disk localMcp only when its shape is valid; junk (a
 *  hand-edited or corrupted file) degrades to "absent" so allocation
 *  self-heals — the same philosophy as mcpMode falling back to 'off'.
 *  Guards downstream too: a string port would silently fail to reserve its
 *  numeric twin here and would make net.Server.listen treat it as a pipe
 *  name later. */
function sanitizeLocalMcp(x: unknown): LocalMcpAllocation | undefined {
  if (typeof x !== 'object' || x === null) return undefined;
  const a = x as Record<string, unknown>;
  if (!Number.isInteger(a.port) || (a.port as number) < 1 || (a.port as number) > 65_535) return undefined;
  if (typeof a.path !== 'string' || !a.path.startsWith('/mcp-')) return undefined;
  if (typeof a.autoStart !== 'boolean') return undefined;
  return { port: a.port as number, path: a.path, autoStart: a.autoStart };
}

/** Anything but the two known grants — a hand-edited file, a truncated
 *  write, a value from a future build — degrades to "absent" = 'off'. Junk
 *  must never widen a capability, so this direction is the only safe one. */
function sanitizeRowAccess(x: unknown): 'read' | 'readwrite' | undefined {
  return x === 'read' || x === 'readwrite' ? x : undefined;
}

/** What a row-access grant is anchored to: the database the approval dialog
 *  named, reached as the role stored for this profile, over these schemas.
 *
 *  Shared with rowAccessGate.ts on purpose — "what the user approved" and "what
 *  invalidates that approval" must not drift apart. A password rotation on an
 *  otherwise identical URL deliberately does not count (same server, same
 *  database, same role); adding or removing a stored password does, because it
 *  changes which credentials the grant would be exercised with.
 *
 *  The schema list is compared as a SET: sorted and de-duplicated for the
 *  comparison only, leaving the stored order untouched. Order does not change
 *  which rows are reachable — @kozou/api registers a bare relation name only
 *  when it is unique across the introspected schemas, so a collision is
 *  unaddressable rather than resolved by list order, and this app addresses
 *  relations by qualified name anyway. Treating a reorder as a new database
 *  would revoke a capability for an edit that changed nothing. */
export function rowAccessIdentity(profile: {
  url: string;
  schemas: readonly string[];
  hasPassword: boolean;
}): string {
  const schemas = Array.isArray(profile.schemas)
    ? [...new Set(profile.schemas)].sort()
    : profile.schemas;
  return JSON.stringify([profile.url, schemas, profile.hasPassword]);
}

/** Validate an untrusted row-access level (IPC input) before it can reach
 *  the store. */
export function validateRowAccess(level: unknown): RowAccess {
  if (level !== 'off' && level !== 'read' && level !== 'readwrite') {
    throw new Error('rowAccess must be one of "off" | "read" | "readwrite"');
  }
  return level;
}

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
  let remoteMcp: ProfileInput['remoteMcp'];
  if (p.remoteMcp !== undefined) {
    if (typeof p.remoteMcp !== 'object' || p.remoteMcp === null) {
      throw new Error('remoteMcp must be an object');
    }
    const r = p.remoteMcp as Record<string, unknown>;
    if (typeof r.declared !== 'boolean') throw new Error('remoteMcp.declared must be a boolean');
    if (r.url !== undefined) {
      if (typeof r.url !== 'string' || r.url === '') {
        throw new Error('remoteMcp.url must be a non-empty string when present');
      }
      let parsed: URL;
      try {
        parsed = new URL(r.url);
      } catch {
        throw new Error('remoteMcp.url must be a valid http(s) URL');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('remoteMcp.url must be a valid http(s) URL');
      }
      // profiles.json holds only non-secret fields — never store userinfo
      // credentials pasted into a remote URL.
      if (parsed.username !== '' || parsed.password !== '') {
        throw new Error('remoteMcp.url must not contain credentials');
      }
    }
    remoteMcp = { declared: r.declared, ...(r.url !== undefined ? { url: r.url as string } : {}) };
  }
  return {
    name: p.name,
    ...(typeof p.label === 'string' && p.label !== '' ? { label: p.label } : {}),
    ...(typeof p.color === 'string' && p.color !== '' ? { color: p.color } : {}),
    url: p.url,
    schemas: p.schemas,
    ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs as number } : {}),
    ...(remoteMcp !== undefined ? { remoteMcp } : {}),
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
      rowAccess: sanitizeRowAccess(p.rowAccess) ?? 'off',
      localMcp: sanitizeLocalMcp(p.localMcp),
      remoteMcp: p.remoteMcp,
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
    const data = this.read();
    const i = data.profiles.findIndex((p) => p.name === input.name);
    const existing = i >= 0 ? data.profiles[i] : undefined;
    // The local-MCP allocation and the row-access grant are main-owned:
    // renderer input never carries them (validateProfileInput drops unknown
    // keys), so an edit must not drop them either — losing a capability on
    // every label edit would be poor behaviour. The remote declaration follows
    // the input when present ({ declared: false } clears) and is preserved when
    // the input omits it.
    const preservedLocalMcp = sanitizeLocalMcp(existing?.localMcp);
    // The grant is the one exception, and only for the facts its approval was
    // anchored to: the dialog named a database, so an edit that repoints the
    // profile at a different one — or at different schemas, or at a different
    // credential state — must ask again rather than carry the grant over to a
    // record the user never saw. Label, colour and timeout edits keep it.
    const storedRowAccess = sanitizeRowAccess(existing?.rowAccess);
    const grantStillAnchored =
      existing !== undefined &&
      rowAccessIdentity({
        url: existing.url,
        schemas: existing.schemas,
        hasPassword: existing.encryptedPassword !== undefined,
      }) ===
        rowAccessIdentity({
          url: sansPassword,
          schemas: input.schemas,
          hasPassword: encryptedPassword !== undefined,
        });
    const preservedRowAccess = grantStillAnchored ? storedRowAccess : undefined;
    const remoteMcp: RemoteMcpDeclaration | undefined =
      input.remoteMcp === undefined
        ? existing?.remoteMcp
        : input.remoteMcp.declared
          ? { declared: true, ...(input.remoteMcp.url !== undefined ? { url: input.remoteMcp.url } : {}) }
          : undefined;
    const next: StoredProfile = {
      name: input.name,
      ...(input.label ? { label: input.label } : {}),
      ...(input.color ? { color: input.color } : {}),
      url: sansPassword,
      schemas: input.schemas,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(encryptedPassword !== undefined ? { encryptedPassword } : {}),
      ...(preservedLocalMcp !== undefined ? { localMcp: preservedLocalMcp } : {}),
      ...(remoteMcp !== undefined ? { remoteMcp } : {}),
      ...(preservedRowAccess !== undefined ? { rowAccess: preservedRowAccess } : {}),
    };
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
    const data = this.read();
    const p = this.findProfile(data, name);
    const password = p.encryptedPassword !== undefined ? this.encryptor.decrypt(p.encryptedPassword) : null;
    return { url: joinDbUrl(p.url, password), schemas: p.schemas, timeoutMs: p.timeoutMs };
  }

  /** App-wide MCP permission. Junk on disk degrades to 'off' — the safe
   *  default, and the only value that is safe to guess. A 'remote-only' written
   *  by an earlier build lands here too: that mode permitted nothing and started
   *  nothing, so reading it as 'off' preserves the behaviour the file already
   *  had. The value is left on disk rather than rewritten, because a read must
   *  not migrate the file (an older build reading it back would find its own
   *  value gone, and the file format stays at version 1 by design). */
  mcpMode(): McpMode {
    return this.read().mcpMode === 'local' ? 'local' : 'off';
  }

  setMcpMode(mode: unknown): McpMode {
    if (mode !== 'off' && mode !== 'local') {
      throw new Error('mcpMode must be one of "off" | "local"');
    }
    const data = this.read();
    data.mcpMode = mode;
    this.write(data);
    return mode;
  }

  /** The profile's row-data access level. Junk on disk degrades to 'off' —
   *  the fail-closed default, same philosophy as mcpMode. Read this (never a
   *  renderer-supplied level) before any row-data work. */
  rowAccess(name: string): RowAccess {
    const data = this.read();
    return sanitizeRowAccess(this.findProfile(data, name).rowAccess) ?? 'off';
  }

  /** Persist a row-access level. Main-owned and deliberately separate from
   *  upsert: a capability grant must never be a side effect of saving the
   *  profile form. Escalation additionally requires native approval — that
   *  gate lives in rowAccessGate.ts, which is the only intended caller
   *  (this method itself does not prompt). */
  setRowAccess(name: string, level: unknown): RowAccess {
    const next = validateRowAccess(level);
    const data = this.read();
    const p = this.findProfile(data, name);
    if (next === 'off') delete p.rowAccess;
    else p.rowAccess = next;
    this.write(data);
    return next;
  }

  /** The profile's local-MCP allocation, assigning port + capability path on
   *  first use (a shape-invalid stored value counts as absent and is
   *  replaced). Sticky: a valid existing allocation is returned unchanged —
   *  see reassignLocalMcpPort for the explicit user path. A fresh capability
   *  path is generated per allocation and never reused across profiles, so a
   *  recycled port never answers on a stale path. */
  ensureLocalMcpAllocation(name: string): LocalMcpAllocation {
    const data = this.read();
    const p = this.findProfile(data, name);
    const current = sanitizeLocalMcp(p.localMcp);
    if (current !== undefined) return current;
    p.localMcp = { port: nextFreePort(this.takenPorts(data)), path: generateMcpPath(), autoStart: false };
    this.write(data);
    return p.localMcp;
  }

  /** Explicitly move a profile to the next free port (user action after an
   *  "address in use" start failure). Keeps the capability path so only the
   *  port changes in any config the user re-copies. */
  reassignLocalMcpPort(name: string): LocalMcpAllocation {
    const data = this.read();
    const p = this.findProfile(data, name);
    const current = sanitizeLocalMcp(p.localMcp);
    const path = current?.path ?? generateMcpPath();
    const autoStart = current?.autoStart ?? false;
    // The current port is part of takenPorts, so the result always differs.
    p.localMcp = { port: nextFreePort(this.takenPorts(data)), path, autoStart };
    this.write(data);
    return p.localMcp;
  }

  /** Record the launch-time intent for this profile's local server. Set by
   *  explicit start (true) / stop (false) only. Stopping a never-allocated
   *  profile is a no-op — it must not burn a sticky port slot just to
   *  record the default. */
  setLocalMcpAutoStart(name: string, autoStart: boolean): LocalMcpAllocation | undefined {
    if (typeof autoStart !== 'boolean') throw new Error('autoStart must be a boolean');
    const data = this.read();
    const p = this.findProfile(data, name);
    const current = sanitizeLocalMcp(p.localMcp);
    if (current === undefined) {
      if (!autoStart) return undefined;
      p.localMcp = { port: nextFreePort(this.takenPorts(data)), path: generateMcpPath(), autoStart };
    } else {
      p.localMcp = { ...current, autoStart };
    }
    this.write(data);
    return p.localMcp;
  }

  private takenPorts(data: StoreFile): number[] {
    return data.profiles
      .map((p) => sanitizeLocalMcp(p.localMcp)?.port)
      .filter((port): port is number => port !== undefined);
  }

  private findProfile(data: StoreFile, name: string): StoredProfile {
    if (typeof name !== 'string') throw new Error('profile name must be a string');
    const p = data.profiles.find((x) => x.name === name);
    if (!p) throw new Error(`unknown profile "${name}"`);
    return p;
  }
}
