// End-to-end for the Data tab: the row browser as an operator reaches it, not
// as the preload API sees it (that is data.spec.ts). What is worth proving here
// is the wiring the UI owns — the grant is legible on the card whether or not
// it is granted, the tab is offered only when it is, the cursor handed back by
// one page is what fetches the next, and changing the sort restarts the
// traversal instead of replaying a cursor the new ORDER BY would reject.
//
// Requires: `pnpm build` first and a reachable PostgreSQL via
// KOZOU_TEST_DATABASE_URL (same provisioning as app.spec.ts).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test';
import { Client } from 'pg';

const url = process.env.KOZOU_TEST_DATABASE_URL;

test.skip(!url, 'KOZOU_TEST_DATABASE_URL not set');

/** The fixture holds two customers, which is one page however small the pager
 *  gets. Paging needs more rows than the smallest page size on offer, and they
 *  are seeded directly rather than through the app: this suite is about the
 *  read path, and granting write access to arrange it would prove nothing. */
const SEED_PREFIX = 'e2e-browse-';
const SEED_COUNT = 12;
const PAGE_SIZE = 10;

/** Cells of the first row. `id` identifies which page is on screen; `name`
 *  identifies which ORDER BY produced it. Both are asserted with retrying
 *  matchers: a control that does not change the page counter (a direction flip,
 *  say) would otherwise be read before its rows land. */
function firstCell(page: Page): Locator {
  return page.getByTestId('data-grid').locator('tbody tr').first().locator('td').first();
}

function firstName(page: Page): Locator {
  return page.getByTestId('data-grid').locator('tbody tr').first().locator('td').nth(1);
}

test('data tab: gated by the grant, browses rows, and pages by cursor', async () => {
  const seeder = new Client({ connectionString: url });
  await seeder.connect();
  await seeder.query('DELETE FROM customers WHERE email LIKE $1', [`${SEED_PREFIX}%`]);
  await seeder.query(
    `INSERT INTO customers (name, email)
     SELECT 'Browse ' || lpad(i::text, 2, '0'), $1 || lpad(i::text, 2, '0') || '@example.test'
     FROM generate_series(1, $2) AS i`,
    [SEED_PREFIX, SEED_COUNT],
  );

  const userData = mkdtempSync(join(tmpdir(), 'kozou-desktop-e2e-browse-'));
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, KOZOU_DESKTOP_USER_DATA: userData },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    const nameInput = page.getByPlaceholder('name', { exact: true });
    await expect(async () => {
      if (!(await nameInput.isVisible())) await page.getByTestId('add-toggle').click();
      await expect(nameInput).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    await nameInput.fill('browse');
    await page.getByPlaceholder('postgresql://user:password@host:5432/db').fill(url!);
    await page.getByPlaceholder('schemas (comma-separated)').fill('public');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByTestId('card-browse')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('inspect-stats')).toBeVisible({ timeout: 60_000 });

    // --- the level is on the card before anything is granted -----------------
    const badge = page.getByTestId('rowaccess-badge-browse');
    await expect(badge).toHaveText('rows: off');

    await page.getByTestId('map-node-public.customers').click({ timeout: 30_000 });
    await expect(page.getByTestId('detail-pane')).toContainText('public.customers');
    await expect(page.getByTestId('tab-data')).toHaveCount(0);

    // --- a declined prompt grants nothing, and the tab stays away ------------
    // Self-checking rather than timing-dependent: had the decline granted
    // anything, the card would offer "turn off" instead and the approve click
    // below would find no element to click.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never;
    });
    await page.getByTestId('rowaccess-enable-browse').click();
    await expect(badge).toHaveText('rows: off');
    await expect(page.getByTestId('tab-data')).toHaveCount(0);

    // --- approving shows the level and offers the tab ------------------------
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as never;
    });
    await page.getByTestId('rowaccess-enable-browse').click();
    await expect(badge).toHaveText('rows: browsing');

    await page.getByTestId('tab-data').click();
    const grid = page.getByTestId('data-grid');
    await expect(grid).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('data-error')).toHaveCount(0);
    await expect(grid.locator('thead th').first()).toHaveText('id');

    // Smallest page on offer, so the seeded rows span more than one of them.
    await page.getByTestId('data-page-size').selectOption(String(PAGE_SIZE));
    await expect(grid.locator('tbody tr')).toHaveCount(PAGE_SIZE);
    // A NULL is rendered as a marker, not as an empty cell that could be read
    // as an empty string (the fixture's second customer has no email).
    await expect(grid.locator('tbody .null').first()).toBeVisible();

    // --- paging walks by the cursor the previous page handed back ------------
    const position = page.getByTestId('data-position');
    await expect(position).toContainText('page 1');
    await expect(page.getByTestId('data-prev')).toBeDisabled();
    await expect(page.getByTestId('data-next')).toBeEnabled();

    const firstOfPage1 = await firstCell(page).innerText();
    await page.getByTestId('data-next').click();
    await expect(position).toContainText('page 2');
    await expect(page.getByTestId('data-error')).toHaveCount(0);
    const firstOfPage2 = await firstCell(page).innerText();
    expect(firstOfPage2).not.toBe(firstOfPage1);
    await expect(page.getByTestId('data-prev')).toBeEnabled();

    await page.getByTestId('data-prev').click();
    await expect(position).toContainText('page 1');
    await expect(firstCell(page)).toHaveText(firstOfPage1);

    // --- changing the sort restarts the traversal ----------------------------
    // A cursor encodes the ORDER BY it was issued for and the query builder
    // refuses a mismatch, so a sort change that kept the cursor would surface
    // as a 400 here rather than as a first page.
    await page.getByTestId('data-next').click();
    await expect(position).toContainText('page 2');
    await page.getByTestId('data-sort-column').selectOption('name');
    await expect(position).toContainText('page 1');
    await expect(page.getByTestId('data-error')).toHaveCount(0);
    await expect(page.getByTestId('data-prev')).toBeDisabled();
    await expect(grid.locator('tbody tr')).toHaveCount(PAGE_SIZE);
    // The ORDER BY reached the database, not just the control: the fixture's
    // 'Ada' sorts first by name and the seeded rows all sort after it.
    await expect(firstName(page)).toHaveText('Ada');

    // Flipping the direction leaves the page counter at 1, so the rows are what
    // has to be waited on here.
    await page.getByTestId('data-sort-dir').selectOption('desc');
    await expect(firstName(page)).toHaveText('Grace');
    await expect(position).toContainText('page 1');
    await expect(page.getByTestId('data-error')).toHaveCount(0);

    // --- a view has no primary key: one page, and the pane says why ----------
    await page.getByTestId('map-node-public.recent_orders').click();
    await expect(page.getByTestId('detail-pane')).toContainText('public.recent_orders');
    await page.getByTestId('tab-data').click();
    await expect(page.getByTestId('data-no-keyset')).toBeVisible();
    await expect(page.getByTestId('data-next')).toHaveCount(0);
    await expect(page.getByTestId('data-prev')).toHaveCount(0);
    await expect(page.getByTestId('data-error')).toHaveCount(0);

    // --- revoking takes the tab away without a prompt ------------------------
    await page.getByTestId('rowaccess-off-browse').click();
    await expect(badge).toHaveText('rows: off');
    await expect(page.getByTestId('tab-data')).toHaveCount(0);
    await expect(page.getByTestId('data-panel')).toHaveCount(0);
  } finally {
    await app.close();
    await seeder.query('DELETE FROM customers WHERE email LIKE $1', [`${SEED_PREFIX}%`]);
    await seeder.end();
  }
});
