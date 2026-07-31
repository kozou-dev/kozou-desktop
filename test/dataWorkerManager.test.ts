// State-machine tests for DataWorkerManager with an injected fake fork. What
// is pinned here is the lifecycle the row-data design depends on:
//
//   - the capability in force is read from the STORE on every call, and is
//     baked into the fork environment (never carried in a message);
//   - an 'off' profile is refused without forking anything;
//   - a grant change, a connection edit, a deletion and app quit all discard
//     the worker rather than reusing it at its old capability;
//   - a crash or a stop settles the requests in flight with a controlled
//     failure, and the worker's stderr never rides along in the reply.

import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DataWorkerManager,
  openBudgetMs,
  operationBudgetMs,
  type DataWorkerFork,
  type DataWorkerHandle,
} from '../src/main/dataWorkerManager.js';
import { ProfileStore, type Encryptor } from '../src/main/profileStore.js';
import { DATA_LOG_PREFIX, type DataResult, type DataWorkerInbound } from '../src/shared/types.js';

const fakeEncryptor: Encryptor = {
  available: () => true,
  encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`,
  decrypt: (b) => Buffer.from(b.slice(4), 'base64').toString(),
};

class FakeChild implements DataWorkerHandle {
  readonly em = new EventEmitter();
  readonly messages: DataWorkerInbound[] = [];
  killed = false;
  constructor(
    readonly modulePath: string,
    readonly options: { env: Record<string, string>; serviceName: string; stdio: 'pipe' },
  ) {}
  postMessage(message: unknown): void {
    this.messages.push(message as DataWorkerInbound);
  }
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.em.emit('exit', 0));
    return true;
  }
  on(event: 'message' | 'exit', listener: (arg: never) => void): unknown {
    this.em.on(event, listener as (...args: unknown[]) => void);
    return this;
  }
  stdout = { on: (_e: 'data', l: (chunk: unknown) => void): void => void this.em.on('stdout', l) };
  stderr = { on: (_e: 'data', l: (chunk: unknown) => void): void => void this.em.on('stderr', l) };

  opened(): void {
    this.em.emit('message', { type: 'opened', ok: true });
  }
  openFailed(error: string): void {
    this.em.emit('message', { type: 'opened', ok: false, error });
  }
  /** Reply to the nth run request this child received. */
  reply(index: number, result: DataResult): void {
    const runs = this.messages.filter((m) => m.type === 'run');
    const run = runs[index];
    if (run === undefined || run.type !== 'run') throw new Error('no such run request');
    this.em.emit('message', { type: 'result', id: run.id, result });
  }
  emitStderr(text: string): void {
    this.em.emit('stderr', text);
  }
  crash(code: number): void {
    this.em.emit('exit', code);
  }
}

function harness(): { store: ProfileStore; manager: DataWorkerManager; children: FakeChild[] } {
  const dir = mkdtempSync(join(tmpdir(), 'kozou-desktop-data-test-'));
  const store = new ProfileStore(dir, fakeEncryptor);
  const children: FakeChild[] = [];
  const fork: DataWorkerFork = (modulePath, options) => {
    const child = new FakeChild(modulePath, options);
    children.push(child);
    return child;
  };
  return { store, manager: new DataWorkerManager(store, () => '/out/dataWorker.js', fork), children };
}

const LIST = { kind: 'list', resource: 'customers' } as const;
const INSERT = { kind: 'insert', resource: 'customers', values: { name: 'Ada' } } as const;

/** Let the manager's fork + open handshake settle so the child exists. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('DataWorkerManager', () => {
  it('refuses a profile that is not opted in, without forking', async () => {
    const { store, manager, children } = harness();
    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/db', schemas: ['public'] });
    const result = await manager.run('a', LIST);
    expect(result).toEqual({
      ok: false,
      status: 403,
      code: 'forbidden',
      message: 'Row data access is not enabled for this profile.',
    });
    expect(children).toHaveLength(0);
  });

  it('forks with the secret and the capability in env only, and opens with schemas', async () => {
    const { store, manager, children } = harness();
    store.upsert({ name: 'a', url: 'postgresql://app:s3cr3t@h:5432/db', schemas: ['public'] });
    store.setRowAccess('a', 'read');

    const pending = manager.run('a', LIST);
    await settle();
    const child = children[0]!;
    expect(child.options.env.KOZOU_DESKTOP_DB_URL).toBe('postgresql://app:s3cr3t@h:5432/db');
    expect(child.options.env.KOZOU_DESKTOP_ROW_ACCESS).toBe('read');
    expect(child.options.serviceName).toBe('kozou-desktop-data');
    expect(child.messages[0]).toEqual({ type: 'open', schemas: ['public'] });
    expect(JSON.stringify(child.messages)).not.toContain('s3cr3t');

    child.opened();
    await settle();
    child.reply(0, { ok: true, status: 200, body: { rows: [] } });
    await expect(pending).resolves.toEqual({ ok: true, status: 200, body: { rows: [] } });
  });

  it('reuses the worker for a second operation at the same capability', async () => {
    const { store, manager, children } = harness();
    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/db', schemas: ['public'] });
    store.setRowAccess('a', 'readwrite');

    const first = manager.run('a', LIST);
    await settle();
    children[0]!.opened();
    await settle();
    children[0]!.reply(0, { ok: true, status: 200, body: { rows: [] } });
    await first;

    const second = manager.run('a', INSERT);
    await settle();
    expect(children).toHaveLength(1);
    children[0]!.reply(1, { ok: true, status: 201, body: { id: 1 } });
    await expect(second).resolves.toEqual({ ok: true, status: 201, body: { id: 1 } });
  });

  it('discards the worker when the grant changes, and forks the new capability', async () => {
    const { store, manager, children } = harness();
    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/db', schemas: ['public'] });
    store.setRowAccess('a', 'read');

    const first = manager.run('a', LIST);
    await settle();
    children[0]!.opened();
    await settle();
    children[0]!.reply(0, { ok: true, status: 200, body: { rows: [] } });
    await first;

    store.setRowAccess('a', 'readwrite');
    const second = manager.run('a', INSERT);
    await settle();
    expect(children).toHaveLength(2);
    expect(children[0]!.killed).toBe(true);
    expect(children[1]!.options.env.KOZOU_DESKTOP_ROW_ACCESS).toBe('readwrite');
    children[1]!.opened();
    await settle();
    children[1]!.reply(0, { ok: true, status: 201, body: { id: 2 } });
    await expect(second).resolves.toEqual({ ok: true, status: 201, body: { id: 2 } });
  });

  it('settles an in-flight request when the worker is discarded by an edit', async () => {
    const { store, manager, children } = harness();
    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/db', schemas: ['public'] });
    store.setRowAccess('a', 'read');

    const pending = manager.run('a', LIST);
    await settle();
    children[0]!.opened();
    await settle();
    manager.onProfileUpserted('a');

    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unavailable');
    expect(children[0]!.killed).toBe(true);
  });

  it('settles in-flight requests on a crash, and logs neither unprefixed output nor it in the reply', async () => {
    const { store, manager, children } = harness();
    store.upsert({ name: 'a', url: 'postgresql://app:s3cr3t@h:5432/db', schemas: ['public'] });
    store.setRowAccess('a', 'read');

    const logged: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        logged.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);

    const pending = manager.run('a', LIST);
    await settle();
    const child = children[0]!;
    child.opened();
    await settle();
    // Two kinds of output: something unexpected carrying a row value, and one
    // of the worker's own value-free breadcrumbs.
    child.emitStderr('detail: invalid input syntax for type date: "1999-99-99"\n');
    child.emitStderr(`${DATA_LOG_PREFIX} operation failed with status 500\n`);
    child.crash(9);
    await settle();
    spy.mockRestore();

    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unavailable');
    expect(result.message).not.toContain('1999-99-99');

    const log = logged.join('');
    // Negative control: the unprefixed line is gone from the log, counted only.
    expect(log).not.toContain('1999-99-99');
    expect(log).not.toContain('invalid input syntax');
    expect(log).toContain('1 unrecognized output line(s) suppressed');
    // The worker's own breadcrumb survives — that is what makes a crash
    // diagnosable at all.
    expect(log).toContain('operation failed with status 500');
    expect(log).toContain('worker exited (code 9)');

    // The crashed worker is gone: the next operation forks a fresh one.
    void manager.run('a', LIST);
    await settle();
    expect(children).toHaveLength(2);
  });

  it('scrubs the connection secret out of a worker line before it is logged', async () => {
    const { store, manager, children } = harness();
    store.upsert({ name: 'a', url: 'postgresql://app:s3cr3t@h:5432/db', schemas: ['public'] });
    store.setRowAccess('a', 'read');

    const logged: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        logged.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);

    const pending = manager.run('a', LIST);
    await settle();
    const child = children[0]!;
    child.opened();
    await settle();
    child.emitStderr(
      `${DATA_LOG_PREFIX} could not open a connection: postgresql://app:s3cr3t@h:5432/db\n`,
    );
    child.crash(1);
    await settle();
    spy.mockRestore();
    await pending;

    expect(logged.join('')).not.toContain('s3cr3t');
  });

  it("reports the worker's own startup failure, already sanitized", async () => {
    const { store, manager, children } = harness();
    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/db', schemas: ['public'] });
    store.setRowAccess('a', 'read');

    const pending = manager.run('a', LIST);
    await settle();
    children[0]!.openFailed('password authentication failed for user "app"');

    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unavailable');
    expect(result.message).toContain('password authentication failed');
  });

  it('recovers from a startup failure: the failed worker is dropped, the next call re-forks', async () => {
    const { store, manager, children } = harness();
    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/db', schemas: ['public'] });
    store.setRowAccess('a', 'read');

    // A transient failure (the database was down, the password prompt was
    // refused) must not become a tombstone: the worker stays resident on
    // failure by design, so the entry has to go.
    const failed = manager.run('a', LIST);
    await settle();
    children[0]!.openFailed('connection refused');
    await failed;
    await settle();
    expect(children[0]!.killed).toBe(true);

    // Second attempt after the database recovered.
    const retry = manager.run('a', LIST);
    await settle();
    expect(children).toHaveLength(2);
    children[1]!.opened();
    await settle();
    children[1]!.reply(0, { ok: true, status: 200, body: { rows: [] } });
    await expect(retry).resolves.toEqual({ ok: true, status: 200, body: { rows: [] } });
  });

  it('warns that a timed-out operation may still be running', async () => {
    // The 504 is a hang guard, not a cancellation — the message must not imply
    // the write was stopped, because it was not.
    vi.useFakeTimers();
    try {
      const { store, manager, children } = harness();
      store.upsert({ name: 'a', url: 'postgresql://u@h:5432/db', schemas: ['public'], timeoutMs: 1_000 });
      store.setRowAccess('a', 'readwrite');

      const pending = manager.run('a', INSERT);
      await vi.advanceTimersByTimeAsync(0);
      children[0]!.opened();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(operationBudgetMs(1_000) + 10);

      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(504);
      expect(result.message).toMatch(/may still be running/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills every worker on quit', async () => {
    const { store, manager, children } = harness();
    for (const name of ['a', 'b']) {
      store.upsert({ name, url: `postgresql://u@h:5432/${name}`, schemas: ['public'] });
      store.setRowAccess(name, 'read');
      const pending = manager.run(name, LIST);
      await settle();
      const child = children.at(-1)!;
      child.opened();
      await settle();
      child.reply(0, { ok: true, status: 200, body: { rows: [] } });
      await pending;
    }
    manager.killAllSync();
    expect(children.map((c) => c.killed)).toEqual([true, true]);
  });

  it('refuses a removed profile after its worker is dropped', async () => {
    const { store, manager, children } = harness();
    store.upsert({ name: 'a', url: 'postgresql://u@h:5432/db', schemas: ['public'] });
    store.setRowAccess('a', 'read');
    const pending = manager.run('a', LIST);
    await settle();
    children[0]!.opened();
    await settle();
    children[0]!.reply(0, { ok: true, status: 200, body: { rows: [] } });
    await pending;

    manager.onProfileRemoved('a');
    store.remove('a');
    const result = await manager.run('a', LIST);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unavailable');
    expect(result.message).toContain('unknown profile');
  });

  it('budgets a hang guard from the profile timeout, not a UX deadline', () => {
    expect(openBudgetMs(undefined)).toBe(10_000 * 16 + 15_000);
    expect(openBudgetMs(1_000)).toBe(1_000 * 16 + 15_000);
    expect(operationBudgetMs(undefined)).toBe(10_000 * 4 + 5_000);
    expect(operationBudgetMs(2_000)).toBe(2_000 * 4 + 5_000);
  });
});
