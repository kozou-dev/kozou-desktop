// End-to-end for the comment editor: the operator's path from a relation on the
// map to a statement they can take away.
//
// The claims worth proving here are the ones only a running app can settle:
// that the editor is reachable WITHOUT any row-data grant (it touches no
// database, so gating it would be theatre), that the text box is seeded with
// the comment as the schema author wrote it rather than the rendered form the
// pane shows above it, that a materialized view is named as one, that drafting
// changes nothing in the database, and that the .sql export writes what the
// panel displays.
//
// Requires: `pnpm build` first and a reachable PostgreSQL via
// KOZOU_TEST_DATABASE_URL (same provisioning as app.spec.ts).

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { Client } from 'pg';

const url = process.env.KOZOU_TEST_DATABASE_URL;

test.skip(!url, 'KOZOU_TEST_DATABASE_URL not set');

let reader: Client;

test.beforeAll(async () => {
  reader = new Client({ connectionString: url });
  await reader.connect();
});

test.afterAll(async () => {
  await reader.end();
});

/** The comment PostgreSQL currently holds for a relation. */
async function storedComment(qualified: string): Promise<string | null> {
  const { rows } = await reader.query<{ c: string | null }>(
    'SELECT obj_description($1::regclass) AS c',
    [qualified],
  );
  return rows[0]?.c ?? null;
}

/** The comment PostgreSQL currently holds for one column of a relation. */
async function storedColumnComment(qualified: string, column: string): Promise<string | null> {
  const { rows } = await reader.query<{ c: string | null }>(
    `SELECT col_description(a.attrelid, a.attnum) AS c
       FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attname = $2`,
    [qualified, column],
  );
  return rows[0]?.c ?? null;
}

/** Launch the built app on a fresh user-data directory with one profile
 *  inspected. No row-access grant is given anywhere in this suite: the comment
 *  editor must not need one. */
async function launchWithProfile(
  name: string,
): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = mkdtempSync(join(tmpdir(), 'kozou-desktop-e2e-comment-'));
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

  return { app, page, userData };
}

/** Select a relation on the map. Emitting a statement opens the drafts panel, and a
 *  panel at the bottom of the workspace takes the whole of it - so reaching the map
 *  again is a deliberate step, the same one an operator takes: shut the panel from
 *  the row that is still on screen. */
async function selectOnMap(page: Page, qualifiedName: string): Promise<void> {
  const open = page.locator('[data-testid^="bottom-"][data-open="true"]');
  if ((await open.count()) > 0) await open.first().click();
  await page.getByTestId(`map-node-${qualifiedName}`).click({ timeout: 30_000 });
}

test('comment editor: seeded verbatim, emits per relation kind, applies nothing', async () => {
  const { app, page } = await launchWithProfile('emit');

  try {
    // --- reachable with no row-data grant ------------------------------------
    await expect(page.getByTestId('rowaccess-badge-emit')).toHaveText('rows: off');
    await page.getByTestId('map-node-public.customer_totals').click({ timeout: 30_000 });
    await expect(page.getByTestId('detail-pane')).toContainText('public.customer_totals');
    await page.getByTestId('edit-relation-comment').click();

    // --- seeded with the comment as written, not with what the pane renders --
    // The fixture's materialized view carries an `@example:` block, which the
    // context builder lifts OUT of `description`. Seeding from that field would
    // delete the block on the first save; this is where that is caught.
    const text = page.getByTestId('comment-text');
    await expect(text).toBeVisible();
    await expect(text).toHaveValue(/@example: Biggest spenders/);
    await expect(page.getByTestId('detail-pane').locator('pre.comment')).not.toContainText(
      '@example:',
    );

    // --- a materialized view is named as one ---------------------------------
    await expect(page.getByTestId('comment-sql')).toContainText(
      'COMMENT ON MATERIALIZED VIEW "public"."customer_totals" IS',
    );
    await expect(page.getByTestId('comment-unchanged')).toBeVisible();

    const before = await storedComment('public.customer_totals');
    await text.fill('Edited by the e2e run.\n@ai: still here');
    await expect(page.getByTestId('comment-unchanged')).toHaveCount(0);

    // --- the typed text survives leaving the tab -----------------------------
    // The editor renders inside the Semantics branch, so another tab unmounts
    // it. If the value lived in that component it would come back as the
    // database seed, silently replacing what was typed.
    await page.getByTestId('tab-ai').click();
    await expect(page.getByTestId('comment-editor')).toHaveCount(0);
    await page.getByRole('button', { name: 'Semantics' }).click();
    await expect(page.getByTestId('comment-text')).toHaveValue(
      'Edited by the e2e run.\n@ai: still here',
    );

    await page.getByTestId('comment-draft').click();

    // --- the draft lands, and the database is untouched ----------------------
    const panel = page.getByTestId('draft-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('public.customer_totals');
    await expect(panel.locator('pre')).toContainText(
      `COMMENT ON MATERIALIZED VIEW "public"."customer_totals" IS 'Edited by the e2e run.`,
    );
    await expect(page.getByTestId('comment-editor')).toHaveCount(0);
    expect(await storedComment('public.customer_totals')).toBe(before);

    // --- an ordinary view gets the other keyword -----------------------------
    const viewBefore = await storedComment('public.recent_orders');
    await selectOnMap(page, 'public.recent_orders');
    await expect(page.getByTestId('detail-pane')).toContainText('public.recent_orders');
    await page.getByTestId('edit-relation-comment').click();
    await page.getByTestId('comment-text').fill('Ordinary view, edited.');
    await expect(page.getByTestId('comment-sql')).toHaveText(
      `COMMENT ON VIEW "public"."recent_orders" IS 'Ordinary view, edited.';`,
    );
    await page.getByTestId('comment-draft').click();

    // --- a column, addressed through its relation ----------------------------
    const emailBefore = await storedColumnComment('public.customers', 'email');
    await selectOnMap(page, 'public.customers');
    await page.getByTestId('edit-column-comment-email').click();
    const columnText = page.getByTestId('comment-text');
    await expect(columnText).toHaveValue(/@ai: may be NULL for walk-in customers/);
    await columnText.fill('');
    // An empty body is removal: PostgreSQL stores no empty comment.
    await expect(page.getByTestId('comment-sql')).toHaveText(
      'COMMENT ON COLUMN "public"."customers"."email" IS NULL;',
    );
    await page.getByTestId('comment-draft').click();

    await expect(panel.locator('li')).toHaveCount(3);

    // --- nothing was applied, checked per drafted target ---------------------
    // One re-read is not enough: an implementation that wrongly applied two of
    // the three would still satisfy a check that only looks at the third.
    expect(await storedComment('public.customer_totals')).toBe(before);
    expect(await storedComment('public.recent_orders')).toBe(viewBefore);
    expect(await storedColumnComment('public.customers', 'email')).toBe(emailBefore);
  } finally {
    await app.close();
  }
});

test('drafts: saved as the file the user picks, and dropped when the profile moves', async () => {
  const { app, page } = await launchWithProfile('export');

  try {
    await page.getByTestId('map-node-public.customers').click({ timeout: 30_000 });
    await page.getByTestId('edit-relation-comment').click();
    await page.getByTestId('comment-text').fill('Saved through the dialog.');
    await page.getByTestId('comment-draft').click();
    await expect(page.getByTestId('draft-panel')).toBeVisible();

    // --- the save dialog is main's, and only its answer writes anything ------
    const target = join(mkdtempSync(join(tmpdir(), 'kozou-desktop-e2e-sql-')), 'out.sql');
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (async () => ({ canceled: true, filePath: undefined })) as never;
    });
    await page.getByTestId('draft-save').click();
    await expect(page.getByTestId('draft-status')).toHaveCount(0);
    expect(() => readFileSync(target, 'utf8')).toThrow();

    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as never;
    }, target);
    await page.getByTestId('draft-save').click();
    await expect(page.getByTestId('draft-status')).toContainText('Saved');

    const written = readFileSync(target, 'utf8');
    expect(written).toContain(`COMMENT ON TABLE "public"."customers" IS 'Saved through the dialog.'`);
    expect(written).toContain('never runs them');

    // --- a re-saved profile may point elsewhere; its drafts do not follow ----
    // Statements name relations in a specific database. A save is where a
    // profile can stop being the database its drafts were written against, so
    // that is where they stop being offered.
    await page.getByTestId('add-toggle').click();
    await page.getByPlaceholder('name', { exact: true }).fill('export');
    await page.getByPlaceholder('postgresql://user:password@host:5432/db').fill(url!);
    await page.getByPlaceholder('schemas (comma-separated)').fill('public');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByTestId('inspect-stats')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('draft-panel')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
