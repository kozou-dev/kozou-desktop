// End-to-end: with two or more profiles against a real database, the
// semantic map renders, a node opens the detail pane, and the AI view shows
// the exact describe payload.
//
// Requires: `pnpm build` first (launches the built app) and a reachable
// PostgreSQL via KOZOU_TEST_DATABASE_URL (fixtures/contract.sql expected).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeTable, describeView, getConceptContext, successResult } from '@kozou/mcp';
import { _electron as electron, expect, test } from '@playwright/test';
import { runInspect } from '../src/worker/runInspect.js';

const url = process.env.KOZOU_TEST_DATABASE_URL;

/** The expected text of one tool result, produced the way the server does —
 *  computed here in the test process, from its own introspection of the same
 *  database, so the comparison is against the real MCP path rather than
 *  against a fixture this repo also authors. Without this the AI view's whole
 *  claim ("this is what an agent receives") is only asserted by counting
 *  blocks and reading their headings. */
function toolText(payload: unknown): string {
  return (successResult(payload) as { content: { text: string }[] }).content[0]!.text;
}

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

  // The test's own introspection of the same database. The AI view is checked
  // against tool results computed from THIS, so the app cannot satisfy the
  // check by agreeing with itself.
  const { context: expected } = await runInspect({ url: url!, schemas: ['public'] });

  // The add form auto-opens on first run (empty) and closes after each save,
  // and the toggle's label flips between "+ Add database" and "Close". Both
  // make a one-shot open racy on a slow runner. Retry the whole open until
  // the name field is visible: if a click closed an already-open form, the
  // next attempt reopens it. Uses a stable testid so the flipping label
  // doesn't matter. exact: the search box placeholder also contains "name".
  const openAddForm = async (): Promise<void> => {
    const nameInput = page.getByPlaceholder('name', { exact: true });
    await expect(async () => {
      if (!(await nameInput.isVisible())) {
        await page.getByTestId('add-toggle').click();
      }
      await expect(nameInput).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
  };

  for (const name of ['alpha', 'beta']) {
    await openAddForm();
    const nameInput = page.getByPlaceholder('name', { exact: true });
    await nameInput.fill(name);
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
    // Clicked in the card's own padding rather than at its centre. The card is a
    // button wrapping several interactive children (the row-access links, the MCP
    // links), each of which stops propagation, so a centre click selects nothing
    // whenever a row happens to land there — measured: adding one row moved the
    // centre onto `enable browsing`, and this assertion then waited 60s on the
    // previous profile's stats. The corner is card body at any height.
    await page.getByTestId(`card-${name}`).click({ position: { x: 6, y: 6 } });
    await expect(page.getByTestId('inspect-stats')).toContainText(name, { timeout: 60_000 });

    // F2: the semantic map lays out and renders fixture relations.
    const map = page.getByTestId('semantic-map');
    await expect(map).toBeVisible();
    const customers = page.getByTestId('map-node-public.customers');
    await expect(customers).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('map-node-public.recent_orders')).toBeVisible();
    // What went wrong once: the map pane grew to its content instead of to the
    // window (1372px inside an 812px viewport), which put the legend — pinned to
    // the pane's bottom — thousands of pixels below the fold. `toBeVisible()`
    // passed there, because visibility does not require being on screen.
    //
    // So the assertion is the invariant that actually failed: the pane never
    // exceeds the window, and the legend is inside the pane. Deliberately NOT
    // "the legend is inside the viewport" — the design accepts the page scrolling
    // once the region above the workspace plus the pane floor exceed the window,
    // and a guard that goes red in a state the design allows is a guard that will
    // be deleted rather than believed.
    await expect(async () => {
      const fits = await page.getByTestId('semantic-map').evaluate((pane) => {
        const p = pane.getBoundingClientRect();
        const legend = pane.querySelector('[data-testid="map-legend"]');
        if (legend === null) return { paneFitsWindow: false, legendInsidePane: false };
        const l = legend.getBoundingClientRect();
        // globalThis === window inside the page; spelled this way because the e2e
        // suite typechecks under the node tsconfig, which has no DOM globals.
        const viewportHeight = (globalThis as unknown as { innerHeight: number }).innerHeight;
        return {
          paneFitsWindow: p.height > 0 && p.height <= viewportHeight,
          legendInsidePane: l.height > 0 && l.bottom <= p.bottom + 1 && l.top >= p.top - 1,
        };
      });
      expect(fits).toEqual({ paneFitsWindow: true, legendInsidePane: true });
    }).toPass({ timeout: 10_000 });

    // F3: clicking a node opens the compiled semantics.
    await customers.click();
    const detail = page.getByTestId('detail-pane');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('public.customers');
    await expect(detail).toContainText('@ai');

    // F6: the AI view shows the exact describe payload. Exactness is the whole
    // claim of this surface, so it is checked as an identity against payloads
    // this test computes itself — not by looking for substrings, which would
    // pass just as happily on a re-serialized or truncated payload.
    await page.getByTestId('tab-ai').click();
    const aiView = page.getByTestId('ai-view');
    // One block per tool result, and the call named outside the payload: a
    // table is a single describe_table.
    await expect(aiView.getByTestId('ai-view-block')).toHaveCount(1);
    await expect(aiView.getByTestId('ai-view-call')).toHaveText(
      'describe_table {"qualifiedName":"public.customers"}',
    );
    expect(await aiView.getByTestId('ai-view-block').innerText()).toBe(
      toolText(describeTable({ qualifiedName: 'public.customers' }, expected)),
    );

    // A concept-backed view is TWO tool results and must stay two: an agent
    // makes two calls and never receives them glued into one payload. This
    // pins the fix for the concatenated blob the pane used to render.
    await page.getByTestId('map-node-public.recent_orders').click();
    await page.getByTestId('tab-ai').click();
    const viewAi = page.getByTestId('ai-view');
    const viewBlocks = viewAi.getByTestId('ai-view-block');
    await expect(viewBlocks).toHaveCount(2);
    await expect(viewAi.getByTestId('ai-view-call').first()).toHaveText(
      'describe_view {"qualifiedName":"public.recent_orders"}',
    );
    await expect(viewAi.getByTestId('ai-view-call').last()).toHaveText(
      'get_concept_context {"name":"recent_orders"}',
    );
    // Each block is one result, whole: a separator line, an injected heading,
    // or a joined second payload all break these two equalities.
    expect(await viewBlocks.first().innerText()).toBe(
      toolText(describeView({ qualifiedName: 'public.recent_orders' }, expected)),
    );
    expect(await viewBlocks.last().innerText()).toBe(
      toolText(getConceptContext({ name: 'recent_orders' }, expected)),
    );
    // The fidelity boundary is stated on the surface that makes the claim.
    await expect(viewAi).toContainText('the text of one MCP tool result');
    await expect(viewAi).toContainText('not reproduced here yet');
  }

  // F1: overview cards carry counts and annotation coverage.
  await expect(page.getByTestId('card-alpha')).toContainText('tables');
  await expect(page.getByTestId('card-alpha')).toContainText('annotated');

  // F4: cross-database search finds a fixture relation and jumps to it.
  await page.getByPlaceholder(/Search all databases/).fill('customers');
  const results = page.getByTestId('search-results');
  await expect(results).toBeVisible();
  await results.getByRole('button').filter({ hasText: 'public.customers' }).first().click();
  await expect(page.getByTestId('detail-pane')).toContainText('public.customers');

  await app.close();
});
