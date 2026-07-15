// End-to-end: with two or more profiles against a real database, the
// semantic map renders, a node opens the detail pane, and the AI view shows
// the exact describe payload.
//
// Requires: `pnpm build` first (launches the built app) and a reachable
// PostgreSQL via KOZOU_TEST_DATABASE_URL (fixtures/contract.sql expected).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const url = process.env.KOZOU_TEST_DATABASE_URL;

test.skip(!url, 'KOZOU_TEST_DATABASE_URL not set');

test('two profiles: map, detail pane, and AI view end-to-end', async () => {
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
    // The add form is auto-open when there are no profiles; open it otherwise.
    if (!(await page.getByPlaceholder('name').isVisible())) {
      await page.getByRole('button', { name: '+ Add database' }).click();
    }
    await page.getByPlaceholder('name').fill(name);
    await page.getByPlaceholder('postgresql://user:password@host:5432/db').fill(url!);
    await page.getByPlaceholder('schemas (comma-separated)').fill('public');
    await page.getByRole('button', { name: 'Save profile' }).click();
    // Wait until the save settles either way, then surface a failure as its
    // message instead of a bare not-found timeout on the card.
    const card = page.getByTestId(`card-${name}`);
    const err = page.getByTestId('form-error');
    await expect(card.or(err).first()).toBeVisible();
    await expect(err).toHaveCount(0);
    await expect(card).toBeVisible();
    // Saving auto-inspects the new profile.
    await expect(page.getByTestId('inspect-stats')).toBeVisible({ timeout: 60_000 });
  }

  for (const name of ['alpha', 'beta']) {
    await page.getByTestId(`card-${name}`).click();
    await expect(page.getByTestId('inspect-stats')).toContainText(name, { timeout: 60_000 });

    // F2: the semantic map lays out and renders fixture relations.
    const map = page.getByTestId('semantic-map');
    await expect(map).toBeVisible();
    const customers = page.getByTestId('map-node-public.customers');
    await expect(customers).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('map-node-public.recent_orders')).toBeVisible();
    await expect(page.getByTestId('map-legend')).toBeVisible();

    // F3: clicking a node opens the compiled semantics.
    await customers.click();
    const detail = page.getByTestId('detail-pane');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('public.customers');
    await expect(detail).toContainText('@ai');

    // F6: the AI view shows the exact describe payload.
    await page.getByTestId('tab-ai').click();
    const aiView = page.getByTestId('ai-view');
    await expect(aiView).toContainText('public.customers');
    await expect(aiView).toContainText('"aiDescription"');
  }

  // F1: overview cards carry counts and annotation coverage.
  await expect(page.getByTestId('card-alpha')).toContainText('tables');
  await expect(page.getByTestId('card-alpha')).toContainText('annotated');

  await app.close();
});
