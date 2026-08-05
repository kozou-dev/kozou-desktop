// End-to-end for the local MCP hub: the permission off by default and asked for
// in Settings, one-click start with a live loopback listener, app-quit closing
// the port (no orphans), launch-time restore of autoStart servers, explicit
// stop, and the duplicate-connection warning flow.
//
// Two of the assertions here are about which surface speaks: the header says
// nothing about MCP, and a card reports a declaration whether or not this app
// is allowed to serve. Both were regressions in shipped builds, and both are
// invisible to a unit test.
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

/** Open the Settings panel, where the MCP permission lives. Retried the same
 *  way as the add form: the panel is closed on launch and the first render can
 *  land after the click. */
async function openSettings(page: Page): Promise<void> {
  const box = page.getByTestId('mcp-allow');
  await expect(async () => {
    if (!(await box.isVisible())) {
      await page.getByTestId('settings-toggle').click();
    }
    await expect(box).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
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

  // --- first launch: default off, explicit permission + start ---------------
  const first = await launch(userData);
  // Nothing in the header speaks for MCP. It answered the permission there as a
  // question ("MCP served by:", then "This app may serve MCP:") above cards
  // reporting per-profile state, and the answer was read as state.
  //
  // Scoped to `header.top`: three components render a <header> (App, DetailPane,
  // DraftPanel), so a bare `locator('header')` is a strict-mode violation the
  // moment a second one is mounted — it passes here only because nothing is
  // selected yet, which makes it a trap for whoever moves this line.
  await expect(first.page.locator('header.top')).not.toContainText('MCP');
  await openSettings(first.page);
  await expect(first.page.getByTestId('mcp-allow')).not.toBeChecked();
  await addProfile(first.page, 'alpha');

  // The card states the permission it is subject to even though nothing may run
  // yet. This row used to be absent entirely while the permission was off, so an
  // operator who had not opened Settings had no way to learn from the screen
  // that per-profile MCP existed. Visibility, not just text: a row rendered and
  // then hidden by CSS would satisfy a text-only assertion.
  await expect(first.page.getByTestId('mcp-badge-alpha')).toBeVisible();
  await expect(first.page.getByTestId('mcp-badge-alpha')).toHaveText('MCP not allowed - see Settings');
  await expect(first.page.getByTestId('mcp-start-alpha')).toHaveCount(0);
  // Nothing was declared for this profile, and silence is not a claim.
  await expect(first.page.getByTestId('serving-alpha')).toHaveCount(0);

  await first.page.getByTestId('mcp-allow').check();
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
  await openSettings(second.page);
  await expect(second.page.getByTestId('mcp-allow')).toBeChecked();
  await expect(second.page.getByTestId('mcp-badge-alpha')).toHaveText(/MCP on :\d+/, { timeout: 30_000 });
  expect(await portOpen(port)).toBe(true);

  // Withdrawing the permission with a server up asks first, and the box keeps
  // showing the permission IN FORCE while it asks: until the prompt is answered
  // the old permission still stands and cards can still start servers, so an
  // unchecked box beside a live server would be a false answer with a
  // disclaimer next to it. Clicked rather than unchecked() on purpose —
  // unchecked() asserts the box moved, and the point is that it does not.
  await second.page.getByTestId('mcp-allow').click();
  await expect(second.page.getByTestId('mcp-mode-confirm')).toBeVisible();
  await expect(second.page.getByTestId('mcp-allow')).toBeChecked();
  await expect(second.page.getByTestId('mcp-allow')).toBeDisabled();
  // Asked, not promised — kill()'s failure result is ignored and the wait gives
  // up after three seconds. And the count includes servers that are starting,
  // so the words have to as well.
  await expect(second.page.getByTestId('mcp-mode-confirm')).toContainText('will be asked to stop');
  await expect(second.page.getByTestId('mcp-mode-confirm')).toContainText('running or starting');
  await second.page.getByTestId('mcp-mode-confirm-no').click();
  await expect(second.page.getByTestId('mcp-mode-confirm')).toHaveCount(0);
  await expect(second.page.getByTestId('mcp-allow')).toBeChecked();
  await expect(second.page.getByTestId('mcp-allow')).toBeEnabled();
  expect(await portOpen(port)).toBe(true);

  await second.page.getByTestId('mcp-stop-alpha').click();
  await expect(second.page.getByTestId('mcp-badge-alpha')).toHaveText('MCP off', { timeout: 15_000 });
  await waitPortClosed(port);
  const stopped = (await mcpEntry(second.page, 'alpha'))!;
  expect(stopped.status).toBe('stopped');
  expect(stopped.autoStart).toBe(false);

  // Confirm-yes path: start again, then withdraw the permission — the servers
  // are asked to stop and the card falls back to stating the permission.
  await second.page.getByTestId('mcp-start-alpha').click();
  await expect(second.page.getByTestId('mcp-badge-alpha')).toHaveText(/MCP on :\d+/, { timeout: 30_000 });
  await second.page.getByTestId('mcp-allow').click();
  await second.page.getByTestId('mcp-mode-confirm-yes').click();
  await expect(second.page.getByTestId('mcp-allow')).not.toBeChecked();
  await expect(second.page.getByTestId('mcp-badge-alpha')).toHaveText('MCP not allowed - see Settings');
  await waitPortClosed(port);
  await second.app.close();
});

test('duplicate warning: declared remote MCP on the same database blocks, override starts', async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), 'kozou-desktop-e2e-mcp-dup-'));
  const { app, page } = await launch(userData);

  await addProfile(page, 'declared', { remoteDeclared: true });
  await addProfile(page, 'target');
  // What the operator recorded about someone else's server is true whether or
  // not this app may serve, so the badge is asserted with the permission off AND
  // with it on. It used to be rendered from two branches under two modes, which
  // is how the app ended up saying different things about the same declaration
  // depending on a setting unrelated to it.
  await expect(page.getByTestId('serving-declared')).toBeVisible();
  await expect(page.getByTestId('serving-declared')).toHaveText('served remotely (declared)');
  await expect(page.getByTestId('serving-target')).toHaveCount(0);

  await openSettings(page);
  await page.getByTestId('mcp-allow').check();
  await expect(page.getByTestId('serving-declared')).toBeVisible();
  await expect(page.getByTestId('serving-declared')).toHaveText('served remotely (declared)');
  await expect(page.getByTestId('serving-target')).toHaveCount(0);

  await page.getByTestId('mcp-start-target').click();
  await expect(page.getByTestId('mcp-dup-target')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('mcp-dup-target')).toContainText('declared');
  // Names what the collision risks, not just that there is one.
  await expect(page.getByTestId('mcp-dup-target')).toContainText('answer the same question differently');

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
