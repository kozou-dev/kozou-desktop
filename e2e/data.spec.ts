// End-to-end for the row-data channels: default-off refusal, a grant that only
// a native approval can persist, and one real round trip through the resident
// data worker (real utilityProcess, real introspection, real database).
//
// This is the only suite that exercises the whole path — preload -> main gate
// -> fork -> @kozou/api -> PostgreSQL — so it is what pins the wiring the unit
// suites can only cover a side of each.
//
// Requires: `pnpm build` first and a reachable PostgreSQL via
// KOZOU_TEST_DATABASE_URL (same provisioning as app.spec.ts).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { DataListParams, DataResult, RowAccess } from '../src/shared/types.js';

const url = process.env.KOZOU_TEST_DATABASE_URL;

test.skip(!url, 'KOZOU_TEST_DATABASE_URL not set');

type ApiWindow = {
  kozouDesktop: {
    requestRowAccess(name: string, level: RowAccess): Promise<RowAccess>;
    dataList(name: string, resource: string, params?: DataListParams): Promise<DataResult>;
    dataInsert(name: string, resource: string, values: Record<string, unknown>): Promise<DataResult>;
  };
};

// Every call below runs inside the page (page.evaluate serializes the
// function, so it cannot reference anything from this module) and reports a
// rejection as a value: a refusal is a normal outcome to assert on, not a test
// error. `globalThis === window` there; spelled this way because the e2e suite
// typechecks under the node tsconfig (no DOM lib).
type Outcome<T> = { resolved?: T; rejected?: string };

test('row data: refused while off, granted only by native approval, then a real round trip', async () => {
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

  // --- 1. every data channel is refused while the profile is off -----------
  const denied: Outcome<DataResult> = await page.evaluate(
    (p) =>
      (globalThis as unknown as ApiWindow).kozouDesktop.dataList(p, 'customers').then(
        (value) => ({ resolved: value }),
        (err: unknown) => ({ rejected: String(err) }),
      ),
    'rows',
  );
  expect(denied.rejected).toMatch(/row read access is not enabled/i);

  // --- 2. a grant needs the native dialog: a declined prompt changes nothing
  await app.evaluate(({ dialog }) => {
    // cancelId is 0 in the app's prompt, so a 0 response is a decline.
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never;
  });
  const declined: Outcome<RowAccess> = await page.evaluate(
    (p) =>
      (globalThis as unknown as ApiWindow).kozouDesktop.requestRowAccess(p, 'read').then(
        (value) => ({ resolved: value }),
        (err: unknown) => ({ rejected: String(err) }),
      ),
    'rows',
  );
  expect(declined.resolved).toBe('off');

  // --- 3. approve it, and the level is persisted ----------------------------
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as never;
  });
  const granted: Outcome<RowAccess> = await page.evaluate(
    (p) =>
      (globalThis as unknown as ApiWindow).kozouDesktop.requestRowAccess(p, 'read').then(
        (value) => ({ resolved: value }),
        (err: unknown) => ({ rejected: String(err) }),
      ),
    'rows',
  );
  expect(granted.resolved).toBe('read');

  // --- 4. a list now runs through the real resident worker ------------------
  const listed: Outcome<DataResult> = await page.evaluate(
    (p) =>
      (globalThis as unknown as ApiWindow).kozouDesktop.dataList(p, 'customers', { pageSize: 5 }).then(
        (value) => ({ resolved: value }),
        (err: unknown) => ({ rejected: String(err) }),
      ),
    'rows',
  );
  expect(listed.resolved?.ok).toBe(true);
  const body = (listed.resolved as { body: { rows: unknown[]; total: unknown } }).body;
  expect(Array.isArray(body.rows)).toBe(true);
  expect(body.rows.length).toBeGreaterThan(0);
  expect(body.total).toBeNull();

  // --- 5. a mutation is still refused: 'read' is not 'readwrite' ------------
  const write: Outcome<DataResult> = await page.evaluate(
    (p) =>
      (globalThis as unknown as ApiWindow).kozouDesktop
        .dataInsert(p, 'customers', { name: 'must not land' })
        .then(
          (value) => ({ resolved: value }),
          (err: unknown) => ({ rejected: String(err) }),
        ),
    'rows',
  );
  expect(write.rejected).toMatch(/row readwrite access is not enabled/i);

  await app.close();
});
