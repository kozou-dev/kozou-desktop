// End-to-end: with two or more profiles against a real database, the
// compiled SchemaContext renders in the UI.
//
// Requires: `pnpm build` first (launches the built app) and a reachable
// PostgreSQL via KOZOU_TEST_DATABASE_URL.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const url = process.env.KOZOU_TEST_DATABASE_URL;

test.skip(!url, 'KOZOU_TEST_DATABASE_URL not set');

test('two profiles inspect end-to-end', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'kozou-desktop-e2e-'));
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KOZOU_DESKTOP_USER_DATA: userData,
    },
  });
  const page = await app.firstWindow();

  for (const name of ['alpha', 'beta']) {
    await page.getByPlaceholder('name').fill(name);
    await page.getByPlaceholder('postgresql://user:password@host:5432/db').fill(url!);
    await page.getByPlaceholder('schemas (comma-separated)').fill('public');
    await page.getByRole('button', { name: 'Save profile' }).click();
    // Wait until the save settles either way, then surface a failure as its
    // message instead of a bare not-found timeout on the list item. (A plain
    // toHaveCount(0) on the error would race the async save.)
    const item = page.locator('li', { hasText: name });
    const err = page.getByTestId('form-error');
    await expect(item.or(err).first()).toBeVisible();
    await expect(err).toHaveCount(0);
    await expect(item).toBeVisible();
  }

  for (const name of ['alpha', 'beta']) {
    await page
      .locator('li', { hasText: name })
      .getByRole('button', { name: 'Inspect' })
      .click();
    await expect(page.getByTestId('inspect-stats')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('context-tree')).toContainText('SchemaContext');
    // The fixture's semantic content actually made it to the UI — assert a
    // table name and an @ai annotation from fixtures/contract.sql (textContent
    // includes collapsed <details> children).
    await expect(page.getByTestId('context-tree')).toContainText('customers');
    await expect(page.getByTestId('context-tree')).toContainText('@ai');
  }

  await app.close();
});
