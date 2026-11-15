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
  available: async () => true,
  encrypt: async (s) => `enc:${Buffer.from(s).toString('base64')}`,
  decrypt: async (b) => Buffer.from(b.slice(4), 'base64').toString(),
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

/** An encryptor whose decrypts wait for release() or fail(): the window in
 *  which a start is waiting on the keychain. */
function gatedEncryptor(): {
  encryptor: Encryptor;
  waiting: () => number;
  release: () => void;
  fail: (message: string) => void;
} {
  const gates: { open: () => void; refuse: (err: Error) => void }[] = [];
  return {
    encryptor: {
      ...fakeEncryptor,
      decrypt: (blob) =>
        new Promise((resolve, reject) => {
          gates.push({ open: () => resolve(Buffer.from(blob.slice(4), 'base64').toString()), refuse: reject });
        }),
    },
    waiting: () => gates.length,
    release: () => {
      for (const gate of gates.splice(0)) gate.open();
    },
    fail: (message) => {
      for (const gate of gates.splice(0)) gate.refuse(new Error(message));
    },
  };
}

function harness(encryptor: Encryptor = fakeEncryptor): {
  store: ProfileStore;
  manager: McpServerManager;
  children: FakeChild[];
  locators: FakeLocators;
  entry: (name: string) => McpStatusEntry | undefined;
} {
  const dir = mkdtempSync(join(tmpdir(), 'kozou-desktop-mcp-test-'));
  const store = new ProfileStore(dir, encryptor);
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

/** start() decrypts the password before it forks, and the decrypt is
 *  asynchronous, so the child appears a few microtasks after the call.
 *  Microtasks rather than a timer: vi.useFakeTimers() would freeze a timer. */
async function forkedChild(children: FakeChild[], index: number): Promise<FakeChild> {
  for (let i = 0; i < 50 && children[index] === undefined; i += 1) await Promise.resolve();
  const child = children[index];
  if (child === undefined) throw new Error(`child ${index} was never forked`);
  return child;
}

const BASE = { url: 'postgresql://u@h:5432/db', schemas: ['public'] };

describe('McpServerManager', () => {
  it('starts a server: env-only secret, argv-free message, running status, autoStart set', async () => {
    const { store, manager, children, entry } = harness();
    await store.upsert({ name: 'a', url: 'postgresql://app:s3cr3t@h:5432/db', schemas: ['public'] });
    const pending = manager.start('a');
    await forkedChild(children, 0);
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
    await store.upsert({ name: 'a', ...BASE });
    store.setMcpMode('off');
    const outcome = await manager.start('a');
    expect(outcome.outcome).toBe('not-local-mode');
    expect(children).toHaveLength(0);
  });

  it('blocks a duplicate of a declared remote MCP and honors override', async () => {
    const { store, manager, children } = harness();
    await store.upsert({ name: 'declared', url: 'postgresql://u@127.0.0.1/db', schemas: ['public'], remoteMcp: { declared: true } });
    await store.upsert({ name: 'a', url: 'postgresql://u@localhost:5432/db', schemas: ['public'] });
    const blocked = await manager.start('a');
    expect(blocked.outcome).toBe('blocked-duplicate');
    expect(blocked.duplicates).toEqual(['declared']);
    expect(children).toHaveLength(0);
    const pending = manager.start('a', { override: true });
    await forkedChild(children, 0);
    children[0]!.replyOk(3336);
    expect((await pending).outcome).toBe('started');
  });

  it('maps a stop during startup to stopped (not error) and clears autoStart', async () => {
    const { store, manager, children, entry } = harness();
    await store.upsert({ name: 'a', ...BASE });
    const pending = manager.start('a'); // no reply scheduled — still starting
    await forkedChild(children, 0);
    expect(entry('a')?.status).toBe('starting');
    await manager.stop('a');
    await pending;
    expect(entry('a')?.status).toBe('stopped');
    expect(entry('a')?.error).toBeUndefined();
    expect(entry('a')?.autoStart).toBe(false);
    expect(children[0]!.killed).toBe(true);
  });

  it('maps a profile edit during startup to stopped-profile-updated', async () => {
    const { store, manager, children, entry } = harness();
    await store.upsert({ name: 'a', ...BASE });
    const pending = manager.start('a');
    await forkedChild(children, 0);
    await manager.onProfileUpserted('a');
    await pending;
    expect(entry('a')?.status).toBe('stopped-profile-updated');
  });

  it('surfaces a crash as stopped-crashed with a sanitized stderr tail', async () => {
    const { store, manager, children, entry } = harness();
    await store.upsert({ name: 'a', url: 'postgresql://app:s3cr3t@h:5432/db', schemas: ['public'] });
    const pending = manager.start('a');
    await forkedChild(children, 0);
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
    await store.upsert({ name: 'a', ...BASE });
    const alloc = store.ensureLocalMcpAllocation('a');

    const started = manager.start('a');
    await forkedChild(children, 0);
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
    await forkedChild(children, 1);
    children[1]!.replyOk(alloc.port);
    await again;
    expect(locators.published.size).toBe(1);
    children[1]!.crash(1);
    expect(entry('a')?.status).toBe('stopped-crashed');
    expect(locators.published.size).toBe(0);

    // Quit sweep: synchronous, because the exit handler may not run.
    const third = manager.start('a');
    await forkedChild(children, 2);
    children[2]!.replyOk(alloc.port);
    await third;
    manager.killAllSync();
    expect(locators.published.size).toBe(0);
  });

  it('publishes nothing when a stop lands after the worker confirmed but before the start returns', async () => {
    const { store, manager, children, locators, entry } = harness();
    await store.upsert({ name: 'a', ...BASE });
    const pending = manager.start('a');
    await forkedChild(children, 0);
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
    await store.upsert({ name: 'a', ...BASE });
    locators.failWrite = 'read-only filesystem';
    const pending = manager.start('a');
    await forkedChild(children, 0);
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
      await store.upsert({ name: 'a', ...BASE });
      const started = manager.start('a');
      await forkedChild(children, 0);
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
    await store.upsert({ name: 'a', ...BASE });
    const first = store.ensureLocalMcpAllocation('a');
    const started = manager.start('a');
    await forkedChild(children, 0);
    children[0]!.replyOk(first.port);
    await started;
    expect(locators.published.has(first.bridgeId)).toBe(true);

    await manager.onProfileRemoved('a');
    store.remove('a');
    expect(locators.published.size).toBe(0);

    await store.upsert({ name: 'a', ...BASE });
    const second = store.ensureLocalMcpAllocation('a');
    expect(second.bridgeId).not.toBe(first.bridgeId);
  });

  it('maps EADDRINUSE to error-port-busy; reassign moves the port and needs a stopped server', async () => {
    const { store, manager, children, entry } = harness();
    await store.upsert({ name: 'a', ...BASE });
    await store.upsert({ name: 'b', ...BASE });
    const pending = manager.start('a');
    await forkedChild(children, 0);
    children[0]!.replyError('listen EADDRINUSE: address already in use 127.0.0.1:3335', true);
    const outcome = await pending;
    expect(outcome.outcome).toBe('error');
    expect(entry('a')?.status).toBe('error-port-busy');
    const after = manager.reassignPort('a');
    expect(after.find((s) => s.profile === 'a')?.port).toBe(3336);
    expect(entry('a')?.status).toBe('stopped');
    // A running server refuses reassignment.
    const runB = manager.start('b');
    await forkedChild(children, 1);
    children[1]!.replyOk(3337);
    await runB;
    expect(() => manager.reassignPort('b')).toThrow(/stop the server/);
  });

  it('stopAll preserves autoStart intents; explicit stop clears them', async () => {
    const { store, manager, children, entry } = harness();
    await store.upsert({ name: 'a', ...BASE });
    const pending = manager.start('a');
    await forkedChild(children, 0);
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
    await store.upsert({ name: 'bad', url: 'postgresql://u:pw@h:5432/db', schemas: ['public'] });
    await store.upsert({ name: 'dup', url: 'postgresql://u@h2:5432/db', schemas: ['public'] });
    await store.upsert({ name: 'declared', url: 'postgresql://u@h2:5432/db', schemas: ['public'], remoteMcp: { declared: true } });
    await store.upsert({ name: 'good', url: 'postgresql://u@h3:5432/db', schemas: ['public'] });
    for (const name of ['bad', 'dup', 'good']) store.setLocalMcpAutoStart(name, true);

    await manager.restoreAutoStart();
    const byName = new Map(manager.status().map((s) => [s.profile, s]));
    expect(byName.get('bad')?.status).toBe('error'); // recorded, not thrown
    expect(byName.get('bad')?.error).toMatch(/keychain refused/);
    expect(byName.get('dup')?.status).toBe('blocked-duplicate'); // skipped, no dialog
    expect(byName.get('good')?.status).toBe('running'); // loop continued to the end
  });
});

// The password is decrypted asynchronously before the fork, with the entry
// already registered as 'starting'. These pin what may happen in that window.
describe('McpServerManager while the password is being decrypted', () => {
  const URL = 'postgresql://app:s3cr3t@h:5432/db';

  it('answers a second start from the registered entry instead of forking twice', async () => {
    const gate = gatedEncryptor();
    const { store, manager, children, entry } = harness(gate.encryptor);
    await store.upsert({ name: 'a', url: URL, schemas: ['public'] });

    const first = manager.start('a');
    await Promise.resolve();
    expect(entry('a')?.status).toBe('starting');
    expect((await manager.start('a')).outcome).toBe('started'); // idempotent, as for a forked start
    gate.release();
    (await forkedChild(children, 0)).replyOk(3335);
    expect((await first).outcome).toBe('started');
    expect(children).toHaveLength(1);
    expect(entry('a')?.status).toBe('running');
  });

  it('never forks a server that was stopped during the decrypt', async () => {
    const stoppers: [string, (manager: McpServerManager) => unknown, string | undefined][] = [
      ['user stop', (m) => m.stop('a'), 'stopped'],
      ['profile edit', (m) => m.onProfileUpserted('a'), 'stopped-profile-updated'],
      ['mode switch', (m) => m.stopAll(), 'stopped'],
      ['quit', (m) => m.killAllSync(), 'stopped'],
      ['removal', (m) => m.onProfileRemoved('a'), undefined],
    ];
    for (const [label, stopper, status] of stoppers) {
      const gate = gatedEncryptor();
      const { store, manager, children, locators, entry } = harness(gate.encryptor);
      await store.upsert({ name: 'a', url: URL, schemas: ['public'] });

      const pending = manager.start('a');
      await Promise.resolve();
      await stopper(manager);
      gate.release();
      const outcome = await pending;
      expect(outcome, label).toMatchObject({ outcome: 'error', error: 'the server was stopped while starting' });
      expect(children, label).toHaveLength(0);
      expect(locators.published.size, label).toBe(0);
      if (status !== undefined) expect(entry('a')?.status, label).toBe(status);
      else expect(manager.status().find((s) => s.profile === 'a' && s.status !== 'stopped'), label).toBeUndefined();
    }
  });

  it('reports a keychain refusal on an interactive start and leaves the status as it was', async () => {
    const gate = gatedEncryptor();
    const { store, manager, children, entry } = harness(gate.encryptor);
    await store.upsert({ name: 'a', url: URL, schemas: ['public'] });

    const refused = manager.start('a');
    await Promise.resolve();
    gate.fail('keychain refused');
    await expect(refused).rejects.toThrow(/keychain refused/);
    expect(children).toHaveLength(0);
    expect(entry('a')?.status).toBe('stopped');
    expect(entry('a')?.autoStart).toBe(false);

    // Nothing is left behind that would make the next start a no-op.
    const retry = manager.start('a');
    await Promise.resolve();
    gate.release();
    (await forkedChild(children, 0)).replyOk(3335);
    expect((await retry).outcome).toBe('started');
  });
});
