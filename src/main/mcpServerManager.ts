// Registry and lifecycle for the per-profile local MCP server workers.
//
// Ownership rules:
//   - The manager owns every child (Electron utilityProcess) it spawns and
//     kills them all on app quit — app lifetime bounds MCP lifetime. A main
//     process crash is additionally covered by Chromium reclaiming utility
//     processes (verified empirically; see EGRESS.md runtime verification).
//   - Live state (running/starting/error) is volatile registry state; the
//     store persists only the allocation (port/path) and the autoStart
//     intent. Every launch starts from "all stopped" and then restores the
//     autoStart profiles when the app-wide mode is 'local'.
//   - No automatic crash restart: a crashed server surfaces as
//     'stopped-crashed' with its sanitized stderr tail, and restarting is a
//     user action.
//
// Secrets: the connection URL goes to the child via env only (argv stays
// empty, IPC messages carry only port/path/schemas). The child's stdio is
// piped, buffered to line boundaries, and sanitized before it reaches any
// log or status surface — @kozou/mcp writes raw error text to stderr, which
// may carry host/db identifiers (never the password: PostgreSQL does not
// echo it).
//
// The Electron dependency is injected as a fork function (electronFork.ts)
// so the whole state machine is unit-testable with a fake child — the same
// philosophy as the profile store's injected Encryptor.
//
// Bridge locators (mcpLocatorFile.ts) are published here rather than beside
// the allocation, because what they assert is liveness: a locator exists
// exactly while a server is confirmed listening. Every path out of 'running'
// — user stop, profile edit, crash, mode switch, quit — goes through this
// class, so this is the only place that can keep that true.

import { findRemoteDuplicates } from '../shared/dbIdentity.js';
import { sanitizeErrorMessage } from '../shared/url.js';
import type {
  McpServerStatus,
  McpStartOutcome,
  McpStatusEntry,
  McpWorkerRequest,
  McpWorkerStarted,
} from '../shared/types.js';
import type { McpLocatorWriter } from './mcpLocatorFile.js';
import type { ProfileStore } from './profileStore.js';

const ENV_KEY = 'KOZOU_DESKTOP_DB_URL';

/** Server startup = bind + listen only (introspection is lazy, on the first
 *  tool call), so this is a hang guard, not a UX budget. */
const START_TIMEOUT_MS = 20_000;
const STDERR_TAIL_LINES = 20;
const STOP_WAIT_MS = 3_000;

/** The structural slice of Electron's UtilityProcess the manager needs —
 *  narrow so tests can fake it. */
export type McpWorkerHandle = {
  postMessage(message: unknown): void;
  kill(): boolean;
  once(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  stdout?: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
};

export type McpWorkerFork = (
  modulePath: string,
  options: { env: Record<string, string>; serviceName: string; stdio: 'pipe' },
) => McpWorkerHandle;

type StopReason = 'user' | 'profile-updated' | 'shutdown';

type Entry = {
  child?: McpWorkerHandle;
  status: McpServerStatus;
  error?: string;
  stderrTail: string[];
  stopReason?: StopReason;
  /** The published locator, while this profile's server is running. */
  locator?: { id: string; generation: string };
};

export class McpServerManager {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly store: ProfileStore,
    private readonly workerPath: () => string,
    private readonly fork: McpWorkerFork,
    private readonly locators: McpLocatorWriter,
    /** Called on every state change so main can push status to the renderer. */
    private readonly onChange: () => void = () => {},
  ) {}

  /** Live status joined over all profiles (stopped when never touched). */
  status(): McpStatusEntry[] {
    return this.store.list().map((p) => {
      const e = this.entries.get(p.name);
      return {
        profile: p.name,
        status: e?.status ?? 'stopped',
        port: p.localMcp?.port,
        path: p.localMcp?.path,
        autoStart: p.localMcp?.autoStart ?? false,
        ...(e?.error !== undefined ? { error: e.error } : {}),
      };
    });
  }

  /** Start one profile's server. Interactive starts flip autoStart to true
   *  on success; restore-time starts keep the stored intent untouched and
   *  turn a duplicate warning into a skip (no dialogs at launch). */
  async start(name: string, opts?: { override?: boolean; fromRestore?: boolean }): Promise<McpStartOutcome> {
    if (this.store.mcpMode() !== 'local') {
      return { outcome: 'not-local-mode', status: this.status() };
    }
    const current = this.entries.get(name);
    if (current?.status === 'running' || current?.status === 'starting') {
      return { outcome: 'started', status: this.status() }; // idempotent
    }
    const profiles = this.store.list();
    const target = profiles.find((p) => p.name === name);
    if (!target) throw new Error(`unknown profile "${name}"`);

    const duplicates = findRemoteDuplicates(profiles, target.url);
    if (duplicates.length > 0 && !opts?.override) {
      if (opts?.fromRestore) {
        this.setEntry(name, { status: 'blocked-duplicate', stderrTail: [] });
      }
      return { outcome: 'blocked-duplicate', duplicates, status: this.status() };
    }

    const alloc = this.store.ensureLocalMcpAllocation(name);
    const connection = this.store.connectionUrl(name);
    const entry: Entry = { status: 'starting', stderrTail: [] };
    this.entries.set(name, entry);
    this.onChange();

    const child = this.fork(this.workerPath(), {
      env: { [ENV_KEY]: connection.url },
      serviceName: 'kozou-desktop-mcp',
      stdio: 'pipe',
    });
    entry.child = child;

    // Buffer each stream to line boundaries before sanitizing: a secret (or
    // a line) straddling a chunk boundary must not evade the scrub.
    const makeTail = (): ((chunk: unknown) => void) => {
      let pending = '';
      return (chunk: unknown): void => {
        pending += String(chunk);
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        const cleaned = lines
          .map((l) => sanitizeErrorMessage(l, connection.url).trimEnd())
          .filter((l) => l.length > 0);
        entry.stderrTail.push(...cleaned);
        if (entry.stderrTail.length > STDERR_TAIL_LINES) {
          entry.stderrTail.splice(0, entry.stderrTail.length - STDERR_TAIL_LINES);
        }
      };
    };
    child.stderr?.on('data', makeTail());
    child.stdout?.on('data', makeTail());

    let settled = false;
    const started = await new Promise<McpWorkerStarted>((resolve) => {
      const finish = (r: McpWorkerStarted): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        finish({ ok: false, error: `MCP server did not confirm startup within ${START_TIMEOUT_MS}ms` });
      }, START_TIMEOUT_MS);

      child.once('message', (message: unknown) => finish(message as McpWorkerStarted));
      child.on('exit', (code: number) => {
        if (!settled) {
          finish({ ok: false, error: `worker exited before startup (code ${code})` });
          return;
        }
        // Post-startup exit: requested stop or crash.
        const e = this.entries.get(name);
        if (!e || e.child !== child) return;
        e.child = undefined;
        this.releaseLocator(e);
        if (e.stopReason !== undefined) {
          e.status = e.stopReason === 'profile-updated' ? 'stopped-profile-updated' : 'stopped';
          e.error = undefined;
        } else {
          e.status = 'stopped-crashed';
          e.error = e.stderrTail.slice(-3).join('\n') || `exited unexpectedly (code ${code})`;
        }
        e.stopReason = undefined;
        this.onChange();
      });

      const request: McpWorkerRequest = { port: alloc.port, mcpPath: alloc.path, schemas: connection.schemas };
      child.postMessage(request);
    });

    if (!started.ok) {
      child.kill();
      entry.child = undefined;
      if (entry.stopReason !== undefined) {
        // A kill during startup (explicit stop, profile edit, mode switch,
        // quit sweep) is not an error — map it by its reason. The caller
        // still sees outcome 'error'; the status array is authoritative.
        entry.status = entry.stopReason === 'profile-updated' ? 'stopped-profile-updated' : 'stopped';
        entry.error = undefined;
        entry.stopReason = undefined;
      } else {
        entry.status = started.portBusy ? 'error-port-busy' : 'error';
        entry.error = started.error;
      }
      this.onChange();
      return { outcome: 'error', error: started.error, status: this.status() };
    }

    // Publish the locator only now, and treat a failure to publish as a
    // failure to start. The invariant "a locator exists exactly while its
    // server is listening" has to hold in both directions: a running server
    // with no locator would make every bridge entry for it report the app as
    // not serving, which the user could only diagnose from the other
    // application's log. The cost of this choice is that a filesystem error
    // takes down a server that URL-based clients could still have used.
    let generation: string;
    try {
      generation = this.locators.write({ id: alloc.bridgeId, port: alloc.port, path: alloc.path });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.kill(name, 'user');
      this.onChange();
      return { outcome: 'error', error: `could not publish the bridge locator: ${message}`, status: this.status() };
    }
    entry.locator = { id: alloc.bridgeId, generation };
    entry.status = 'running';
    entry.error = undefined;
    if (!opts?.fromRestore) this.store.setLocalMcpAutoStart(name, true);
    this.onChange();
    return { outcome: 'started', status: this.status() };
  }

  /** Explicit user stop: clears the autoStart intent. */
  async stop(name: string): Promise<McpStatusEntry[]> {
    this.store.setLocalMcpAutoStart(name, false);
    await this.kill(name, 'user');
    return this.status();
  }

  /** Stop everything without touching per-profile autoStart intents (app
   *  quit / mode switch are not per-profile stop decisions — the intents
   *  must survive for the next launch's restore). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((name) => this.kill(name, 'shutdown')));
  }

  /** Best-effort synchronous kill sweep for before-quit: fire the kills and
   *  let Chromium reap with the app. */
  killAllSync(): void {
    for (const entry of this.entries.values()) {
      entry.stopReason ??= 'shutdown';
      entry.child?.kill();
      // Synchronously here as well as in the exit handler: on quit the
      // handler may never run, and a locator outliving the app would point
      // an AI client at a port nothing answers on.
      this.releaseLocator(entry);
    }
  }

  /** A profile edit invalidates the running server's fork-time connection —
   *  stop it rather than silently serving the old database. Restart is a
   *  user action (autoStart is left as stored, so the next launch uses the
   *  new settings). The caller decides relevance (connection-bearing edits
   *  only). */
  async onProfileUpserted(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (entry?.child !== undefined) await this.kill(name, 'profile-updated');
  }

  async onProfileRemoved(name: string): Promise<void> {
    await this.kill(name, 'user');
    this.entries.delete(name);
    this.onChange();
  }

  /** Launch-time restore of the autoStart profiles (mode 'local' only).
   *  Deliberately sequential: binds happen in a deterministic order and the
   *  expected envelope is a handful of profiles. Duplicate-conflicted
   *  profiles are skipped into 'blocked-duplicate' instead of prompting —
   *  no dialogs at launch. A failing profile (keychain refusal, allocation
   *  failure) is recorded and must not abort the rest of the loop. */
  async restoreAutoStart(): Promise<void> {
    if (this.store.mcpMode() !== 'local') return;
    for (const p of this.store.list()) {
      if (p.localMcp?.autoStart !== true) continue;
      try {
        await this.start(p.name, { fromRestore: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.setEntry(p.name, { status: 'error', error: message, stderrTail: [] });
      }
    }
  }

  /** Reassigning a port while the server runs would desync the live bind
   *  from the persisted allocation — require a stop first. */
  reassignPort(name: string): McpStatusEntry[] {
    const entry = this.entries.get(name);
    if (entry?.status === 'running' || entry?.status === 'starting') {
      throw new Error('stop the server before reassigning its port');
    }
    this.store.reassignLocalMcpPort(name);
    if (entry !== undefined && (entry.status === 'error-port-busy' || entry.status === 'error')) {
      entry.status = 'stopped';
      entry.error = undefined;
    }
    this.onChange();
    return this.status();
  }

  /** Withdraw this entry's locator, if it published one. Idempotent: both the
   *  exit handler and the quit sweep call it. */
  private releaseLocator(entry: Entry): void {
    const locator = entry.locator;
    if (locator === undefined) return;
    entry.locator = undefined;
    try {
      this.locators.remove(locator.id, locator.generation);
    } catch {
      // A locator we cannot delete points at a port nothing answers on: the
      // bridge fails explicitly there, and the next launch's sweep clears it.
      // Nothing here is worth failing a stop over.
    }
  }

  private setEntry(name: string, entry: Entry): void {
    this.entries.set(name, entry);
    this.onChange();
  }

  private async kill(name: string, reason: StopReason): Promise<void> {
    const entry = this.entries.get(name);
    const child = entry?.child;
    if (entry === undefined || child === undefined) return;
    entry.stopReason = reason;
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), STOP_WAIT_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    child.kill();
    await exited;
  }
}
