// End-to-end for the row editor: the write half of the Data tab, as an
// operator reaches it.
//
// What is worth proving here is what no unit test can:
//
//   * editing is its own grant. Browsing does not carry it, the escalation is
//     its own native prompt, and until it is approved the panel offers no write
//     control at all;
//   * the round trip actually reaches the database — insert, then the row is
//     there; update, then the change is there; delete, then it is gone;
//   * a value the driver would reinterpret survives the trip as itself (a
//     `date` is the case: parsed into an instant it names the previous day
//     under any clock behind UTC);
//   * a refusal is shown as the controlled sentence, without the row values
//     that caused it;
//   * the relations that cannot be addressed offer nothing: a view (kozou
//     answers 405) and a table with no primary key (there is no id).
//
// Requires: `pnpm build` first and a reachable PostgreSQL via
// KOZOU_TEST_DATABASE_URL (same provisioning as app.spec.ts).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { Client } from 'pg';

const url = process.env.KOZOU_TEST_DATABASE_URL;

test.skip(!url, 'KOZOU_TEST_DATABASE_URL not set');

/** Every row this suite writes carries one of these addresses, so cleanup can
 *  find them even when a test fails half way through. `customers.email` is
 *  UNIQUE, which is also what makes the conflict section possible. */
const MARK = 'e2e-crud@example.test';
const SECOND_MARK = 'e2e-crud-2@example.test';

/** A calendar date typed into the form and read back out of the grid. The
 *  driver's default parser would turn this into an instant at local midnight —
 *  `2026-07-31T15:00:00.000Z` under a UTC+9 clock — so a cell still reading
 *  `2026-08-01` is the round trip staying on the day it was given. */
const BIRTHDAY = '2026-08-01';

/** Counter the dialog stubs keep in the MAIN process, so "the prompt happened"
 *  is a claim about main rather than about the level looking right. */
type PromptCounter = { __prompts: number };

let seeder: Client;

test.beforeAll(async () => {
  seeder = new Client({ connectionString: url });
  await seeder.connect();
  await cleanup();
});

test.afterAll(async () => {
  await cleanup();
  await seeder.end();
});

async function cleanup(): Promise<void> {
  await seeder.query('DELETE FROM customers WHERE email = ANY($1)', [[MARK, SECOND_MARK]]);
}

function prompts(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as PromptCounter).__prompts);
}

function firstRow(page: Page): Locator {
  return page.getByTestId('data-grid').locator('tbody tr').first();
}

/** Launch the built app on a fresh user-data directory with one profile whose
 *  row access is still off, and dialogs stubbed to count their prompts and
 *  approve. */
async function launchWithProfile(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkdtempSync(join(tmpdir(), 'kozou-desktop-e2e-crud-'));
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, KOZOU_DESKTOP_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  const nameInput = page.getByPlaceholder('name', { exact: true });
  await expect(async () => {
    if (!(await nameInput.isVisible())) await page.getByTestId('add-toggle').click();
    await expect(nameInput).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await nameInput.fill(name);
  await page.getByPlaceholder('postgresql://user:password@host:5432/db').fill(url!);
  await page.getByPlaceholder('schemas (comma-separated)').fill('public');
  await page.getByRole('button', { name: 'Save profile' }).click();
  // The rail, not the card: saving auto-inspects, which selects the profile, and
  // the card grid is the all-databases view — not on screen while one is selected.
  await expect(page.getByTestId(`rail-${name}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('inspect-stats')).toBeVisible({ timeout: 60_000 });

  await app.evaluate(({ dialog }) => {
    (globalThis as unknown as PromptCounter).__prompts = 0;
    dialog.showMessageBox = (async () => {
      (globalThis as unknown as PromptCounter).__prompts += 1;
      return { response: 1, checkboxChecked: false };
    }) as never;
  });

  return { app, page };
}

test('row editing: a grant of its own, a real round trip, and controlled refusals', async () => {
  const { app, page } = await launchWithProfile('edit');
  const badge = page.getByTestId('rowaccess-badge-edit');

  try {
    // --- browsing does not carry editing ------------------------------------
    await page.getByTestId('rowaccess-enable-edit').click();
    await expect(badge).toHaveText('rows: browsing');
    await expect.poll(() => prompts(app)).toBe(1);

    await page.getByTestId('map-node-public.customers').click({ timeout: 30_000 });
    await expect(page.getByTestId('detail-pane')).toContainText('public.customers');
    await page.getByTestId('tab-data').click();
    await expect(page.getByTestId('data-grid')).toBeVisible({ timeout: 30_000 });
    // The browse panel is up and the grant is real, so an absent write control
    // here is the grant being respected rather than the panel not being ready.
    await expect(page.getByTestId('data-new')).toHaveCount(0);
    await expect(page.getByTestId('row-edit-0')).toHaveCount(0);

    // --- editing is its own approval ----------------------------------------
    await page.getByTestId('rowaccess-edit-edit').click();
    await expect(badge).toHaveText('rows: editing');
    await expect.poll(() => prompts(app)).toBe(2);

    await page.getByTestId('tab-data').click();
    const grid = page.getByTestId('data-grid');
    await expect(grid).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('data-new')).toBeVisible();

    // Newest first, so a row inserted below lands at the top of the page under
    // a sort the database applied rather than one this test assumed.
    await page.getByTestId('data-sort-column').selectOption('id');
    await page.getByTestId('data-sort-dir').selectOption('desc');
    await expect(page.getByTestId('data-error')).toHaveCount(0);

    // --- insert --------------------------------------------------------------
    await page.getByTestId('data-new').click();
    await expect(page.getByTestId('row-form-mode')).toHaveText('New row');
    await page.getByTestId('field-name').fill('Crud One');
    await page.getByTestId('field-email').fill(MARK);
    await page.getByTestId('field-birthday').fill(BIRTHDAY);
    await page.getByTestId('row-form-save').click();

    await expect(page.getByTestId('data-notice')).toHaveText('Row inserted.');
    await expect(page.getByTestId('row-form')).toHaveCount(0);
    await expect(firstRow(page)).toContainText('Crud One');
    await expect(firstRow(page)).toContainText(MARK);
    // The date reads as the day that was typed. Parsed into an instant it would
    // read 2026-07-31 here on any clock behind UTC.
    await expect(firstRow(page)).toContainText(BIRTHDAY);

    // --- update: seeded from the row, sends only what changed ----------------
    await page.getByTestId('row-edit-0').click();
    await expect(page.getByTestId('row-form-mode')).toHaveText('Edit row');
    // The form was seeded from a fresh read of the row, not from the page.
    await expect(page.getByTestId('field-name')).toHaveValue('Crud One');
    await expect(page.getByTestId('field-birthday')).toHaveValue(BIRTHDAY);
    // The key addressing the row is not offered as an editable field.
    await expect(page.getByTestId('field-locked-id')).toBeVisible();
    await expect(page.getByTestId('field-id')).toHaveCount(0);

    await page.getByTestId('field-name').fill('Crud Renamed');
    await page.getByTestId('row-form-save').click();
    await expect(page.getByTestId('data-notice')).toHaveText('Row updated.');
    await expect(firstRow(page)).toContainText('Crud Renamed');
    // The date came through the edit unchanged. This catches a mangled seed
    // being written back; that only touched fields are sent at all is a payload
    // property, pinned where the payload is built (test/rowForm.test.ts).
    await expect(firstRow(page)).toContainText(BIRTHDAY);

    // --- a refusal is a controlled sentence ----------------------------------
    // The same address again: customers.email is UNIQUE, so this is a 23505 the
    // worker re-authors. The message must not carry the value that collided.
    await page.getByTestId('data-new').click();
    await page.getByTestId('field-name').fill('Crud Duplicate');
    await page.getByTestId('field-email').fill(MARK);
    await page.getByTestId('row-form-save').click();
    const formError = page.getByTestId('row-form-error');
    await expect(formError).toBeVisible();
    await expect(formError).toContainText('conflicts with existing data');
    await expect(formError).not.toContainText(MARK);
    // The form stays open with the input in it: a failed save is something to
    // correct, not something to retype.
    await expect(page.getByTestId('field-name')).toHaveValue('Crud Duplicate');
    await page.getByTestId('row-form-cancel').click();
    await expect(page.getByTestId('row-form')).toHaveCount(0);

    // --- a required column left empty is named, and still attempted ----------
    // The form warns about a NOT NULL column with no default of its own - the
    // database's own answer names no column - but it does not refuse: only
    // PostgreSQL knows whether a trigger or a domain default fills it in.
    await page.getByTestId('data-new').click();
    await page.getByTestId('field-email').fill(SECOND_MARK);
    await page.getByTestId('row-form-save').click();
    await expect(page.getByTestId('row-form-warning')).toContainText('name');
    // It was attempted and the database refused it, so no row carries that
    // address - the warning is a warning, not a claim that nothing was sent.
    await expect(page.getByTestId('row-form-error')).toBeVisible();
    const stray = await seeder.query('SELECT count(*)::int AS n FROM customers WHERE email = $1', [
      SECOND_MARK,
    ]);
    expect(stray.rows[0]!.n).toBe(0);
    await page.getByTestId('row-form-cancel').click();

    // --- delete takes two clicks ---------------------------------------------
    await page.getByTestId('row-delete-0').click();
    await expect(page.getByTestId('row-delete-confirm-0')).toBeVisible();
    // Backing out leaves the row alone.
    await page.getByTestId('row-delete-cancel-0').click();
    await expect(page.getByTestId('row-delete-confirm-0')).toHaveCount(0);
    await expect(firstRow(page)).toContainText('Crud Renamed');

    await page.getByTestId('row-delete-0').click();
    await page.getByTestId('row-delete-confirm-0').click();
    await expect(page.getByTestId('data-notice')).toHaveText('Row deleted.');
    await expect(page.getByTestId('data-grid')).not.toContainText('Crud Renamed');
    // The database agrees, which is the only version of "deleted" that counts.
    const gone = await seeder.query('SELECT count(*)::int AS n FROM customers WHERE email = $1', [
      MARK,
    ]);
    expect(gone.rows[0]!.n).toBe(0);

    // --- a view offers no write UI -------------------------------------------
    await page.getByTestId('map-node-public.recent_orders').click();
    await expect(page.getByTestId('detail-pane')).toContainText('public.recent_orders');
    await page.getByTestId('tab-data').click();
    await expect(page.getByTestId('data-panel')).toBeVisible();
    await expect(page.getByTestId('data-new')).toHaveCount(0);
    await expect(page.getByTestId('row-edit-0')).toHaveCount(0);

    // --- nor a row whose key the page had to shorten -------------------------
    // The budget cuts every oversized value a page carries, keys included. What
    // is on screen is then the beginning of a key, which can be another row's
    // key in full - so this row offers no controls at all, while the table
    // itself still accepts a new row.
    await page.getByTestId('map-node-public.long_key').click();
    await expect(page.getByTestId('detail-pane')).toContainText('public.long_key');
    await page.getByTestId('tab-data').click();
    await expect(page.getByTestId('data-truncated')).toBeVisible();
    await expect(page.getByTestId('row-unaddressable-0')).toBeVisible();
    await expect(page.getByTestId('row-edit-0')).toHaveCount(0);
    await expect(page.getByTestId('row-delete-0')).toHaveCount(0);
    await expect(page.getByTestId('data-new')).toBeVisible();

    // --- neither does a table with no primary key ----------------------------
    await page.getByTestId('map-node-public.audit_log').click();
    await expect(page.getByTestId('detail-pane')).toContainText('public.audit_log');
    await page.getByTestId('tab-data').click();
    await expect(page.getByTestId('data-no-keyset')).toBeVisible();
    // Its rows are really there: the absent editor is about the missing key,
    // not about a panel that failed to load.
    await expect(page.getByTestId('data-grid').locator('tbody tr').first()).toBeVisible();
    await expect(page.getByTestId('data-new')).toHaveCount(0);
    await expect(page.getByTestId('row-edit-0')).toHaveCount(0);

    // --- revoking takes the editor away --------------------------------------
    await page.getByTestId('map-node-public.customers').click();
    await page.getByTestId('tab-data').click();
    await expect(page.getByTestId('data-new')).toBeVisible();
    await page.getByTestId('rowaccess-off-edit').click();
    await expect(badge).toHaveText('rows: off');
    await expect(page.getByTestId('tab-data')).toHaveCount(0);
    await expect(page.getByTestId('data-panel')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
