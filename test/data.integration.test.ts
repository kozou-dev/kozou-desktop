// Integration tests for the row-data core against a real PostgreSQL: the same
// module the utilityProcess entry runs, driven in plain Node.
//
// These measure the claims that only a real server can settle:
//
//   1. the server itself refuses a write inside the transaction our read path
//      opens (`BEGIN READ ONLY` -> 25006) and honours the per-transaction
//      statement timeout our envelope sets (57014);
//   2. a 'read' runner refuses a mutation, and the table is unchanged;
//   3. a 4xx leaves the transaction usable: a unique violation is followed by a
//      successful insert on the same worker;
//   4. an invalid date reaches PostgreSQL as a class-22 error (it is
//      deliberately not pre-flighted) — and neither the returned message nor
//      anything written to stderr contains the offending value;
//   5. a value larger than the wire budget is cut out of a browse page and
//      reported, while the same row read through `get` stays whole — and a
//      cursor built from an oversized ordering value is withheld rather than
//      handed back for a hop main would refuse.
//
// The statement *sequence* the runner issues is pinned by the unit suite
// (dataRunner.test.ts) with a fake pool; together the two cover the read-only
// guarantee without either having to assume the other.
//
// Requires a reachable PostgreSQL: set KOZOU_TEST_DATABASE_URL (the CI job
// provisions postgres:16 + fixtures/contract.sql — same as contract.test.ts).

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DATA_MAX_CONTROL_CHARS,
  DATA_VALUE_BUDGET,
  type DataResult,
} from '../src/shared/types.js';
import { openDataRunner, type DataRunner } from '../src/worker/runData.js';

const url = process.env.KOZOU_TEST_DATABASE_URL;

/** Marker on every row this suite creates, so cleanup can find them even if a
 *  test fails half way through. */
const MARK = 'data-integration@example.test';

/** Its own marker: `email` is UNIQUE, so the oversized row must not collide
 *  with the rows the mutation tests insert and delete under MARK. */
const BULK_MARK = 'data-integration-bulk@example.test';

type PgErrorLike = { code?: string };

function bodyOf(result: DataResult): unknown {
  return result.ok ? result.body : undefined;
}

function rowsOf(result: DataResult): Record<string, unknown>[] {
  const rows = (bodyOf(result) as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function row(result: DataResult): Record<string, unknown> {
  return (bodyOf(result) ?? {}) as Record<string, unknown>;
}

function totalOf(result: DataResult): unknown {
  return (bodyOf(result) as { total?: unknown } | undefined)?.total;
}

describe.skipIf(!url)('row data against a real database', () => {
  let readRunner: DataRunner;
  let writeRunner: DataRunner;
  let pool: Pool;

  beforeAll(async () => {
    readRunner = await openDataRunner({ url: url!, schemas: ['public'], capability: 'read' });
    writeRunner = await openDataRunner({ url: url!, schemas: ['public'], capability: 'readwrite' });
    pool = new Pool({ connectionString: url!, max: 2 });
  });

  afterAll(async () => {
    await pool?.query('DELETE FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE email = $1)', [MARK]);
    await pool?.query('DELETE FROM customers WHERE email = ANY($1)', [[MARK, BULK_MARK]]);
    await pool?.end();
    await readRunner?.close();
    await writeRunner?.close();
  });

  it('the server refuses a write inside the transaction the read path opens', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      let code: string | undefined;
      try {
        await client.query("INSERT INTO customers (name) VALUES ('should not land')");
      } catch (err) {
        code = (err as PgErrorLike).code;
      }
      // 25006 = read_only_sql_transaction. This is the database enforcing it,
      // not our SQL choosing not to write.
      expect(code).toBe('25006');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('the server honours the per-transaction statement timeout the envelope sets', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL statement_timeout = 100');
      let code: string | undefined;
      try {
        await client.query('SELECT pg_sleep(1)');
      } catch (err) {
        code = (err as PgErrorLike).code;
      }
      // 57014 = query_canceled: the statement timeout fired.
      expect(code).toBe('57014');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('lists rows on a read runner', async () => {
    const result = await readRunner.run({ kind: 'list', resource: 'customers' });
    expect(result.ok).toBe(true);
    expect(rowsOf(result).length).toBeGreaterThan(0);
    // count=none is unconditional, so a page carries no total.
    expect(totalOf(result)).toBeNull();
  });

  it('cuts an oversized value out of a real page, and hands the same row over in full on a get', async () => {
    const size = DATA_VALUE_BUDGET * 3;
    await pool.query('INSERT INTO customers (name, email) VALUES (repeat($1, $2), $3)', [
      'x',
      size,
      BULK_MARK,
    ]);
    try {
      const page = await readRunner.run({
        kind: 'list',
        resource: 'customers',
        params: { filters: [['email', `eq.${BULK_MARK}`]] },
      });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      const rows = rowsOf(page);
      expect(rows).toHaveLength(1);
      expect((rows[0]!.name as string).length).toBe(DATA_VALUE_BUDGET);
      expect(page.truncated).toEqual([{ row: 0, column: 'name', kind: 'text', size }]);

      // The other half of the rule: a single row is bounded by being one row, so
      // the value stays whole on the path an editor reads through.
      const full = await readRunner.run({
        kind: 'get',
        resource: 'customers',
        id: String(rows[0]!.id),
      });
      expect(full.ok).toBe(true);
      if (!full.ok) return;
      expect((row(full).name as string).length).toBe(size);
      expect(full.truncated).toBeUndefined();
    } finally {
      await pool.query('DELETE FROM customers WHERE email = $1', [BULK_MARK]);
    }
  });

  it('withholds a real cursor built from an oversized ordering value', async () => {
    // The second way a row value can leave the worker. @kozou/api builds a
    // cursor from the boundary row's ORDER BY values, so sorting by a large text
    // column carries its full length inside the cursor even though the cell was
    // cut. Measured before this guard existed: a 2,048-character value produced
    // a 2,799-character cursor. Past DATA_MAX_CONTROL_CHARS main would refuse
    // the cursor on the next hop, so the walk has to end here and say so.
    const size = DATA_MAX_CONTROL_CHARS;
    // Leading '0' so the row sorts first ascending under any collation the test
    // database happens to use — digits precede letters in both C and en_US, while
    // 'c' versus 'Grace' flips between them. The boundary row of page 1 has to be
    // this row for the cursor under test to be built from its value.
    await pool.query("INSERT INTO customers (name, email) VALUES ('0' || repeat($1, $2), $3)", [
      'c',
      size - 1,
      BULK_MARK,
    ]);
    try {
      const page = await readRunner.run({
        kind: 'list',
        resource: 'customers',
        params: { pageSize: 1, sort: 'name.asc' },
      });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      const body = page.body as { rows: Record<string, unknown>[]; nextCursor: unknown };
      expect((body.rows[0]!.name as string).startsWith('0c')).toBe(true);
      expect((body.rows[0]!.name as string).length).toBe(DATA_VALUE_BUDGET);
      expect(page.truncated?.[0]).toEqual({
        row: 0,
        column: 'name',
        kind: 'text',
        size,
      });
      expect(page.droppedCursors).toEqual(['next']);
      expect(body.nextCursor).toBeNull();
    } finally {
      await pool.query('DELETE FROM customers WHERE email = $1', [BULK_MARK]);
    }
  });

  it('hands a date back as the server wrote it, not as an instant derived from it', async () => {
    // The driver's default parser turns a `date` into a Date at LOCAL midnight,
    // so rendering it as an instant moves it: `2026-08-01` becomes
    // `2026-07-31T15:00:00.000Z` under a UTC+9 clock. That is a browse cell
    // naming the wrong day and — worse — an edit form offering the wrong day
    // back for saving, since the editor seeds from this very path. The runner's
    // pool therefore keeps this family as PostgreSQL's own text.
    //
    // Asserting the string equals the stored date is what fails if the override
    // is removed: a Date would arrive here instead, and (under any non-UTC
    // clock) one naming a different day.
    const day = '2026-08-01';
    await pool.query('INSERT INTO customers (name, email, birthday) VALUES ($1, $2, $3)', [
      'Date fidelity',
      BULK_MARK,
      day,
    ]);
    try {
      const page = await readRunner.run({
        kind: 'list',
        resource: 'customers',
        params: { filters: [['email', `eq.${BULK_MARK}`]] },
      });
      expect(page.ok).toBe(true);
      const [only] = rowsOf(page);
      expect(only?.birthday).toBe(day);

      // The same on the path the editor reads through.
      const full = await readRunner.run({
        kind: 'get',
        resource: 'customers',
        id: String(only!.id),
      });
      expect(row(full).birthday).toBe(day);

      // And the text is accepted back unchanged, which is the property that
      // makes it safe to seed an editor with.
      const saved = await writeRunner.run({
        kind: 'update',
        resource: 'customers',
        id: String(only!.id),
        values: { birthday: String(row(full).birthday) },
      });
      expect(saved.ok).toBe(true);
      expect(row(saved).birthday).toBe(day);
    } finally {
      await pool.query('DELETE FROM customers WHERE email = $1', [BULK_MARK]);
    }
  });

  it('hands every temporal type over as text, not as a JavaScript object', async () => {
    // The other five OIDs the pool overrides. Each of them parses, by default,
    // into something that does not convert back: a `timestamp` and a `time`
    // become Dates built from the LOCAL clock, and an `interval` becomes an
    // object with no textual form PostgreSQL accepts at all. Asserting the exact
    // strings is what fails if any one of them is dropped from the override.
    const page = await readRunner.run({ kind: 'list', resource: 'audit_log' });
    expect(page.ok).toBe(true);
    const [only] = rowsOf(page);
    expect(typeof only?.at).toBe('string');
    expect(only?.noted_at).toBe('2026-08-01 09:30:00');
    expect(only?.shift_start).toBe('09:30:00');
    expect(only?.span).toBe('1 day 02:00:00');
  });

  it('bounds the row a mutation returns, without bounding what was written', async () => {
    // INSERT/UPDATE/DELETE come back with every exposed column of the affected
    // row, so a one-column edit of a row that also holds a large value would
    // otherwise clone that value across both IPC hops for a reply the UI reads
    // only the outcome of.
    const size = DATA_VALUE_BUDGET * 3;
    const created = await writeRunner.run({
      kind: 'insert',
      resource: 'customers',
      values: { name: 'x'.repeat(size), email: BULK_MARK },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = String(row(created).id);
    try {
      expect((row(created).name as string).length).toBe(DATA_VALUE_BUDGET);
      expect(created.truncated).toEqual([{ row: 0, column: 'name', kind: 'text', size }]);

      // The reply was cut; the row was not. This is the half that keeps "we
      // bound the reply" from quietly meaning "we wrote less than you gave us".
      const stored = await pool.query<{ n: number }>(
        'SELECT length(name)::int AS n FROM customers WHERE id = $1',
        [id],
      );
      expect(stored.rows[0]!.n).toBe(size);

      const updated = await writeRunner.run({
        kind: 'update',
        resource: 'customers',
        id,
        values: { birthday: '2026-08-02' },
      });
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect((row(updated).name as string).length).toBe(DATA_VALUE_BUDGET);
      expect(updated.truncated?.[0]?.column).toBe('name');
    } finally {
      await pool.query('DELETE FROM customers WHERE email = $1', [BULK_MARK]);
    }
  });

  it('refuses a mutation on a read runner and leaves the table unchanged', async () => {
    const before = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM customers');
    const result = await readRunner.run({
      kind: 'insert',
      resource: 'customers',
      values: { name: 'must not land', email: MARK },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    const after = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM customers');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('round-trips insert -> get -> update -> delete on a readwrite runner', async () => {
    const created = await writeRunner.run({
      kind: 'insert',
      resource: 'customers',
      values: { name: 'Integration', email: MARK },
    });
    expect(created.ok).toBe(true);
    const id = String(row(created).id);

    const fetched = await writeRunner.run({ kind: 'get', resource: 'customers', id });
    expect(fetched.ok).toBe(true);
    expect(row(fetched).name).toBe('Integration');

    const updated = await writeRunner.run({
      kind: 'update',
      resource: 'customers',
      id,
      values: { name: 'Integration renamed' },
    });
    expect(updated.ok).toBe(true);
    expect(row(updated).name).toBe('Integration renamed');

    const deleted = await writeRunner.run({ kind: 'delete', resource: 'customers', id });
    expect(deleted.ok).toBe(true);

    const gone = await writeRunner.run({ kind: 'get', resource: 'customers', id });
    expect(gone.ok).toBe(false);
    if (gone.ok) return;
    expect(gone.status).toBe(404);
    expect(gone.message).not.toContain(id);
  });

  it('keeps the connection usable after a 4xx: a conflict, then a successful insert', async () => {
    const first = await writeRunner.run({
      kind: 'insert',
      resource: 'customers',
      values: { name: 'Conflict source', email: MARK },
    });
    expect(first.ok).toBe(true);
    const firstId = String(row(first).id);

    // customers.email is UNIQUE: the same address is a 23505 -> 409, which
    // leaves the transaction aborted inside the handler.
    const conflict = await writeRunner.run({
      kind: 'insert',
      resource: 'customers',
      values: { name: 'Conflict duplicate', email: MARK },
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.status).toBe(409);
      expect(conflict.code).toBe('conflict');
      expect(conflict.message).not.toContain(MARK);
    }

    // The very next operation on the same runner must succeed — the aborted
    // transaction was rolled back explicitly rather than left to COMMIT.
    const after = await writeRunner.run({
      kind: 'insert',
      resource: 'customers',
      values: { name: 'After conflict' },
    });
    expect(after.ok).toBe(true);
    const afterId = String(row(after).id);

    await writeRunner.run({ kind: 'delete', resource: 'customers', id: firstId });
    await writeRunner.run({ kind: 'delete', resource: 'customers', id: afterId });
  });

  it('negative control: an invalid date leaks neither into the result nor into stderr', async () => {
    const customer = await writeRunner.run({
      kind: 'insert',
      resource: 'customers',
      values: { name: 'Date control', email: MARK },
    });
    expect(customer.ok).toBe(true);
    const customerId = row(customer).id;

    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);

    // A timestamptz value is deliberately NOT pre-flighted by @kozou/api, so
    // this reaches PostgreSQL and comes back as a class-22 error — the one path
    // where the database's own message quotes the offending value.
    const result = await writeRunner.run({
      kind: 'insert',
      resource: 'orders',
      values: {
        customer_id: customerId,
        status: 'draft',
        total_cents: 100,
        placed_at: '1999-99-99T00:00:00Z',
      },
    });
    spy.mockRestore();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
    expect(result.code).toBe('failed');
    expect(result.message).not.toContain('1999-99-99');

    const log = written.join('');
    expect(log).not.toContain('1999-99-99');
    expect(log).not.toContain('invalid input syntax');
    expect(log).toContain('operation failed with status 500');

    await writeRunner.run({ kind: 'delete', resource: 'customers', id: String(customerId) });
  });

  it('refuses a write to a view with a controlled message', async () => {
    const result = await writeRunner.run({
      kind: 'insert',
      resource: 'recent_orders',
      values: { customer_name: 'nope' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(405);
    expect(result.code).toBe('read_only');
    expect(result.message).not.toContain('recent_orders');
  });
});
