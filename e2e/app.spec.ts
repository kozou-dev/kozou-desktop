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

/** Read through `getPropertyValue` rather than a camelCase field, and typed as
 *  the one method that is called. Both because this suite typechecks under the
 *  node tsconfig, which has no DOM globals - and because a hand-written record of
 *  camelCase fields makes the type authoritative over the real API: a misspelled
 *  or renamed field then reads `undefined`, and `undefined !== '0px'` is true, so
 *  the assertion passes forever. `getPropertyValue` answers '' for a property it
 *  does not know, which fails these comparisons instead of passing them. */
type StyleReader = { getPropertyValue: (property: string) => string };

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
    // message instead of a bare not-found timeout on the rail item. The rail is
    // what a saved profile always appears in: saving auto-inspects, which
    // selects the profile, and the card grid is the all-databases view — not on
    // screen while a profile is selected.
    const railItem = page.getByTestId(`rail-${name}`);
    const err = page.getByTestId('form-error');
    await expect(railItem.or(err).first()).toBeVisible();
    await expect(err).toHaveCount(0);
    await expect(railItem).toBeVisible();
    // Saving auto-inspects the new profile.
    await expect(page.getByTestId('inspect-stats')).toBeVisible({ timeout: 60_000 });
  }

  for (const name of ['alpha', 'beta']) {
    // Selected from the rail, which is one line per database and holds nothing
    // interactive of its own. The card in the all-databases view is still
    // clickable, and clicking it at the centre is still unreliable — it is a
    // button wrapping interactive children (the row-access links, the MCP links)
    // that each stop propagation, and measured, adding one row put the centre on
    // `enable browsing`. A rail line cannot land in that state.
    await page.getByTestId(`rail-${name}`).click();
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

  // Exactly one of the two views is mounted, and each states the row-access
  // level once. The card and the profile bar render that level from the same
  // component, so what has to hold is that they are never both on screen — two
  // live copies of a claim is how one of them ends up corrected and the other
  // left standing (this app has paid for that once already).
  await expect(page.getByTestId('profile-bar')).toBeVisible();
  await expect(page.getByTestId('overview-cards')).toHaveCount(0);
  await expect(page.getByTestId('rowaccess-badge-beta')).toHaveCount(1);

  // The way to grant row access is a control, and on this surface it is a real
  // one. Two attempts at the discoverability of this thing changed only the
  // wording; it was a bare run of blue words beside a bordered status badge, with
  // no border, background or padding of its own. Asserted as the box it now draws
  // rather than as a class name, because a class says nothing about what is on
  // screen.
  const grant = page.getByTestId('rowaccess-enable-beta');
  const box = async (loc: typeof grant): Promise<{ tag: string; h: number; w: number; border: string; bg: string }> =>
    loc.evaluate((el) => {
      const s = (globalThis as unknown as { getComputedStyle: (e: unknown) => StyleReader })
        .getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        h: Math.round(r.height),
        w: Math.round(r.width),
        border: s.getPropertyValue('border-top-color'),
        bg: s.getPropertyValue('background-color'),
      };
    });
  const barGrant = await box(grant);
  // A real <button> here, so Enter and Space work without this app reimplementing
  // them. The card cannot have one (it is itself a <button>) and keeps the span.
  expect(barGrant.tag).toBe('BUTTON');
  // The box, not "has some border and some background": a bare <button> with this
  // app's rule deleted still carries Chromium's own 2px border, #efefef fill and
  // 6px padding, so three inequalities on those pass while the control is back to
  // a run of text. Measured here: 109x22 against the 92x14 it replaced, and the
  // app's own blue rather than the platform's grey.
  expect(barGrant.h).toBeGreaterThanOrEqual(20);
  expect(barGrant.w).toBeGreaterThanOrEqual(100);
  expect(barGrant.border).toBe('rgb(47, 111, 237)');
  expect(barGrant.bg).toBe('rgb(238, 243, 255)');

  // F1: the all-databases view puts every profile side by side, which is what
  // makes coverage comparable; the cards carry counts and annotation coverage.
  await page.getByTestId('rail-all').click();
  await expect(page.getByTestId('overview-cards')).toBeVisible();
  await expect(page.getByTestId('profile-bar')).toHaveCount(0);
  await expect(page.getByTestId('rowaccess-badge-beta')).toHaveCount(1);

  // On the card it is a span carrying role=button, and it has to stay one: nesting
  // a <button> in the card's own <button> is invalid HTML, and the browser's repair
  // for it is to close the outer element early - which would take the rest of the
  // card out of the button that selects the profile. Same presentation either way.
  const cardSpan = page.getByTestId('rowaccess-enable-beta');
  const cardGrant = await box(cardSpan);
  const cardRole = await cardSpan.evaluate((el) => ({
    role: el.getAttribute('role'),
    focusable: el.getAttribute('tabindex'),
  }));
  expect(cardGrant.tag).toBe('SPAN');
  expect(cardRole).toEqual({ role: 'button', focusable: '0' });
  // Same presentation on both surfaces - measured against the bar's own numbers
  // rather than restated, since "they match" is the property and two separate
  // property sets would not notice them drifting apart.
  expect({ h: cardGrant.h, w: cardGrant.w, border: cardGrant.border, bg: cardGrant.bg }).toEqual({
    h: barGrant.h,
    w: barGrant.w,
    border: barGrant.border,
    bg: barGrant.bg,
  });
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
