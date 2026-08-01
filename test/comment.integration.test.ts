// COMMENT emit against a real database — the half a unit test cannot reach.
//
// Three claims are settled here, and each one is a bug the design exists to
// prevent rather than a formality:
//
//   1. `description` is NOT the comment the author wrote. The context builder
//      lifts `@widget:` and `@example:` out of it, so an editor seeded from it
//      deletes them on the first save. The negative control below performs that
//      exact mistake against a real database and watches the widget disappear.
//   2. A materialized view needs its own keyword. `COMMENT ON VIEW` against one
//      is an error, so introspection reporting 'v' and 'm' as one kind is not a
//      distinction the app can skip.
//   3. The escaping holds for text PostgreSQL actually stores. Quotes,
//      backslashes, newlines and multibyte characters go out through the
//      generator and come back through introspection unchanged.
//
// Requires a reachable PostgreSQL: set KOZOU_TEST_DATABASE_URL (the CI job
// provisions postgres:16 + fixtures/contract.sql).

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContextView, TableView, ViewView } from '../src/shared/contextView.js';
import { trimContext } from '../src/shared/trim.js';
import { emitComment, type CommentTarget } from '../src/renderer/src/lib/commentEmit.js';
import { fetchMaterializedViews } from '../src/worker/relkind.js';
import { runInspect } from '../src/worker/runInspect.js';

const url = process.env.KOZOU_TEST_DATABASE_URL;

/** A schema of this test's own. The shared `public` fixture is read here but
 *  never written: `test/contract.test.ts` deep-equals a whole context against
 *  the CLI's, and a COMMENT changing underneath that comparison would make it
 *  flaky. Everything that mutates happens in here, and other suites inspect
 *  `public` only, so this schema is invisible to them. */
const S = 'kozou_emit_roundtrip';

/** The renderer payload, built exactly the way the inspect worker builds it. */
async function inspectAs(schemas: string[]): Promise<ContextView> {
  const { context } = await runInspect({ url: url!, schemas });
  const materializedViews = await fetchMaterializedViews({ url: url!, schemas });
  return trimContext(context as unknown as Record<string, unknown>, {
    ...(materializedViews !== undefined ? { materializedViews } : {}),
  }) as unknown as ContextView;
}

async function runSql(sql: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Apply a statement and report the database's refusal instead of throwing. */
async function trySql(sql: string): Promise<string | null> {
  try {
    await runSql(sql);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const table = (ctx: ContextView, name: string): TableView => {
  const found = ctx.tables.find((t) => t.qualifiedName === `${S}.${name}`);
  if (!found) throw new Error(`no table ${name}`);
  return found;
};
const view = (ctx: ContextView, name: string): ViewView => {
  const found = ctx.views.find((v) => v.qualifiedName === `${S}.${name}`);
  if (!found) throw new Error(`no view ${name}`);
  return found;
};

/** Literal quoting for the fixture statements only. The generator under test is
 *  never used to set up its own expectations. */
const lit = (text: string): string => "'" + text.replace(/'/g, "''") + "'";

const DOC_COMMENT = 'Original headline.\n@ai: keep this line\n@policy: and this one';
const NOTE_COMMENT = 'Original column headline.\n@widget: textarea';
const SNAP_COMMENT = 'Snapshot.\n@example: everything\n  SELECT id FROM ' + S + '.snap;';

/** Reset the test schema's comments, so every case starts from the same place
 *  whatever the one before it did. */
async function resetComments(): Promise<void> {
  await runSql(`
    COMMENT ON TABLE ${S}.doc IS ${lit(DOC_COMMENT)};
    COMMENT ON COLUMN ${S}.doc.note IS ${lit(NOTE_COMMENT)};
    COMMENT ON MATERIALIZED VIEW ${S}.snap IS ${lit(SNAP_COMMENT)};
  `);
}

describe.skipIf(!url)('COMMENT emit against a real database', () => {
  beforeAll(async () => {
    await runSql(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await runSql(`
      CREATE SCHEMA ${S};
      CREATE TABLE ${S}.doc (id int PRIMARY KEY, note text);
      INSERT INTO ${S}.doc VALUES (1, 'a');
      CREATE VIEW ${S}.live AS SELECT id FROM ${S}.doc;
      CREATE MATERIALIZED VIEW ${S}.snap AS SELECT id FROM ${S}.doc;
      COMMENT ON VIEW ${S}.live IS 'An ordinary view.';
    `);
    await resetComments();
  }, 120_000);

  afterAll(async () => {
    if (url) await runSql(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
  }, 120_000);

  it('carries the verbatim comment where description has already lost the tags', async () => {
    const ctx = await inspectAs([S]);

    // The column: `@widget:` is gone from `description`, present in `rawComment`.
    const note = table(ctx, 'doc').columns.find((c) => c.name === 'note')!;
    expect(note.rawComment).toBe(NOTE_COMMENT);
    expect(note.description ?? '').not.toContain('@widget');
    expect(note.widget).toBe('textarea');

    // The relation: same story for an `@example:` block.
    const snap = view(ctx, 'snap');
    expect(snap.rawComment).toBe(SNAP_COMMENT);
    expect(snap.description ?? '').not.toContain('@example');

    // `@ai:`/`@policy:` are the other case — retained in `description`, so the
    // verbatim text and the rendered one agree for a comment that has only those.
    expect(table(ctx, 'doc').rawComment).toBe(DOC_COMMENT);
  });

  it('tells an ordinary view from a materialized one', async () => {
    const ctx = await inspectAs([S]);
    expect(view(ctx, 'live').materialized).toBe(false);
    expect(view(ctx, 'snap').materialized).toBe(true);
  });

  it('applies an edited relation comment and keeps every other tag', async () => {
    await resetComments();
    const before = table(await inspectAs([S]), 'doc');

    // The edit a user makes: the first line, seeded from the verbatim text.
    const edited = before.rawComment!.replace('Original headline.', 'Edited headline.');
    const target: CommentTarget = { kind: 'table', schema: S, name: 'doc' };
    expect(await trySql(emitComment(target, edited))).toBeNull();

    const after = table(await inspectAs([S]), 'doc');
    expect(after.rawComment).toBe(edited);
    expect(after.description).toContain('Edited headline.');
    expect(after.aiDescription).toContain('keep this line');
    expect(after.policy ?? []).toEqual(['and this one']);
  });

  it('applies an edited column comment and keeps the widget the tag chose', async () => {
    await resetComments();
    const seed = table(await inspectAs([S]), 'doc').columns.find((c) => c.name === 'note')!;

    const edited = seed.rawComment!.replace('Original column headline.', 'Edited column.');
    const target: CommentTarget = { kind: 'column', schema: S, relation: 'doc', column: 'note' };
    expect(await trySql(emitComment(target, edited))).toBeNull();

    const after = table(await inspectAs([S]), 'doc').columns.find((c) => c.name === 'note')!;
    expect(after.rawComment).toBe(edited);
    expect(after.description).toContain('Edited column.');
    expect(after.widget).toBe('textarea');
  });

  it('NEGATIVE CONTROL: seeding from description really does delete the tag', async () => {
    // Not a hypothetical. Do the wrong thing on purpose — take the RENDERED
    // description as the seed, the way an editor would if `rawComment` had not
    // been lifted — and watch `@widget:` leave the database.
    await resetComments();
    const seed = table(await inspectAs([S]), 'doc').columns.find((c) => c.name === 'note')!;
    expect(seed.widget).toBe('textarea');

    const wrong = (seed.description ?? '').replace('Original column headline.', 'Edited column.');
    const target: CommentTarget = { kind: 'column', schema: S, relation: 'doc', column: 'note' };
    expect(await trySql(emitComment(target, wrong))).toBeNull();

    const after = table(await inspectAs([S]), 'doc').columns.find((c) => c.name === 'note')!;
    expect(after.rawComment).not.toContain('@widget');
    // The heuristic takes over: the author's choice is gone, silently.
    expect(after.widget).toBe('text');

    await resetComments();
  });

  it('needs the keyword it emits: each relation kind refuses the other', async () => {
    await resetComments();
    const snap: CommentTarget = { kind: 'view', schema: S, name: 'snap', materialized: true };
    const live: CommentTarget = { kind: 'view', schema: S, name: 'live', materialized: false };

    // What the app emits, given the relkind it read.
    expect(await trySql(emitComment(snap, 'Materialized, named as one.'))).toBeNull();
    expect(await trySql(emitComment(live, 'Ordinary, named as one.'))).toBeNull();

    // What it would emit if the relkind were guessed. Both are refused, which
    // is why "unknown" may never render as "ordinary view".
    const guessedOrdinary: CommentTarget = { ...snap, materialized: false };
    const guessedMaterialized: CommentTarget = { ...live, materialized: true };
    expect(await trySql(emitComment(guessedOrdinary, 'x'))).toMatch(/"snap" is not a view/i);
    expect(await trySql(emitComment(guessedMaterialized, 'x'))).toMatch(
      /"live" is not a materialized view/i,
    );

    const ctx = await inspectAs([S]);
    expect(view(ctx, 'snap').rawComment).toBe('Materialized, named as one.');
    expect(view(ctx, 'live').rawComment).toBe('Ordinary, named as one.');
  });

  it('round-trips a body full of quotes, backslashes, newlines and multibyte text', async () => {
    const nasty = [
      "it's a 'quoted' word, and ''already doubled''",
      'a backslash \\ and a double \\\\ one',
      'semicolons; comment markers -- and /* block */ starts',
      'a dollar-quote tag $$ and $body$',
      'multibyte: uber, Grusse, rocket',
      '@ai: a tag line that must survive verbatim',
      '\ttabbed\tand trailing spaces   ',
    ].join('\n');

    const target: CommentTarget = { kind: 'table', schema: S, name: 'doc' };
    expect(await trySql(emitComment(target, nasty))).toBeNull();
    expect(table(await inspectAs([S]), 'doc').rawComment).toBe(nasty);

    // And the removal path. PostgreSQL has no empty comment — measured here
    // rather than assumed, because the editor's "leave it empty" affordance
    // rests on it: a body of '' must come back as no comment at all.
    expect(await trySql(emitComment(target, null))).toBeNull();
    expect(table(await inspectAs([S]), 'doc').rawComment).toBeNull();

    expect(await trySql(`COMMENT ON TABLE ${S}.doc IS 'back'`)).toBeNull();
    expect(await trySql(emitComment(target, ''))).toBeNull();
    expect(table(await inspectAs([S]), 'doc').rawComment).toBeNull();

    await resetComments();
  });

  it('reads the shared fixture the same way, without writing to it', async () => {
    // The public fixture carries both cases on purpose (a materialized view and
    // a `@widget:` column). Read-only here: contract.test.ts deep-equals that
    // schema against the CLI's own output.
    const ctx = await inspectAs(['public']);
    const totals = ctx.views.find((v) => v.qualifiedName === 'public.customer_totals');
    expect(totals?.materialized).toBe(true);
    expect(ctx.views.find((v) => v.qualifiedName === 'public.recent_orders')?.materialized).toBe(
      false,
    );
    expect(totals?.rawComment ?? '').toContain('@example:');
    expect(totals?.description ?? '').not.toContain('@example:');

    const cents = totals?.columns.find((c) => c.name === 'total_cents');
    expect(cents?.rawComment ?? '').toContain('@widget: currency');
    expect(cents?.description ?? '').not.toContain('@widget');
    expect(cents?.widget).toBe('currency');
  });
});
