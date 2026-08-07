// State-machine tests for McpServerManager with an injected fake fork —
// the Electron dependency is behind the McpWorkerFork type exactly so this
// suite can pin the lifecycle rules without a display server:
// start/stop/restore transitions, stop-reason mapping, autoStart intent
// semantics, duplicate blocking, port-busy handling, and the env-only
// secret channel.
//
// Bridge locators are here too, and for the same reason: what has to hold is
// that a locator exists exactly while a server does, which is a statement
// about every exit path rather than about the writer.

import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { McpLocatorWriter } from '../src/main/mcpLocatorFile.js';
import { McpServerManager, type McpWorkerFork, type McpWorkerHandle } from '../src/main/mcpServerManager.js';
import { ProfileStore, type Encryptor } from '../src/main/profileStore.js';
import type { McpStatusEntry } from '../src/shared/types.js';

const fakeEncryptor: Encryptor = {
  available: () => true,
  encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`,
  decrypt: (b) => Buffer.from(b.slice(4), 'base64').toString(),
};

class FakeChild implements McpWorkerHandle {
  readonly em = new EventEmitter();
  readonly messages: unknown[] = [];
  killed = false;
  /** Set to model a child that ignores kill() — the manager's stop wait is a
   *  timeout, so this is the path where it gives up rather than observes an
   *  exit. */
  ignoresKill = false;
  constructor(
    readonly modulePath: string,
    readonly options: { env: Record<string, string>; serviceName: string; stdio: 'pipe' },
  ) {}
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
  kill(): boolean {
    this.killed = true;
    if (!this.ignoresKill) queueMicrotask(() => this.em.emit('exit', 0));
    return true;
  }
  once(event: 'message' | 'exit', listener: (arg: never) => void): unknown {
    this.em.once(event, listener as (...args: unknown[]) => void);
    return this;
  }
  on(event: 'exit', listener: (code: number) => void): unknown {
    this.em.on(event, listener);
    return this;
  }
  stdout = { on: (_e: 'data', l: (chunk: unknown) => void): void => void this.em.on('stdout', l) };
  stderr = { on: (_e: 'data', l: (chunk: unknown) => void): void => void this.em.on('stderr', l) };

  replyOk(port: number): void {
    queueMicrotask(() => this.em.emit('message', { ok: true, port }));
  }
  replyError(error: string, portBusy?: boolean): void {
    queueMicrotask(() => this.em.emit('message', { ok: false, error, ...(portBusy ? { portBusy } : {}) }));
  }
  emitStderr(text: string): void {
    this.em.emit('stderr', text);
  }
  crash(code: number): void {
    this.em.emit('exit', code);
  }
}

/** Records what the manager publishes, and keeps the same "present exactly
 *  while running" bookkeeping the file writer does. */
class FakeLocators implements McpLocatorWriter {
  readonly published = new Map<string, { port: number; path: string; generation: string }>();
  readonly log: string[] = [];
  failWrite: string | undefined;
  private counter = 0;

  write(entry: { id: string; port: number; path: string }): string {
    if (this.failWrite !== undefined) throw new Error(this.failWrite);
    const generation = `gen${++this.counter}`;
    this.published.set(entry.id, { port: entry.port, path: entry.path, generation });
    this.log.push(`write:${entry.id}`);
    return generation;
  }

  remove(id: string, generation: string): void {
    this.log.push(`remove:${id}`);
    if (this.published.get(id)?.generation === generation) this.published.delete(id);
  }

  clearAll(): void {
    this.published.clear();
    this.log.push('clearAll');
  }
}

function harness(): {
  store: ProfileStore;
  manager: McpServerManager;
  children: FakeChild[];
  locators: FakeLocators;
  entry: (name: string) => McpStatusEntry | undefined;
} {
  const dir = mkdtempSync(join(tmpdir(), 'kozou-desktop-mcp-test-'));
  const store = new ProfileStore(dir, fakeEncryptor);
  const children: FakeChild[] = [];
  const fork: McpWorkerFork = (modulePath, options) => {
    const child = new FakeChild(modulePath, options);
    children.push(child);
    return child;
  };
  const locators = new FakeLocators();
  const manager = new McpServerManager(store, () => '/out/mcpServerWorker.js', fork, locators);
  store.setMcpMode('local');
  return { store, manager, children, locators, entry: (name) => manager.status().find((s) => s.profile === name) };
}

const BASE = { url: 'postgresql://u@h:5432/db', schemas: ['public'] };

describe('McpServerManager', () => {
  it('starts a server: env-only secret, argv-free message, running status, autoStart set', async () => {
    const { store, manager, children, entry } = harness();
    store.upsert({ name: 'a', url: 'postgresql://app:s3cr3t@h:5432/db', schemas: ['public'] });
    const pending = manager.start('a');
    const child = children[0]!;
    // The secret travels in env only; the IPC message carries no URL.
    expect(child.options.env.KOZOU_DESKTOP_DB_URL).toBe('postgresql://app:s3cr3t@h:5432/db');
    expect(child.options.serviceName).toBe('kozou-desktop-mcp');
    expect(child.messages).toEqual([{ port: 3335, mcpPath: expect.stringMatching(/^\/mcp-/), schemas: ['public'] }]);
    expect(JSON.stringify(child.messages)).not.toContain('s3cr3t');
    child.replyOk(3335);
    const outcome = await pending;
    expect(outcome.outcome).toBe('started');
    expect(entry('a')?.status).toBe('running');
    expect(entry('a')?.autoStart).toBe(true);
  });

  it('refuses to start outside local mode', async () => {
    const { store, manager, children } = harness();
    store.upsert({ name: 'a', ...BASE });
    store.setMcpMode('off');
    const outcome = await manager.start('a');
    expect(outcome.outcome).toBe('not-local-mode');
    expect(children).toHaveLength(0);
  });

  it('blocks a duplicate of a declared remote MCP and honors override', async () => {
    const { store, manager, children } = harness();
    store.upsert({ name: 'declared', url: 'postgresql://u@127.0.0.1/db', schemas: ['public'], remoteMcp: { declared: true } });
    store.upsert({ name: 'a', url: 'postgresql://u@localhost:5432/db', schemas: ['public'] });
    const blocked = await manager.start('a');
    expect(blocked.outcome).toBe('blocked-duplicate');
    expect(blocked.duplicates).toEqual(['declared']);
    expect(children).toHaveLength(0);
    const pending = manager.start('a', { override: true });
    children[0]!.replyOk(3336);
    expect((await pending).outcome).toBe('started');
  });

  it('maps a stop during startup to stopped (not error) and clears autoStart', async () => {
    const { store, manager, children, entry } = harness();
    store.upsert({ name: 'a', ...BASE });
    const pending = manager.start('a'); // no reply scheduled — still starting
    expect(entry('a')?.status).toBe('starting');
    await manager.stop('a');
    await pending;
    expect(entry('a')?.status).toBe('stopped');
    expect(entry('a')?.error).toBeUndefined();
    expect(entry('a')?.autoStart).toBe(false);
    expect(children[0]!.killed).toBe(true);
  });

  it('maps a profile edit during startup to stopped-profile-updated', async () => {
    const { store, manager, entry } = harness();
    store.upsert({ name: 'a', ...BASE });
    const pending = manager.start('a');
    await manager.onProfileUpserted('a');
    await pending;
    expect(entry('a')?.status).toBe('stopped-profile-updated');
  });

  it('surfaces a crash as stopped-crashed with a sanitized stderr tail', async () => {
    const { store, manager, children, entry } = harness();
    store.upsert({ name: 'a', url: 'postgresql://app:s3cr3t@h:5432/db', schemas: ['public'] });
    const pending = manager.start('a');
    const child = children[0]!;
    child.replyOk(3335);
    await pending;
    child.emitStderr('fatal: connection to postgresql://app:s3cr3t@h:5432/db was reset\n');
    child.crash(1);
    const e = entry('a')!;
    expect(e.status).toBe('stopped-crashed');
    expect(e.error).toBeDefined();
    expect(e.error).not.toContain('s3cr3t');
    // autoStart intent survives a crash (restart is a user action; next
    // launch may restore).
    expect(e.autoStart).toBe(true);
  });

  it('publishes a locator while running and withdraws it on every exit path', async () => {
    const { store, manager, children, locators, entry } = harness();
    store.upsert({ name: 'a', ...BASE });
    const alloc = store.ensureLocalMcpAllocation('a');

    const started = manager.start('a');
    // Nothing is published while the server is only starting.
    expect(locators.published.size).toBe(0);
    children[0]!.replyOk(alloc.port);
    await started;
    expect([...locators.published.keys()]).toEqual([alloc.bridgeId]);
    expect(locators.published.get(alloc.bridgeId)).toMatchObject({ port: alloc.port, path: alloc.path });

    // Explicit stop.
    await manager.stop('a');
    expect(locators.published.size).toBe(0);

    // Crash.
    const again = manager.start('a');
    children[1]!.replyOk(alloc.port);
    await again;
    expect(locators.published.size).toBe(1);
    children[1]!.crash(1);
    expect(entry('a')?.status).toBe('stopped-crashed');
    expect(locators.published.size).toBe(0);

    // Quit sweep: synchronous, because the exit handler may not run.
    const third = manager.start('a');
    children[2]!.replyOk(alloc.port);
    await third;
    manager.killAllSync();
    expect(locators.published.size).toBe(0);
  });

  it('publishes nothing when a stop lands after the worker confirmed but before the start returns', async () => {
    const { store, manager, children, locators, entry } = harness();
    store.upsert({ name: 'a', ...BASE });
    const pending = manager.start('a');
    const child = children[0]!;
    child.replyOk(3335); // the worker is up...
    await manager.stop('a'); // ...and the user stops it in the same tick
    const outcome = await pending;
    expect(outcome.outcome).toBe('error');
    expect(entry('a')?.status).toBe('stopped');
    // The window this closes: a locator naming a server that is already gone.
    expect(locators.published.size).toBe(0);
    expect(child.killed).toBe(true);
  });

  it('fails the start when the locator cannot be published', async () => {
    const { store, manager, children, locators, entry } = harness();
    store.upsert({ name: 'a', ...BASE });
    locators.failWrite = 'read-only filesystem';
    const pending = manager.start('a');
    children[0]!.replyOk(3335);
    const outcome = await pending;
    expect(outcome.outcome).toBe('error');
    expect(outcome.error).toMatch(/could not publish the bridge locator: read-only filesystem/);
    // The server it could not advertise is not left running.
    expect(children[0]!.killed).toBe(true);
    expect(entry('a')?.status).toBe('stopped');
    expect(locators.published.size).toBe(0);
  });

  it('withdraws the locator even when the worker ignores the kill', async () => {
    // The stop wait is a timeout, not proof of death, and on the delete path
    // the entry is dropped right after it — so a later exit would find no
    // entry and the locator would outlive the app's decision to stop serving.
    vi.useFakeTimers();
    try {
      const { store, manager, children, locators } = harness();
      store.upsert({ name: 'a', ...BASE });
      const started = manager.start('a');
      const child = children[0]!;
      child.replyOk(3335);
      await started;
      expect(locators.published.size).toBe(1);

      child.ignoresKill = true;
      const removing = manager.onProfileRemoved('a');
      await vi.advanceTimersByTimeAsync(5_000);
      await removing;
      expect(child.killed).toBe(true);
      expect(locators.published.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a recreated profile a new locator id, so a stale entry cannot resolve', async () => {
    const { store, manager, children, locators } = harness();
    store.upsert({ name: 'a', ...BASE });
    const first = store.ensureLocalMcpAllocation('a');
    const started = manager.start('a');
    children[0]!.replyOk(first.port);
    await started;
    expect(locators.published.has(first.bridgeId)).toBe(true);

    await manager.onProfileRemoved('a');
    store.remove('a');
    expect(locators.published.size).toBe(0);

    store.upsert({ name: 'a', ...BASE });
    const second = store.ensureLocalMcpAllocation('a');
    expect(second.bridgeId).not.toBe(first.bridgeId);
  });

  it('maps EADDRINUSE to error-port-busy; reassign moves the port and needs a stopped server', async () => {
    const { store, manager, children, entry } = harness();
    store.upsert({ name: 'a', ...BASE });
    store.upsert({ name: 'b', ...BASE });
    const pending = manager.start('a');
    children[0]!.replyError('listen EADDRINUSE: address already in use 127.0.0.1:3335', true);
    const outcome = await pending;
    expect(outcome.outcome).toBe('error');
    expect(entry('a')?.status).toBe('error-port-busy');
    const after = manager.reassignPort('a');
    expect(after.find((s) => s.profile === 'a')?.port).toBe(3336);
    expect(entry('a')?.status).toBe('stopped');
    // A running server refuses reassignment.
    const runB = manager.start('b');
    children[1]!.replyOk(3337);
    await runB;
    expect(() => manager.reassignPort('b')).toThrow(/stop the server/);
  });

  it('stopAll preserves autoStart intents; explicit stop clears them', async () => {
    const { store, manager, children, entry } = harness();
    store.upsert({ name: 'a', ...BASE });
    const pending = manager.start('a');
    children[0]!.replyOk(3335);
    await pending;
    expect(entry('a')?.autoStart).toBe(true);
    await manager.stopAll();
    expect(entry('a')?.status).toBe('stopped');
    expect(entry('a')?.autoStart).toBe(true); // survives shutdown sweeps
  });

  it('restore continues past a failing profile and skips duplicates without dialogs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kozou-desktop-mcp-test-'));
    // decrypt throws: simulates a keychain refusal at launch.
    const store = new ProfileStore(dir, {
      ...fakeEncryptor,
      decrypt: () => {
        throw new Error('keychain refused');
      },
    });
    const children: FakeChild[] = [];
    const fork: McpWorkerFork = (modulePath, options) => {
      const child = new FakeChild(modulePath, options);
      children.push(child);
      // restore awaits each start; auto-confirm so the loop advances.
      child.replyOk(0);
      return child;
    };
    const manager = new McpServerManager(store, () => '/out/mcpServerWorker.js', fork, new FakeLocators());
    store.setMcpMode('local');
    store.upsert({ name: 'bad', url: 'postgresql://u:pw@h:5432/db', schemas: ['public'] });
    store.upsert({ name: 'dup', url: 'postgresql://u@h2:5432/db', schemas: ['public'] });
    store.upsert({ name: 'declared', url: 'postgresql://u@h2:5432/db', schemas: ['public'], remoteMcp: { declared: true } });
    store.upsert({ name: 'good', url: 'postgresql://u@h3:5432/db', schemas: ['public'] });
    for (const name of ['bad', 'dup', 'good']) store.setLocalMcpAutoStart(name, true);

    await manager.restoreAutoStart();
    const byName = new Map(manager.status().map((s) => [s.profile, s]));
    expect(byName.get('bad')?.status).toBe('error'); // recorded, not thrown
    expect(byName.get('bad')?.error).toMatch(/keychain refused/);
    expect(byName.get('dup')?.status).toBe('blocked-duplicate'); // skipped, no dialog
    expect(byName.get('good')?.status).toBe('running'); // loop continued to the end
  });
});
