// End-to-end for the Data tab: the row browser as an operator reaches it, not
// as the preload API sees it (that is data.spec.ts). What is worth proving here
// is the wiring the UI owns — the grant is legible on the card whether or not
// it is granted, the tab is offered only when it is, the cursor handed back by
// one page is what fetches the next, changing the sort restarts the traversal
// instead of replaying a cursor the new ORDER BY would reject, a page that
// fails or comes back empty leaves a way out rather than a stranded panel, and a
// value too large for the wire is shown as cut instead of as the value.
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
import { DATA_VALUE_BUDGET, IPC } from '../src/shared/types.js';

const url = process.env.KOZOU_TEST_DATABASE_URL;

test.skip(!url, 'KOZOU_TEST_DATABASE_URL not set');

/** The fixture holds two customers, which is one page however small the pager
 *  gets. Paging needs more rows than the smallest page size on offer, and they
 *  are seeded directly rather than through the app: this suite is about the
 *  read path, and granting write access to arrange it would prove nothing. */
const SEED_PREFIX = 'e2e-browse-';
const SEED_COUNT = 12;
const PAGE_SIZE = 10;

/** One seeded value larger than the wire budget, so the pane has something it
 *  is unable to show in full. Its name starts with 'Bulk', which sorts above
 *  every 'Browse NN' and below the fixture's 'Grace': it therefore lands on the
 *  first page under `name desc` without moving either end of the sort
 *  assertions. */
const OVERSIZED_NAME_CHARS = DATA_VALUE_BUDGET + 500;

/** Counter the dialog stubs keep in the MAIN process. Asserting on it is what
 *  makes "the prompt was declined" and "the downgrade asked nothing" claims
 *  about main rather than about the level happening to look right. */
type PromptCounter = { __prompts: number };

let seeder: Client;

test.beforeAll(async () => {
  seeder = new Client({ connectionString: url });
  await seeder.connect();
  await seedRows();
});

test.afterAll(async () => {
  await seeder.query('DELETE FROM customers WHERE email LIKE $1', [`${SEED_PREFIX}%`]);
  await seeder.end();
});

async function seedRows(): Promise<void> {
  await seeder.query('DELETE FROM customers WHERE email LIKE $1', [`${SEED_PREFIX}%`]);
  await seeder.query(
    `INSERT INTO customers (name, email)
     SELECT 'Browse ' || lpad(i::text, 2, '0'), $1 || lpad(i::text, 2, '0') || '@example.test'
     FROM generate_series(1, $2) AS i`,
    [SEED_PREFIX, SEED_COUNT],
  );
  await seeder.query(`INSERT INTO customers (name, email) VALUES ('Bulk ' || repeat('x', $1), $2)`, [
    OVERSIZED_NAME_CHARS,
    `${SEED_PREFIX}bulk@example.test`,
  ]);
}

/** Cells of the first row. `id` identifies which page is on screen; `name`
 *  identifies which ORDER BY produced it. Both are asserted with retrying
 *  matchers: a control that does not change the step counter (a direction flip,
 *  say) would otherwise be read before its rows land. */
function firstCell(page: Page): Locator {
  return page.getByTestId('data-grid').locator('tbody tr').first().locator('td').first();
}

function firstName(page: Page): Locator {
  return page.getByTestId('data-grid').locator('tbody tr').first().locator('td').nth(1);
}

function prompts(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as PromptCounter).__prompts);
}

/** Launch the built app on a fresh user-data directory with one profile whose
 *  row access is still off, an entity selected, and dialogs stubbed to count
 *  their prompts and answer `response`. */
async function launchWithProfile(
  name: string,
  response: 0 | 1,
): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkdtempSync(join(tmpdir(), 'kozou-desktop-e2e-browse-'));
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
  await expect(page.getByTestId(`card-${name}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('inspect-stats')).toBeVisible({ timeout: 60_000 });

  await app.evaluate(({ dialog }, answer) => {
    (globalThis as unknown as PromptCounter).__prompts = 0;
    dialog.showMessageBox = (async () => {
      (globalThis as unknown as PromptCounter).__prompts += 1;
      return { response: answer, checkboxChecked: false };
    }) as never;
  }, response);

  return { app, page };
}

test('data tab: gated by the grant, browses rows, and pages by cursor', async () => {
  const { app, page } = await launchWithProfile('browse', 0);

  try {
    // --- the level is on the card before anything is granted -----------------
    const badge = page.getByTestId('rowaccess-badge-browse');
    await expect(badge).toHaveText('rows: off');

    await page.getByTestId('map-node-public.customers').click({ timeout: 30_000 });
    await expect(page.getByTestId('detail-pane')).toContainText('public.customers');
    await expect(page.getByTestId('tab-data')).toHaveCount(0);

    // --- a declined prompt grants nothing, and the tab stays away ------------
    // The prompt count is what proves the decline reached main: the level
    // staying 'off' would be satisfied just as well by a click that never got
    // there at all.
    await page.getByTestId('rowaccess-enable-browse').click();
    await expect.poll(() => prompts(app)).toBe(1);
    await expect(badge).toHaveText('rows: off');
    await expect(page.getByTestId('tab-data')).toHaveCount(0);

    // --- approving shows the level and offers the tab ------------------------
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => {
        (globalThis as unknown as PromptCounter).__prompts += 1;
        return { response: 1, checkboxChecked: false };
      }) as never;
    });
    await page.getByTestId('rowaccess-enable-browse').click();
    await expect(badge).toHaveText('rows: browsing');
    await expect.poll(() => prompts(app)).toBe(2);

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
    // No sort column is chosen, so the direction control must not claim one.
    await expect(page.getByTestId('data-sort-dir')).toBeDisabled();

    // --- paging walks by the cursor the previous page handed back ------------
    const position = page.getByTestId('data-position');
    await expect(position).toContainText('step 1');
    await expect(page.getByTestId('data-prev')).toBeDisabled();
    await expect(page.getByTestId('data-next')).toBeEnabled();
    await expect(page.getByTestId('data-first')).toHaveCount(0);

    const firstOfPage1 = await firstCell(page).innerText();
    await page.getByTestId('data-next').click();
    await expect(position).toContainText('step 2');
    await expect(page.getByTestId('data-error')).toHaveCount(0);
    const firstOfPage2 = await firstCell(page).innerText();
    expect(firstOfPage2).not.toBe(firstOfPage1);
    await expect(page.getByTestId('data-prev')).toBeEnabled();
    await expect(page.getByTestId('data-first')).toBeVisible();

    await page.getByTestId('data-prev').click();
    await expect(position).toContainText('step 1');
    await expect(firstCell(page)).toHaveText(firstOfPage1);

    // --- changing the sort restarts the traversal ----------------------------
    // A cursor encodes the ORDER BY it was issued for and the query builder
    // refuses a mismatch, so a sort change that kept the cursor would surface
    // as a 400 here rather than as a first page.
    await page.getByTestId('data-next').click();
    await expect(position).toContainText('step 2');
    await page.getByTestId('data-sort-column').selectOption('name');
    await expect(position).toContainText('step 1');
    await expect(page.getByTestId('data-error')).toHaveCount(0);
    await expect(page.getByTestId('data-prev')).toBeDisabled();
    await expect(grid.locator('tbody tr')).toHaveCount(PAGE_SIZE);
    // The ORDER BY reached the database, not just the control: the fixture's
    // 'Ada' sorts first by name and the seeded rows all sort after it.
    await expect(firstName(page)).toHaveText('Ada');

    // Flipping the direction leaves the step counter at 1, so the rows are what
    // has to be waited on here.
    await expect(page.getByTestId('data-sort-dir')).toBeEnabled();
    await page.getByTestId('data-sort-dir').selectOption('desc');
    await expect(firstName(page)).toHaveText('Grace');
    await expect(position).toContainText('step 1');
    await expect(page.getByTestId('data-error')).toHaveCount(0);

    // --- a value the wire will not carry is shown as cut, not as the value ---
    // The oversized name sorts just below 'Grace', so this page holds it. The
    // note and the badge are the whole promise: the pane is a preview, and it
    // says which cells it could not show in full.
    await expect(page.getByTestId('data-truncated')).toBeVisible();
    await expect(page.getByTestId('data-cut').first()).toBeVisible();

    // --- a view has no primary key: one page, and the pane says why ----------
    await page.getByTestId('map-node-public.recent_orders').click();
    await expect(page.getByTestId('detail-pane')).toContainText('public.recent_orders');
    await page.getByTestId('tab-data').click();
    await expect(page.getByTestId('data-no-keyset')).toBeVisible();
    // The view's own rows were actually fetched — without this the no-keyset
    // note and the absent pager would render even if no list call was made.
    await expect(grid.locator('thead th').nth(1)).toHaveText('customer_name');
    await expect(grid.locator('tbody tr').first()).toBeVisible();
    await expect(page.getByTestId('data-next')).toHaveCount(0);
    await expect(page.getByTestId('data-prev')).toHaveCount(0);
    await expect(page.getByTestId('data-error')).toHaveCount(0);

    // --- an emptied page still has a way back -------------------------------
    // kozou emits no cursors for an empty page, so both pager buttons go dead:
    // without an explicit "first page" the traversal would be stranded.
    await page.getByTestId('map-node-public.customers').click();
    await page.getByTestId('tab-data').click();
    await page.getByTestId('data-page-size').selectOption(String(PAGE_SIZE));
    await expect(grid.locator('tbody tr')).toHaveCount(PAGE_SIZE);
    await expect(page.getByTestId('data-next')).toBeEnabled();
    await seeder.query('DELETE FROM customers WHERE email LIKE $1', [`${SEED_PREFIX}%`]);
    await page.getByTestId('data-next').click();
    await expect(position).toContainText('0 rows');
    await expect(page.getByTestId('data-prev')).toBeDisabled();
    await expect(page.getByTestId('data-next')).toBeDisabled();
    const back = page.getByTestId('data-first');
    await expect(back).toBeVisible();
    await back.click();
    await expect(position).toContainText('step 1');
    await expect(grid.locator('tbody tr').first()).toBeVisible();
    await expect(back).toHaveCount(0);
    await seedRows();

    // --- revoking takes the tab away without a prompt ------------------------
    const before = await prompts(app);
    await page.getByTestId('rowaccess-off-browse').click();
    await expect(badge).toHaveText('rows: off');
    await expect(page.getByTestId('tab-data')).toHaveCount(0);
    await expect(page.getByTestId('data-panel')).toHaveCount(0);
    // Read after the badge flipped, so the revocation has completed. Without
    // this the section would pass even if a downgrade did prompt, because the
    // stub in force answers affirmatively.
    expect(await prompts(app)).toBe(before);
  } finally {
    await app.close();
  }
});

test('a failed IPC leaves neither the badge nor the traversal position lying', async () => {
  // Two renderer invariants that only a failing main process can exercise, so
  // main's handlers are replaced here. Both replacements are irreversible (the
  // real handler's closure cannot be recovered), which is why this is its own
  // app rather than a section of the one above.
  const { app, page } = await launchWithProfile('failing', 1);
  const badge = page.getByTestId('rowaccess-badge-failing');

  try {
    await page.getByTestId('map-node-public.customers').click({ timeout: 30_000 });

    // --- the badge does not depend on a second round trip --------------------
    // The level is taken from what the grant call returned (main's post-change
    // store state). Break the profile listing that follows it: the badge must
    // still show the level in force, because it is the only warning that a
    // grant is live and a revocation is prompt-free by design.
    await app.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => {
        throw new Error('injected profiles:list failure');
      });
    }, IPC.profilesList);

    await expect(badge).toHaveText('rows: off');
    await page.getByTestId('rowaccess-enable-failing').click();
    await expect(badge).toHaveText('rows: browsing');
    // The broken refresh is surfaced rather than swallowed.
    await expect(page.getByTestId('form-error')).toBeVisible();

    await page.getByTestId('tab-data').click();
    const grid = page.getByTestId('data-grid');
    await expect(grid).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('data-page-size').selectOption(String(PAGE_SIZE));
    await expect(grid.locator('tbody tr')).toHaveCount(PAGE_SIZE);
    const position = page.getByTestId('data-position');
    await expect(position).toContainText('step 1');

    // --- a failed hop moves neither the step counter nor the cursor -----------
    // The stub fails the first call and then answers with a canned page whose
    // first row NAMES whether a cursor was sent. That is what distinguishes the
    // invariant under test from a counter that merely looks right: after a
    // failed Next, a reload must re-fetch the page the panel is showing, not
    // the page it failed to reach.
    await app.evaluate(({ ipcMain }, channel) => {
      const g = globalThis as unknown as { __listCalls: number };
      g.__listCalls = 0;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_e, _profile, _resource, params: unknown) => {
        g.__listCalls += 1;
        if (g.__listCalls === 1) throw new Error('injected list failure');
        const after = (params as { after?: string } | undefined)?.after;
        return {
          ok: true,
          status: 200,
          body: {
            rows: [
              {
                id: 999,
                name: after === undefined ? 'no-cursor' : 'cursor-retained',
                email: null,
                birthday: '2026-08-01',
                created_at: null,
              },
            ],
            total: null,
            nextCursor: null,
            prevCursor: null,
          },
        };
      });
    }, IPC.dataList);

    await page.getByTestId('data-next').click();
    await expect(page.getByTestId('data-error')).toBeVisible();
    await expect(position).toContainText('step 1');
    await expect(page.getByTestId('data-first')).toHaveCount(0);

    await page.getByTestId('data-reload').click();
    await expect(firstName(page)).toHaveText('no-cursor');
    await expect(position).toContainText('step 1');

    // --- a dropped json value must not read as a NULL ------------------------
    // The worker replaces an oversized json value with null and reports the cut;
    // rendering that as the NULL marker would turn "we would not carry this"
    // into "the database has no value here". A stubbed reply is the only way to
    // put a json cut on screen without a json column in the fixture.
    await app.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => ({
        ok: true,
        status: 200,
        body: {
          // Every column of the real relation: a key absent from the row would
          // render as a NULL cell and be counted as one below.
          rows: [
            { id: 1, name: 'has-json', email: null, birthday: '2026-08-01', created_at: null },
          ],
          total: null,
          nextCursor: null,
          prevCursor: null,
        },
        truncated: [{ row: 0, column: 'email', kind: 'json', size: 1024 }],
      }));
    }, IPC.dataList);

    await page.getByTestId('data-reload').click();
    await expect(firstName(page)).toHaveText('has-json');
    await expect(page.getByTestId('data-truncated')).toBeVisible();
    const cut = page.getByTestId('data-cut');
    await expect(cut).toHaveText('(json value too large)');
    // The row's other null cell still renders as NULL, so this is the cut cell
    // being told apart rather than the marker having disappeared everywhere.
    await expect(page.getByTestId('data-grid').locator('tbody .null')).toHaveCount(1);
  } finally {
    await app.close();
  }
});
