// End-to-end for the local MCP serving mode: default-off, one-click start
// with a live loopback listener, app-quit closing the port (no orphans),
// launch-time restore of autoStart servers, explicit stop, and the
// duplicate-connection warning flow.
//
// Requires: `pnpm build` first and a reachable PostgreSQL via
// KOZOU_TEST_DATABASE_URL (same provisioning as app.spec.ts).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { McpStatusEntry } from '../src/shared/types.js';

const url = process.env.KOZOU_TEST_DATABASE_URL;

test.skip(!url, 'KOZOU_TEST_DATABASE_URL not set');

type ApiWindow = {
  kozouDesktop: {
    mcpStatus(): Promise<McpStatusEntry[]>;
  };
};

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, KOZOU_DESKTOP_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function addProfile(page: Page, name: string, opts?: { remoteDeclared?: boolean }): Promise<void> {
  const nameInput = page.getByPlaceholder('name', { exact: true });
  await expect(async () => {
    if (!(await nameInput.isVisible())) {
      await page.getByTestId('add-toggle').click();
    }
    await expect(nameInput).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await nameInput.fill(name);
  await page.getByPlaceholder('postgresql://user:password@host:5432/db').fill(url!);
  await page.getByPlaceholder('schemas (comma-separated)').fill('public');
  if (opts?.remoteDeclared) {
    await page.getByTestId('remote-declared').check();
  }
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByTestId(`card-${name}`)).toBeVisible({ timeout: 15_000 });
}

function mcpEntry(page: Page, name: string): Promise<McpStatusEntry | undefined> {
  // globalThis === window inside the page; spelled this way because the e2e
  // suite typechecks under the node tsconfig (no DOM lib).
  return page.evaluate(
    (profile) =>
      (globalThis as unknown as ApiWindow).kozouDesktop.mcpStatus().then((s) => s.find((e) => e.profile === profile)),
    name,
  );
}

/** True while any HTTP response comes back (404 included = listener alive). */
async function portOpen(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/probe`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function waitPortClosed(port: number): Promise<void> {
  await expect(async () => {
    expect(await portOpen(port)).toBe(false);
  }).toPass({ timeout: 10_000 });
}

test('local MCP lifecycle: default off, start, quit closes the port, restore, stop', async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), 'kozou-desktop-e2e-mcp-'));

  // --- first launch: default off, explicit enable + start -------------------
  const first = await launch(userData);
  await expect(first.page.getByTestId('mcp-mode')).toHaveValue('off');
  await addProfile(first.page, 'alpha');
  // Off mode renders no MCP controls on the card.
  await expect(first.page.getByTestId('mcp-alpha')).toHaveCount(0);

  await first.page.getByTestId('mcp-mode').selectOption('local');
  await expect(first.page.getByTestId('mcp-badge-alpha')).toHaveText('MCP off');
  await first.page.getByTestId('mcp-start-alpha').click();
  await expect(first.page.getByTestId('mcp-badge-alpha')).toHaveText(/MCP on :\d+/, { timeout: 30_000 });

  const running = (await mcpEntry(first.page, 'alpha'))!;
  expect(running.status).toBe('running');
  expect(running.autoStart).toBe(true);
  const port = running.port!;
  expect(port).toBeGreaterThanOrEqual(3335);
  expect(await portOpen(port)).toBe(true);
  // The capability path is load-bearing: the default path 404s.
  const probe = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' });
  expect(probe.status).toBe(404);

  // The config panel shows the pasteable snippets.
  await first.page.getByTestId('mcp-config-alpha').click();
  await expect(first.page.getByTestId('mcp-snippet-json')).toContainText('kozou-local-alpha');
  await expect(first.page.getByTestId('mcp-snippet-json')).toContainText(`http://127.0.0.1:${port}/mcp-`);

  // --- app quit closes the listener (no orphans) -----------------------------
  await first.app.close();
  await waitPortClosed(port);

  // --- second launch: autoStart restores, explicit stop clears ---------------
  const second = await launch(userData);
  await expect(second.page.getByTestId('mcp-mode')).toHaveValue('local');
  await expect(second.page.getByTestId('mcp-badge-alpha')).toHaveText(/MCP on :\d+/, { timeout: 30_000 });
  expect(await portOpen(port)).toBe(true);

  // Leaving 'local' with a running server asks first; cancel keeps it
  // running and snaps the select back.
  await second.page.getByTestId('mcp-mode').selectOption('off');
  await expect(second.page.getByTestId('mcp-mode-confirm')).toBeVisible();
  await second.page.getByTestId('mcp-mode-confirm-no').click();
  await expect(second.page.getByTestId('mcp-mode-confirm')).toHaveCount(0);
  await expect(second.page.getByTestId('mcp-mode')).toHaveValue('local');
  expect(await portOpen(port)).toBe(true);

  await second.page.getByTestId('mcp-stop-alpha').click();
  await expect(second.page.getByTestId('mcp-badge-alpha')).toHaveText('MCP off', { timeout: 15_000 });
  await waitPortClosed(port);
  const stopped = (await mcpEntry(second.page, 'alpha'))!;
  expect(stopped.status).toBe('stopped');
  expect(stopped.autoStart).toBe(false);

  // Confirm-yes path: start again, then leave 'local' — all servers stop
  // and the mode switches.
  await second.page.getByTestId('mcp-start-alpha').click();
  await expect(second.page.getByTestId('mcp-badge-alpha')).toHaveText(/MCP on :\d+/, { timeout: 30_000 });
  await second.page.getByTestId('mcp-mode').selectOption('off');
  await second.page.getByTestId('mcp-mode-confirm-yes').click();
  await expect(second.page.getByTestId('mcp-mode')).toHaveValue('off');
  await waitPortClosed(port);
  await second.app.close();
});

test('duplicate warning: declared remote MCP on the same database blocks, override starts', async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), 'kozou-desktop-e2e-mcp-dup-'));
  const { app, page } = await launch(userData);

  await addProfile(page, 'declared', { remoteDeclared: true });
  await addProfile(page, 'target');
  await page.getByTestId('mcp-mode').selectOption('local');

  await page.getByTestId('mcp-start-target').click();
  await expect(page.getByTestId('mcp-dup-target')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('mcp-dup-target')).toContainText('declared');

  // Cancel leaves it stopped.
  await page.getByTestId('mcp-dup-cancel-target').click();
  await expect(page.getByTestId('mcp-dup-target')).toHaveCount(0);
  expect((await mcpEntry(page, 'target'))!.status).toBe('stopped');

  // Explicit override starts it.
  await page.getByTestId('mcp-start-target').click();
  await expect(page.getByTestId('mcp-dup-target')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('mcp-dup-confirm-target').click();
  await expect(page.getByTestId('mcp-badge-target')).toHaveText(/MCP on :\d+/, { timeout: 30_000 });

  await app.close();
});
