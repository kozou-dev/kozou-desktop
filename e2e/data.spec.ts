// End-to-end for the row-data channels: default-off refusal on every channel, a
// grant that only a native approval can persist, and a full CRUD round trip
// through the resident data worker (real utilityProcess, real introspection,
// real database).
//
// This is the only suite that exercises the whole path — preload -> main gate ->
// fork -> @kozou/api -> PostgreSQL. The unit suites each cover one side of a
// seam, so a channel wired to the wrong IPC name would pass all of them: that is
// exactly what the traversal below is here to catch, which is why every one of
// the five channels is called, and why the mutations are called both while the
// profile is read-only (refused) and after a readwrite grant (applied).
//
// Requires: `pnpm build` first and a reachable PostgreSQL via
// KOZOU_TEST_DATABASE_URL (same provisioning as app.spec.ts).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { DataResult, RowAccess } from '../src/shared/types.js';

const url = process.env.KOZOU_TEST_DATABASE_URL;

test.skip(!url, 'KOZOU_TEST_DATABASE_URL not set');

/** Marker on the row this test creates, so a failed run leaves something
 *  identifiable rather than an anonymous leftover. */
const MARK = 'e2e-row-data@example.test';

type Call =
  | { channel: 'list'; resource: string; pageSize?: number }
  | { channel: 'get'; resource: string; id: string }
  | { channel: 'insert'; resource: string; values: Record<string, unknown> }
  | { channel: 'update'; resource: string; id: string; values: Record<string, unknown> }
  | { channel: 'delete'; resource: string; id: string }
  | { channel: 'grant'; level: RowAccess };

/** Outcome of a preload call, with a rejection turned into an assertable value
 *  rather than a thrown error (a refusal is a normal outcome to check). */
type Outcome = { resolved?: DataResult | RowAccess; rejected?: string };

/** Drive one preload method inside the page. The dispatch lives in the page
 *  (page.evaluate serializes the function, so it cannot reference this module),
 *  and `globalThis === window` there — spelled that way because the e2e suite
 *  typechecks under the node tsconfig, which has no DOM lib. */
function call(page: Page, profile: string, c: Call): Promise<Outcome> {
  return page.evaluate(
    ({ profile: name, c: args }) => {
      const api = (
        globalThis as unknown as {
          kozouDesktop: Record<string, (...a: unknown[]) => Promise<unknown>>;
        }
      ).kozouDesktop;
      const invoke = (): Promise<unknown> => {
        switch (args.channel) {
          case 'list':
            return api.dataList!(name, args.resource, { pageSize: args.pageSize ?? 5 });
          case 'get':
            return api.dataGet!(name, args.resource, args.id);
          case 'insert':
            return api.dataInsert!(name, args.resource, args.values);
          case 'update':
            return api.dataUpdate!(name, args.resource, args.id, args.values);
          case 'delete':
            return api.dataDelete!(name, args.resource, args.id);
          case 'grant':
            return api.requestRowAccess!(name, args.level);
        }
      };
      return invoke().then(
        (value) => ({ resolved: value }),
        (err: unknown) => ({ rejected: String(err) }),
      );
    },
    { profile, c },
  ) as Promise<Outcome>;
}

function asResult(outcome: Outcome): DataResult {
  expect(outcome.rejected, 'expected the call to resolve').toBeUndefined();
  return outcome.resolved as DataResult;
}

function rowOf(result: DataResult): Record<string, unknown> {
  expect(result.ok, `expected ok, got ${JSON.stringify(result)}`).toBe(true);
  return (result.ok ? result.body : {}) as Record<string, unknown>;
}

test('row data: every channel refused while off, granted by native approval, full round trip', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'kozou-desktop-e2e-data-'));
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, KOZOU_DESKTOP_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // --- add a profile (row access is off for every new profile) --------------
  const nameInput = page.getByPlaceholder('name', { exact: true });
  await expect(async () => {
    if (!(await nameInput.isVisible())) await page.getByTestId('add-toggle').click();
    await expect(nameInput).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await nameInput.fill('rows');
  await page.getByPlaceholder('postgresql://user:password@host:5432/db').fill(url!);
  await page.getByPlaceholder('schemas (comma-separated)').fill('public');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByTestId('card-rows')).toBeVisible({ timeout: 15_000 });

  // --- 1. all five channels are refused while the profile is off ------------
  const offCalls: Call[] = [
    { channel: 'list', resource: 'customers' },
    { channel: 'get', resource: 'customers', id: '1' },
    { channel: 'insert', resource: 'customers', values: { name: 'must not land' } },
    { channel: 'update', resource: 'customers', id: '1', values: { name: 'must not land' } },
    { channel: 'delete', resource: 'customers', id: '1' },
  ];
  for (const c of offCalls) {
    const outcome = await call(page, 'rows', c);
    expect(outcome.rejected, `channel ${c.channel} must be refused while off`).toMatch(
      /row (read|readwrite) access is not enabled/i,
    );
  }

  // --- 2. a grant needs the native dialog: a declined prompt changes nothing
  await app.evaluate(({ dialog }) => {
    // cancelId is 0 in the app's prompt, so a 0 response is a decline.
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never;
  });
  expect((await call(page, 'rows', { channel: 'grant', level: 'read' })).resolved).toBe('off');

  // --- 3. approve 'read': reads work, mutations are still refused -----------
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as never;
  });
  expect((await call(page, 'rows', { channel: 'grant', level: 'read' })).resolved).toBe('read');

  const listed = asResult(await call(page, 'rows', { channel: 'list', resource: 'customers' }));
  expect(listed.ok).toBe(true);
  const page1 = (listed.ok ? listed.body : {}) as { rows: unknown[]; total: unknown };
  expect(page1.rows.length).toBeGreaterThan(0);
  expect(page1.total).toBeNull();

  for (const c of offCalls.slice(2)) {
    const outcome = await call(page, 'rows', c);
    expect(outcome.rejected, `${c.channel} must need readwrite`).toMatch(
      /row readwrite access is not enabled/i,
    );
  }

  // --- 4. approve 'readwrite': the mutations traverse to the database -------
  expect((await call(page, 'rows', { channel: 'grant', level: 'readwrite' })).resolved).toBe(
    'readwrite',
  );

  const created = rowOf(
    asResult(
      await call(page, 'rows', {
        channel: 'insert',
        resource: 'customers',
        values: { name: 'E2E row', email: MARK },
      }),
    ),
  );
  const id = String(created.id);
  expect(created.name).toBe('E2E row');

  const fetched = rowOf(asResult(await call(page, 'rows', { channel: 'get', resource: 'customers', id })));
  expect(fetched.email).toBe(MARK);

  const updated = rowOf(
    asResult(
      await call(page, 'rows', {
        channel: 'update',
        resource: 'customers',
        id,
        values: { name: 'E2E row renamed' },
      }),
    ),
  );
  expect(updated.name).toBe('E2E row renamed');

  expect(asResult(await call(page, 'rows', { channel: 'delete', resource: 'customers', id })).ok).toBe(
    true,
  );

  const gone = asResult(await call(page, 'rows', { channel: 'get', resource: 'customers', id }));
  expect(gone.ok).toBe(false);
  if (!gone.ok) {
    expect(gone.status).toBe(404);
    expect(gone.message).not.toContain(id);
  }

  // --- 5. revoking is prompt-free and takes effect immediately -------------
  expect((await call(page, 'rows', { channel: 'grant', level: 'off' })).resolved).toBe('off');
  expect((await call(page, 'rows', { channel: 'list', resource: 'customers' })).rejected).toMatch(
    /row read access is not enabled/i,
  );

  await app.close();
});
