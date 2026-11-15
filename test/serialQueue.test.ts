import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProfileStore, type Encryptor } from '../src/main/profileStore.js';
import { createSerialQueue } from '../src/main/serialQueue.js';

describe('createSerialQueue', () => {
  it('starts each task only after the one before it has settled', async () => {
    const queue = createSerialQueue();
    const log: string[] = [];
    let releaseFirst = (): void => {};
    const first = queue(async () => {
      log.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      log.push('first:end');
      return 1;
    });
    const second = queue(async () => {
      log.push('second:start');
      return 2;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(['first:start']);
    releaseFirst();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(log).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('hands a rejection to its own caller and keeps running what follows', async () => {
    const queue = createSerialQueue();
    const failed = queue(async () => {
      throw new Error('keychain refused');
    });
    const next = queue(async () => 'ran');
    await expect(failed).rejects.toThrow(/keychain refused/);
    expect(await next).toBe('ran');
  });

  it('keeps a delete from being overtaken by a save that is waiting on the keychain', async () => {
    // The first save of a session waits for Chromium's encryptor to start —
    // on macOS, possibly behind a Keychain prompt — and IPC keeps running.
    let keychainReady = (): void => {};
    const ready = new Promise<void>((resolve) => {
      keychainReady = resolve;
    });
    const encryptor: Encryptor = {
      available: async () => {
        await ready;
        return true;
      },
      encrypt: async (s) => `enc:${Buffer.from(s).toString('base64')}`,
      decrypt: async (b) => Buffer.from(b.slice(4), 'base64').toString(),
    };
    const store = new ProfileStore(mkdtempSync(join(tmpdir(), 'kozou-desktop-queue-test-')), encryptor);
    await store.upsert({ name: 'a', url: 'postgresql://u@h:5432/db', schemas: ['public'] });

    const queue = createSerialQueue();
    const save = queue(() => store.upsert({ name: 'a', url: 'postgresql://u:pw@h:5432/db', schemas: ['public'] }));
    const remove = queue(async () => store.remove('a'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    keychainReady();
    await save;
    expect(await remove).toEqual([]);
    expect(store.list()).toEqual([]);
  });
});
