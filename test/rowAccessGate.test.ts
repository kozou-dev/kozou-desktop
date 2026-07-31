import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProfileStore, type Encryptor } from '../src/main/profileStore.js';
import { assertRowAccess, requestRowAccessChange, type RowAccessApproval } from '../src/main/rowAccessGate.js';

const fakeEncryptor: Encryptor = {
  available: () => true,
  encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`,
  decrypt: (b) => Buffer.from(b.slice(4), 'base64').toString(),
};

const base = { url: 'postgresql://u@h:5432/db', schemas: ['public'] };

function freshStore(): ProfileStore {
  const store = new ProfileStore(mkdtempSync(join(tmpdir(), 'kozou-desktop-test-')), fakeEncryptor);
  store.upsert({ name: 'a', ...base });
  return store;
}

type ApprovalRequest = { profile: string; level: 'read' | 'readwrite'; connection: string };

/** Records what the native dialog would have been asked, and answers with a
 *  canned verdict. `during` stands in for everything that can happen while a
 *  real dialog is open: it does not block main's event loop, so the profile
 *  handlers keep running. */
function approver(
  verdict: boolean,
  during?: () => void,
): RowAccessApproval & { calls: ApprovalRequest[] } {
  const calls: ApprovalRequest[] = [];
  const fn = (request: ApprovalRequest): Promise<boolean> => {
    calls.push({ ...request });
    during?.();
    return Promise.resolve(verdict);
  };
  return Object.assign(fn, { calls });
}

describe('requestRowAccessChange (escalation requires native approval)', () => {
  it('does not persist an escalation the user declined', async () => {
    const store = freshStore();
    const declined = approver(false);
    expect(await requestRowAccessChange(store, declined, 'a', 'readwrite')).toBe('off');
    expect(store.rowAccess('a')).toBe('off');
    expect(declined.calls).toEqual([{ profile: 'a', level: 'readwrite', connection: base.url }]);
    // The same holds for the intermediate level, and from a granted level.
    expect(await requestRowAccessChange(store, declined, 'a', 'read')).toBe('off');
    expect(store.rowAccess('a')).toBe('off');
    store.setRowAccess('a', 'read');
    expect(await requestRowAccessChange(store, declined, 'a', 'readwrite')).toBe('read');
    expect(store.rowAccess('a')).toBe('read');
  });

  it('persists an approved escalation and reports the level in force', async () => {
    const store = freshStore();
    const approved = approver(true);
    expect(await requestRowAccessChange(store, approved, 'a', 'read')).toBe('read');
    expect(store.rowAccess('a')).toBe('read');
    expect(await requestRowAccessChange(store, approved, 'a', 'readwrite')).toBe('readwrite');
    expect(store.rowAccess('a')).toBe('readwrite');
    // The prompt is told which database the grant would reach, so the user
    // approves a connection rather than a renderer-chosen label.
    expect(approved.calls).toEqual([
      { profile: 'a', level: 'read', connection: base.url },
      { profile: 'a', level: 'readwrite', connection: base.url },
    ]);
  });

  it('applies downgrades and no-ops without prompting', async () => {
    const store = freshStore();
    store.setRowAccess('a', 'readwrite');
    const never = approver(false);
    expect(await requestRowAccessChange(store, never, 'a', 'read')).toBe('read');
    expect(await requestRowAccessChange(store, never, 'a', 'off')).toBe('off');
    expect(store.rowAccess('a')).toBe('off');
    // Requesting the level already in force is a no-op, not a prompt.
    expect(await requestRowAccessChange(store, never, 'a', 'off')).toBe('off');
    store.setRowAccess('a', 'read');
    expect(await requestRowAccessChange(store, never, 'a', 'read')).toBe('read');
    expect(never.calls).toEqual([]);
  });

  it('rejects junk input before any prompt reaches the user', async () => {
    const store = freshStore();
    const never = approver(true);
    for (const junk of ['write', 'ON', true, 1, null, undefined]) {
      await expect(requestRowAccessChange(store, never, 'a', junk)).rejects.toThrow(/rowAccess must be/);
    }
    await expect(requestRowAccessChange(store, never, ['a'], 'read')).rejects.toThrow(/name must be a string/);
    await expect(requestRowAccessChange(store, never, 'nope', 'read')).rejects.toThrow(/unknown profile/);
    expect(never.calls).toEqual([]);
    expect(store.rowAccess('a')).toBe('off');
  });

  it('refuses to grant when the profile was swapped while the dialog was open', async () => {
    // A dialog does not block main's event loop: the profile handlers keep
    // serving the renderer. Substituting the record behind the same name
    // would otherwise land the approval on a database the user never saw —
    // by delete-and-recreate, by an in-place edit of the connection, or by
    // widening the schemas the grant reaches. Each starts from its own
    // store, since the first substitution would otherwise become the
    // baseline for the next.
    const substitutions: ((store: ProfileStore) => void)[] = [
      (store) => {
        store.remove('a');
        store.upsert({ name: 'a', url: 'postgresql://u@elsewhere:5432/other', schemas: ['public'] });
      },
      (store) => store.upsert({ name: 'a', url: 'postgresql://u@elsewhere:5432/other', schemas: ['public'] }),
      (store) => store.upsert({ name: 'a', ...base, schemas: ['public', 'sales'] }),
      (store) => store.upsert({ name: 'a', url: 'postgresql://u:pw@h:5432/db', schemas: ['public'] }),
    ];
    for (const substitute of substitutions) {
      const store = freshStore();
      const swap = approver(true, () => substitute(store));
      await expect(requestRowAccessChange(store, swap, 'a', 'readwrite')).rejects.toThrow(
        /changed while its approval/,
      );
      expect(store.rowAccess('a')).toBe('off');
      expect(swap.calls[0]!.connection).toBe(base.url);
    }
    // Deleting outright fails closed too, rather than resurrecting a record.
    const store = freshStore();
    const deleted = approver(true, () => store.remove('a'));
    await expect(requestRowAccessChange(store, deleted, 'a', 'read')).rejects.toThrow(/unknown profile/);
  });

  it('reports the level in force when a concurrent change outruns a declined dialog', async () => {
    const store = freshStore();
    store.setRowAccess('a', 'read');
    // Escalation is declined, but a second request revoked the grant while
    // the dialog was open — returning the level captured beforehand would
    // tell the renderer it still has 'read'.
    const declined = approver(false, () => store.setRowAccess('a', 'off'));
    expect(await requestRowAccessChange(store, declined, 'a', 'readwrite')).toBe('off');
    expect(store.rowAccess('a')).toBe('off');
  });

  it('decides on the stored level, not on what the renderer believes', async () => {
    const store = freshStore();
    const approved = approver(true);
    await requestRowAccessChange(store, approved, 'a', 'readwrite');
    // A second request for the level already stored must not re-prompt even
    // though the caller repeated it — the store is the single source.
    expect(await requestRowAccessChange(store, approved, 'a', 'readwrite')).toBe('readwrite');
    expect(approved.calls).toHaveLength(1);
  });
});

describe('assertRowAccess (main-side guard for data:* IPC)', () => {
  it('refuses every level of row work on an opted-out profile', () => {
    const store = freshStore();
    expect(() => assertRowAccess(store, 'a', 'read')).toThrow(/not enabled/);
    expect(() => assertRowAccess(store, 'a', 'readwrite')).toThrow(/not enabled/);
  });

  it('lets read through at read, and write only at readwrite', () => {
    const store = freshStore();
    store.setRowAccess('a', 'read');
    expect(assertRowAccess(store, 'a', 'read')).toBe('read');
    expect(() => assertRowAccess(store, 'a', 'readwrite')).toThrow(/not enabled/);
    store.setRowAccess('a', 'readwrite');
    expect(assertRowAccess(store, 'a', 'read')).toBe('readwrite');
    expect(assertRowAccess(store, 'a', 'readwrite')).toBe('readwrite');
  });

  it('refuses junk on disk and unknown profiles rather than assuming a level', () => {
    const store = freshStore();
    store.setRowAccess('a', 'readwrite');
    expect(() => assertRowAccess(store, 'nope', 'read')).toThrow(/unknown profile/);
    expect(() => assertRowAccess(store, ['a'] as unknown as string, 'read')).toThrow(/name must be a string/);
  });

  it('refuses an unrecognized required level instead of waving it through', () => {
    const store = freshStore();
    // A future caller computing `need` must not be able to satisfy the guard
    // with a value outside the ladder — an unknown level compares as neither
    // greater nor smaller.
    for (const need of ['write', 'all', '', undefined, null]) {
      expect(() => assertRowAccess(store, 'a', need as unknown as 'read')).toThrow(/must be "read" or "readwrite"/);
    }
    store.setRowAccess('a', 'readwrite');
    expect(() => assertRowAccess(store, 'a', 'admin' as unknown as 'read')).toThrow(/must be "read" or "readwrite"/);
  });
});
