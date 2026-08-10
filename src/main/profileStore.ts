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
import { BRIDGE_ID_RE } from '../shared/mcpLocator.js';
import { dbIdentityKey } from '../shared/dbIdentity.js';
import { joinDbUrl, splitDbUrl } from '../shared/url.js';
import { generateBridgeId, generateMcpPath, nextFreePort } from './mcpAllocation.js';

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
  // A missing or malformed bridge id degrades to "absent", never to
  // "allocation invalid": an allocation written before locators existed must
  // keep its port and path (AI-client configs point at them) and gain an id
  // on next use.
  const bridgeId = typeof a.bridgeId === 'string' && BRIDGE_ID_RE.test(a.bridgeId) ? a.bridgeId : undefined;
  return {
    port: a.port as number,
    path: a.path,
    autoStart: a.autoStart,
    ...(bridgeId !== undefined ? { bridgeId } : {}),
  };
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
    // Two things are anchored to the connection the user last saw, and they are
    // anchored to DIFFERENT parts of it, because they answer different questions.
    //
    // The row-access grant is an authorization: the dialog named a database, and
    // it named it with a schema list and a credential state. Widen the schemas
    // and the same grant reaches rows nobody approved; change which credentials
    // it is exercised with and it is a different act. So the grant is anchored to
    // all three (rowAccessIdentity).
    //
    // The local-MCP allocation is a destination: a port, a capability path and a
    // locator id, which is what an AI client's pasted config points AT. The
    // failure it exists to prevent is a pasted entry silently answering for
    // another database under the same name — and only the database can do that.
    // Adding a schema does not repoint anything; neither does storing or
    // dropping a password. Anchoring the allocation to those as well cost a
    // repaste for an edit that moved nothing, and it cost it on a path this app
    // itself instructs: the pane's own words for an out-of-schema relation are
    // "Add its schema to the profile to inspect it".
    //
    // So the allocation is anchored to the database, using `dbIdentityKey` — the
    // definition this codebase already owns and already uses for the duplicate
    // warning, which means there is one answer to "is this the same database?"
    // rather than two that disagree. The username is not part of it, which is a
    // consequence worth naming: switching role keeps the allocation, on the
    // grounds that it is the same database reached another way, and the grant
    // (which does watch the URL) is what re-asks.
    //
    // Stickiness is not violated by this. A port stays fixed so that a config
    // the user has already pasted keeps working — for THIS database. Once the
    // profile names another one, invalidating that config is the point: the
    // fresh capability path 404s a pasted URL, and the fresh locator id makes
    // the bridge fail explicitly instead of relaying somewhere new. Label,
    // colour, schema and timeout edits change neither.
    //
    // Ordering is what makes the discard safe: main stops a running server
    // before the store is written, and stopping withdraws that profile's
    // locator — so the file is gone before the allocation naming it is. The
    // invariant needed is "allocation discarded implies main stopped". It holds
    // because discarding requires the identity keys to differ AND the normalized
    // strings to differ, and normalization is a function: equal raw strings give
    // equal normalized ones, so a discard implies the raw strings differ, and
    // main compares raw strings (with the password joined in, plus the schema
    // list). The other direction — main stops while the allocation survives — is
    // reachable (drop an explicit `:5432`, or reorder the schema list, and main's
    // string compare fires while this one does not) and is harmless: same
    // database, server restored on the next launch.
    //
    // NOT claimed: that main's own read fails on an unparseable stored URL.
    // `joinDbUrl` returns early when no password is stored and never parses, so
    // the catch there does not run; main stops on the string compare instead. An
    // earlier version of this comment asserted the parse, and it was wrong.
    //
    // The motive here is ergonomic, not safety: a repaste charged for an edit
    // that moved nothing. The safety story is "no worse", with one hole closed
    // and one narrower one left. Closed: a profiles.json whose `url` field
    // carried a password by hand (this app never writes one) looked identical to
    // main — no stop — while flipping hasPassword here, so the allocation went
    // out from under a running server and left its locator until the next launch
    // swept it; both sides now compare equal on that save. Left: if that
    // hand-written password also holds a broken percent-escape, `splitDbUrl`
    // throws here while `joinDbUrl` replaces the password, so main can still see
    // no change while this discards. The cost either way is an orphaned locator
    // file, which can only fail a bridge or reach the server it already named —
    // a leak of a file, not of a destination.
    const storedRowAccess = sanitizeRowAccess(existing?.rowAccess);
    const connectionUnchanged =
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
    /** Whether the profile still names the database its allocation was handed out
     *  for. `dbIdentityKey` is this codebase's own answer to "is this the same
     *  database?" — (host, port, database), with the username and the schema list
     *  deliberately out of it — so the allocation uses that rather than a second,
     *  finer notion of its own. A raw string compare would call `:5432` and the
     *  default port, `postgres://` and `postgresql://`, `localhost` and
     *  `127.0.0.1` different databases, and there is no edit form in this app: a
     *  schema change means retyping the whole URL, so every one of those spellings
     *  would be a repaste charged for nothing.
     *
     *  It answers null for URL forms it declines to model (a query string that can
     *  redirect the connection, an unparseable string). Two nulls are NOT equal
     *  here — an unmodellable URL is not evidence of sameness — so those fall
     *  through to the normalized string, which keeps a byte-identical re-save from
     *  being read as a repoint while still discarding on any real edit. */
    const sameDatabase = ((): boolean => {
      if (existing === undefined) return false;
      const storedKey = dbIdentityKey(existing.url);
      if (storedKey !== null && storedKey === dbIdentityKey(sansPassword)) return true;
      try {
        return splitDbUrl(existing.url).sansPassword === sansPassword;
      } catch {
        return false;
      }
    })();
    /** Whether this edit adds a schema the profile did not have. Widening is the
     *  one schema edit that changes what a server would serve to a config already
     *  pasted into somebody's AI client, so it keeps the destination and drops the
     *  intent: the operator's next explicit start is what authorizes the wider set.
     *  Narrowing and reordering are neither. */
    const widensSchemas = ((): boolean => {
      const before = new Set(existing?.schemas ?? []);
      return input.schemas.some((schema) => !before.has(schema));
    })();
    const preservedRowAccess = connectionUnchanged ? storedRowAccess : undefined;
    const preservedLocalMcp = ((): LocalMcpAllocation | undefined => {
      if (!sameDatabase) return undefined;
      const kept = sanitizeLocalMcp(existing?.localMcp);
      if (kept === undefined) return undefined;
      return widensSchemas ? { ...kept, autoStart: false } : kept;
    })();
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
   *  replaced). Sticky within one connection: a valid existing allocation is
   *  returned unchanged — see reassignLocalMcpPort for the explicit user path,
   *  and upsert for the repoint that discards it. A fresh capability path is
   *  generated per allocation and never reused across profiles, so a recycled
   *  port never answers on a stale path — which is also what makes a discarded
   *  allocation safe to replace on the same port. */
  ensureLocalMcpAllocation(name: string): LocalMcpAllocation & { bridgeId: string } {
    const data = this.read();
    const p = this.findProfile(data, name);
    const current = sanitizeLocalMcp(p.localMcp);
    if (current?.bridgeId !== undefined) return { ...current, bridgeId: current.bridgeId };
    // An allocation from a build that had no locators keeps its port and path
    // and only gains an id — renumbering here would invalidate configs the
    // user has already pasted, which is exactly what stickiness exists to
    // prevent.
    const next: LocalMcpAllocation & { bridgeId: string } =
      current !== undefined
        ? { ...current, bridgeId: generateBridgeId() }
        : {
            port: nextFreePort(this.takenPorts(data)),
            path: generateMcpPath(),
            autoStart: false,
            bridgeId: generateBridgeId(),
          };
    p.localMcp = next;
    this.write(data);
    return next;
  }

  /** Explicitly move a profile to the next free port (user action after an
   *  "address in use" start failure). Keeps the capability path and the
   *  locator id so only the port changes in any config the user re-copies —
   *  and so a bridge entry keeps resolving (it reads the port at run time). */
  reassignLocalMcpPort(name: string): LocalMcpAllocation {
    const data = this.read();
    const p = this.findProfile(data, name);
    const current = sanitizeLocalMcp(p.localMcp);
    const path = current?.path ?? generateMcpPath();
    const autoStart = current?.autoStart ?? false;
    const bridgeId = current?.bridgeId ?? generateBridgeId();
    // The current port is part of takenPorts, so the result always differs.
    p.localMcp = { port: nextFreePort(this.takenPorts(data)), path, autoStart, bridgeId };
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
      p.localMcp = {
        port: nextFreePort(this.takenPorts(data)),
        path: generateMcpPath(),
        autoStart,
        bridgeId: generateBridgeId(),
      };
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
