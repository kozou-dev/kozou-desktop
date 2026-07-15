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
    await expect(page.locator('li', { hasText: name })).toBeVisible();
  }

  for (const name of ['alpha', 'beta']) {
    await page
      .locator('li', { hasText: name })
      .getByRole('button', { name: 'Inspect' })
      .click();
    await expect(page.getByTestId('inspect-stats')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('context-tree')).toContainText('SchemaContext');
    // The fixture's semantic content actually made it to the UI.
    await page.getByTestId('context-tree').getByText('SchemaContext').click();
  }

  await app.close();
});
