// The DDL generator. Two things are worth pinning hard here, because both fail
// silently: the escaping (a comment body is inlined as a literal — PostgreSQL's
// COMMENT takes no bind parameter), and the relation keyword (`COMMENT ON VIEW`
// against a materialized view is an error, and so is the reverse).
//
// The structural properties below are what a unit test can establish. That the
// statements are ACCEPTED by PostgreSQL, and that applying one preserves the
// tags around it, is the integration test's job (test/comment.integration.test.ts).

import { describe, expect, it } from 'vitest';
import { quoteIdent as kozouQuoteIdent } from '@kozou/core';
import {
  commentTextProblem,
  describeTarget,
  draftsToSqlFile,
  emitComment,
  quoteIdent,
  quoteLiteral,
  type CommentDraft,
  type CommentTarget,
} from '../src/renderer/src/lib/commentEmit.js';

/** A deterministic generator, so a property failure is reproducible from the
 *  seed rather than gone by the next run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** The character classes that break naive quoting: the quote itself, the
 *  backslash (an escape under the non-default `standard_conforming_strings =
 *  off`), statement and comment punctuation, dollar-quote tags, newlines, and
 *  multibyte text. NUL is deliberately absent — PostgreSQL text cannot hold one,
 *  and the generator refuses it (asserted separately). */
const NASTY = [
  "'",
  "''",
  '"',
  '\\',
  '\\\\',
  ';',
  '--',
  '/*',
  '*/',
  '$$',
  '$tag$',
  '\n',
  '\r\n',
  '\t',
  ' ',
  'a',
  'Z',
  '0',
  '@ai:',
  '@widget: currency',
  'uber',
  'über',
  '🚀',
];

function randomBody(next: () => number, maxParts: number): string {
  const parts = 1 + Math.floor(next() * maxParts);
  let out = '';
  for (let i = 0; i < parts; i += 1) {
    out += NASTY[Math.floor(next() * NASTY.length)];
  }
  return out;
}

/** Undo `quoteLiteral` textually: strip the wrapping quotes and collapse the
 *  doubled ones. That is what PostgreSQL's lexer does to a standard literal, so
 *  agreeing with it is the round-trip property the escaping has to hold. */
function unquoteLiteral(literal: string): string {
  expect(literal.startsWith("'")).toBe(true);
  expect(literal.endsWith("'")).toBe(true);
  return literal.slice(1, -1).replace(/''/g, "'");
}

const TABLE: CommentTarget = { kind: 'table', schema: 'public', name: 'customers' };
const VIEW: CommentTarget = {
  kind: 'view',
  schema: 'public',
  name: 'recent_orders',
  materialized: false,
};
const MATVIEW: CommentTarget = {
  kind: 'view',
  schema: 'public',
  name: 'customer_totals',
  materialized: true,
};
const COLUMN: CommentTarget = {
  kind: 'column',
  schema: 'public',
  relation: 'customers',
  column: 'email',
};

describe('quoteIdent', () => {
  it('is character-for-character the quoting @kozou/core does', () => {
    // Restated rather than imported (the barrel reaches filesystem and JWT code
    // that has no business in a renderer bundle), so the two are pinned to each
    // other here. A divergence upstream fails this test, not a user's schema.
    const next = lcg(20_260_801);
    const samples = ['id', 'Mixed Case', 'quote"inside', 'quote""twice', '', 'schema.name'];
    for (let i = 0; i < 500; i += 1) samples.push(randomBody(next, 4));
    for (const sample of samples) {
      expect(quoteIdent(sample)).toBe(kozouQuoteIdent(sample));
    }
  });

  it('doubles embedded quotes and always wraps', () => {
    expect(quoteIdent('customers')).toBe('"customers"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
});

describe('quoteLiteral', () => {
  it('doubles single quotes and wraps', () => {
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(quoteLiteral('')).toBe("''");
  });

  it('leaves a backslash alone (standard_conforming_strings, the default)', () => {
    expect(quoteLiteral('a\\b')).toBe("'a\\b'");
  });

  it('round-trips every generated body, and never leaves a bare quote inside', () => {
    const next = lcg(424_242);
    for (let i = 0; i < 2_000; i += 1) {
      const body = randomBody(next, 12);
      const literal = quoteLiteral(body);
      expect(unquoteLiteral(literal)).toBe(body);
      // The lexer ends a literal at the first quote that is not doubled, so
      // "every interior quote comes in a pair" is the property that keeps a
      // comment body from turning into syntax.
      expect(literal.slice(1, -1).replace(/''/g, '')).not.toContain("'");
    }
  });

  it('round-trips multibyte and newline-heavy bodies', () => {
    for (const body of ['a\nb\r\nc', '\t\tOmega', "one\n@ai: it's fine\n@policy: don't"]) {
      expect(unquoteLiteral(quoteLiteral(body))).toBe(body);
    }
  });
});

describe('emitComment', () => {
  it('names a table, a view and a materialized view with the keyword each needs', () => {
    expect(emitComment(TABLE, 'People.')).toBe(
      `COMMENT ON TABLE "public"."customers" IS 'People.';`,
    );
    expect(emitComment(VIEW, 'Recent.')).toBe(
      `COMMENT ON VIEW "public"."recent_orders" IS 'Recent.';`,
    );
    expect(emitComment(MATVIEW, 'Totals.')).toBe(
      `COMMENT ON MATERIALIZED VIEW "public"."customer_totals" IS 'Totals.';`,
    );
  });

  it('addresses a column through its relation, whatever kind that relation is', () => {
    expect(emitComment(COLUMN, 'Contact.')).toBe(
      `COMMENT ON COLUMN "public"."customers"."email" IS 'Contact.';`,
    );
  });

  it('quotes identifiers, so a schema or relation name cannot become syntax', () => {
    const target: CommentTarget = { kind: 'table', schema: 'we"ird', name: 'na me' };
    expect(emitComment(target, 'x')).toBe(`COMMENT ON TABLE "we""ird"."na me" IS 'x';`);
  });

  it('writes removal as IS NULL, for an empty body as much as for none', () => {
    // Measured against PostgreSQL 16: `IS ''` leaves no row in pg_description,
    // exactly like `IS NULL` — there is no such state as an empty comment. The
    // two inputs therefore produce one statement, so an emptied text box and an
    // explicit removal cannot drift into statements that only look different.
    expect(emitComment(TABLE, null)).toBe('COMMENT ON TABLE "public"."customers" IS NULL;');
    expect(emitComment(TABLE, '')).toBe('COMMENT ON TABLE "public"."customers" IS NULL;');
  });

  it('carries a generated body through unchanged, for every target kind', () => {
    const next = lcg(7_777);
    for (const target of [TABLE, VIEW, MATVIEW, COLUMN]) {
      for (let i = 0; i < 300; i += 1) {
        const body = randomBody(next, 10);
        const sql = emitComment(target, body);
        expect(sql.endsWith(';')).toBe(true);
        // Everything from the first ` IS '` to the trailing `;` is the literal.
        const literal = sql.slice(sql.indexOf(" IS '") + 4, -1);
        expect(unquoteLiteral(literal)).toBe(body);
      }
    }
  });

  it('refuses a body PostgreSQL text cannot hold', () => {
    const withNul = 'before\u0000after';
    expect(commentTextProblem(withNul)).toMatch(/NUL/);
    expect(() => emitComment(TABLE, withNul)).toThrow(/NUL/);
    // Everything else is emittable: the check is one specific impossibility,
    // not a general-purpose content filter.
    expect(commentTextProblem("it's\n@ai: fine\\")).toBeNull();
    expect(commentTextProblem('')).toBeNull();
  });
});

describe('describeTarget / draftsToSqlFile', () => {
  it('labels each target by its qualified name', () => {
    expect(describeTarget(TABLE)).toBe('public.customers');
    expect(describeTarget(MATVIEW)).toBe('public.customer_totals');
    expect(describeTarget(COLUMN)).toBe('public.customers.email');
  });

  it('writes a file that says nothing has been applied', () => {
    const drafts: CommentDraft[] = [
      { id: 1, profile: 'p', target: 'public.customers', sql: emitComment(TABLE, 'People.') },
      { id: 2, profile: 'p', target: 'public.customers.email', sql: emitComment(COLUMN, null) },
    ];
    const file = draftsToSqlFile(drafts);
    expect(file).toContain('never runs them');
    expect(file).toContain(drafts[0]!.sql);
    expect(file).toContain(drafts[1]!.sql);
    // One statement per line, each terminated: the file is meant to be piped
    // into psql exactly as it stands.
    for (const line of file.split('\n').filter((l) => l !== '' && !l.startsWith('--'))) {
      expect(line.endsWith(';')).toBe(true);
    }
  });
});
