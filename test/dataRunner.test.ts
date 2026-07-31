// Transaction-envelope tests for the row-data runner, driven through a fake
// pool so the exact statement sequence is observable without a database. What
// is pinned here is what the row-data design leans on (EGRESS.md items 8, 12):
//
//   - every read path opens `BEGIN READ ONLY` (including a read issued by a
//     readwrite runner) and never commits;
//   - every transaction sets a per-statement timeout;
//   - a `status >= 400` outcome is rolled back EXPLICITLY, not left to
//     COMMIT-on-aborted;
//   - a worker forked for 'read' refuses a mutation before touching the pool;
//   - failure messages are re-authored: no primary key, no row value, no
//     handler body.
//
// The companion integration suite (data.integration.test.ts) measures that a
// real PostgreSQL refuses a write inside the very statement this file pins.

import type { ColumnContext } from '@kozou/core';
import { MAX_PAGE_SIZE, type Resource, type ResourceLookup } from '@kozou/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDataRunner,
  statementTimeoutMs,
  DEFAULT_DATA_TIMEOUT_MS,
  MAX_DATA_TIMEOUT_MS,
  type DataClient,
  type DataPool,
} from '../src/worker/runData.js';
import { DATA_MAX_PAGE_SIZE, type DataCapability } from '../src/shared/types.js';

function column(name: string, dataType: string, extra: Partial<ColumnContext> = {}): ColumnContext {
  return {
    name,
    dataType,
    nullable: true,
    defaultExpr: null,
    isPrimaryKey: false,
    isForeignKey: false,
    label: name,
    description: null,
    ...extra,
  } as unknown as ColumnContext;
}

const CUSTOMERS: Resource = {
  kind: 'table',
  schema: 'public',
  name: 'customers',
  qualifiedName: 'public.customers',
  primaryKey: ['id'],
  relations: [],
  columns: [
    column('id', 'bigint', { isPrimaryKey: true, nullable: false }),
    column('name', 'text', { nullable: false }),
    column('email', 'text'),
    column('joined_on', 'date'),
  ],
};

function lookupOf(...resources: Resource[]): ResourceLookup {
  return {
    resolve: (name) =>
      resources.find((r) => r.name === name || r.qualifiedName === name) ?? undefined,
    list: () => resources.map((r) => r.qualifiedName).sort(),
    reverse: () => [],
  };
}

type Recorded = { text: string; values?: unknown[] };

class FakeClient implements DataClient {
  released = false;
  constructor(
    readonly recorded: Recorded[],
    /** Answers for the data statements (anything that is not part of the
     *  transaction envelope), consumed in order. A function may throw to
     *  simulate a database error. */
    private readonly answers: Array<
      | { rows: Record<string, unknown>[]; rowCount?: number }
      | (() => never)
    >,
  ) {}

  async query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    this.recorded.push({ text, ...(values !== undefined ? { values } : {}) });
    if (isEnvelope(text)) return { rows: [] as R[], rowCount: 0 };
    const answer = this.answers.shift() ?? { rows: [] };
    if (typeof answer === 'function') return answer();
    return { rows: answer.rows as R[], rowCount: answer.rowCount ?? answer.rows.length };
  }

  release(): void {
    this.released = true;
  }
}

/** A client whose COMMIT (or closing ROLLBACK) fails the way a deferred
 *  constraint does: after the statement itself succeeded, with a message that
 *  quotes the row's own values. */
class FailingCommitClient extends FakeClient {
  override async query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    if (text === 'COMMIT' || (text === 'ROLLBACK' && this.recorded.some((r) => r.text.startsWith('SELECT')))) {
      this.recorded.push({ text });
      const err = new Error(
        'new row for relation "customers" violates check constraint: trigger says ada@example.com is invalid',
      ) as Error & { code: string; severity: string };
      err.code = '23514';
      err.severity = 'ERROR';
      throw err;
    }
    return super.query<R>(text, values);
  }
}

function isEnvelope(text: string): boolean {
  return (
    text === 'BEGIN' ||
    text === 'BEGIN READ ONLY' ||
    text === 'COMMIT' ||
    text === 'ROLLBACK' ||
    text.startsWith('SET LOCAL ')
  );
}

function harness(
  capability: DataCapability,
  answers: Array<{ rows: Record<string, unknown>[]; rowCount?: number } | (() => never)> = [],
  timeoutMs?: number,
): { runner: ReturnType<typeof createDataRunner>; recorded: Recorded[]; connects: number } {
  const recorded: Recorded[] = [];
  const state = { connects: 0 };
  const pool: DataPool = {
    connect: async () => {
      state.connects += 1;
      return new FakeClient(recorded, answers);
    },
    end: async () => {},
  };
  const runner = createDataRunner({
    pool,
    lookup: lookupOf(CUSTOMERS),
    capability,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return {
    runner,
    recorded,
    get connects() {
      return state.connects;
    },
  };
}

/** A node-postgres server error, as the classifier recognizes it. */
function pgError(code: string, message: string): () => never {
  return () => {
    const err = new Error(message) as Error & { code: string; severity: string };
    err.code = code;
    err.severity = 'ERROR';
    throw err;
  };
}

const texts = (recorded: Recorded[]): string[] => recorded.map((r) => r.text);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('data runner transaction envelope', () => {
  it('runs a read inside BEGIN READ ONLY with a statement timeout, and never commits', async () => {
    const h = harness('read', [{ rows: [{ id: 1, name: 'Ada' }] }]);
    const result = await h.runner.run({ kind: 'list', resource: 'customers' });

    expect(result.ok).toBe(true);
    const statements = texts(h.recorded);
    expect(statements[0]).toBe('BEGIN READ ONLY');
    expect(statements[1]).toBe(`SET LOCAL statement_timeout = ${DEFAULT_DATA_TIMEOUT_MS}`);
    expect(statements[2]).toMatch(/^SELECT/);
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    // count=none is unconditional: one data statement, no COUNT(*).
    expect(statements.filter((s) => /count/i.test(s))).toEqual([]);
  });

  it('reads through a READ ONLY transaction even on a readwrite worker', async () => {
    const h = harness('readwrite', [{ rows: [] }]);
    await h.runner.run({ kind: 'list', resource: 'customers' });
    expect(texts(h.recorded)[0]).toBe('BEGIN READ ONLY');
    expect(texts(h.recorded)).not.toContain('COMMIT');
  });

  it("applies the profile's statement timeout, and clamps a junk value", async () => {
    const h = harness('read', [{ rows: [] }], 2_500);
    await h.runner.run({ kind: 'get', resource: 'customers', id: '1' });
    expect(texts(h.recorded)).toContain('SET LOCAL statement_timeout = 2500');

    expect(statementTimeoutMs(undefined)).toBe(DEFAULT_DATA_TIMEOUT_MS);
    expect(statementTimeoutMs(0)).toBe(DEFAULT_DATA_TIMEOUT_MS);
    expect(statementTimeoutMs(-1)).toBe(DEFAULT_DATA_TIMEOUT_MS);
    expect(statementTimeoutMs(1.5)).toBe(DEFAULT_DATA_TIMEOUT_MS);
    expect(statementTimeoutMs(MAX_DATA_TIMEOUT_MS + 1)).toBe(DEFAULT_DATA_TIMEOUT_MS);
    expect(statementTimeoutMs(MAX_DATA_TIMEOUT_MS)).toBe(MAX_DATA_TIMEOUT_MS);
  });

  it('binds a row id as a parameter rather than interpolating it', async () => {
    const h = harness('read', [{ rows: [{ id: 7 }] }]);
    await h.runner.run({ kind: 'get', resource: 'customers', id: '7' });
    const data = h.recorded.find((r) => r.text.startsWith('SELECT'));
    expect(data?.values).toEqual(['7']);
    expect(data?.text).toContain('$1');
  });

  it('rejects an id that cannot be the key type before any statement runs', async () => {
    const h = harness('read', [{ rows: [] }]);
    const result = await h.runner.run({ kind: 'get', resource: 'customers', id: "7' OR true --" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    // The pre-flight rejected it: nothing was sent to the database at all.
    expect(texts(h.recorded).some((s) => s.startsWith('SELECT'))).toBe(false);
  });

  it('refuses a mutation on a read-only worker without touching the pool', async () => {
    const h = harness('read');
    const result = await h.runner.run({
      kind: 'insert',
      resource: 'customers',
      values: { name: 'Ada' },
    });
    expect(result).toEqual({
      ok: false,
      status: 403,
      code: 'forbidden',
      message: 'Row editing is not enabled for this profile.',
    });
    expect(h.connects).toBe(0);
    expect(h.recorded).toEqual([]);
  });

  it('commits a write on a readwrite worker, in a read/write transaction', async () => {
    const h = harness('readwrite', [{ rows: [{ id: 3, name: 'Grace' }] }]);
    const result = await h.runner.run({
      kind: 'insert',
      resource: 'customers',
      values: { name: 'Grace' },
    });
    expect(result).toEqual({ ok: true, status: 201, body: { id: 3, name: 'Grace' } });
    const statements = texts(h.recorded);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).not.toContain('ROLLBACK');
  });

  it('rolls back explicitly when the outcome is a database error, and hides its detail', async () => {
    const h = harness('readwrite', [
      pgError('23505', 'duplicate key value violates unique constraint "customers_email_key"'),
    ]);
    const result = await h.runner.run({
      kind: 'insert',
      resource: 'customers',
      values: { name: 'Ada', email: 'ada@example.com' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe('conflict');
    // No constraint name, no column name, no value the caller typed.
    expect(result.message).not.toMatch(/customers_email_key|ada@example\.com|email/);
    const statements = texts(h.recorded);
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });

  it('re-authors a 404 so it carries neither the id nor the resource name', async () => {
    const h = harness('readwrite', [{ rows: [] }]);
    const result = await h.runner.run({
      kind: 'update',
      resource: 'customers',
      id: '4242',
      values: { name: 'Ada' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(result.code).toBe('not_found');
    expect(result.message).not.toContain('4242');
    expect(result.message).not.toContain('customers');
    expect(texts(h.recorded)).not.toContain('COMMIT');
  });

  it('drops the raw database text an unclassified error would log, keeping the row value out', async () => {
    // A class-22 data exception is deliberately unclassified by @kozou/core, so
    // the handler logs its raw message — which contains the offending VALUE —
    // and returns a 500. The runner must swallow that write and emit only a
    // value-free breadcrumb.
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);

    const h = harness('readwrite', [
      pgError('22007', 'invalid input syntax for type date: "1999-99-99"'),
    ]);
    const result = await h.runner.run({
      kind: 'insert',
      resource: 'customers',
      values: { name: 'Ada', joined_on: '1999-99-99' },
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
    expect(texts(h.recorded).at(-1)).toBe('ROLLBACK');
  });

  it('passes a 400 through: it describes the input, not the database', async () => {
    const h = harness('readwrite');
    const result = await h.runner.run({
      kind: 'insert',
      resource: 'customers',
      values: { id: 'not-a-number', name: 'Ada' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.code).toBe('bad_request');
    expect(result.message).toContain('not-a-number');
  });

  it('reports an unknown resource as a plain 404 and never reaches the pool', async () => {
    const h = harness('read');
    const result = await h.runner.run({ kind: 'list', resource: 'nope' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(result.message).not.toContain('nope');
  });

  it('releases the connection on every path', async () => {
    const clients: FakeClient[] = [];
    const recorded: Recorded[] = [];
    const pool: DataPool = {
      connect: async () => {
        const client = new FakeClient(recorded, [pgError('42501', 'permission denied for table customers')]);
        clients.push(client);
        return client;
      },
      end: async () => {},
    };
    const runner = createDataRunner({ pool, lookup: lookupOf(CUSTOMERS), capability: 'readwrite' });
    const result = await runner.run({ kind: 'delete', resource: 'customers', id: '1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.message).not.toContain('customers');
    expect(clients.every((c) => c.released)).toBe(true);
  });

  it('does not claim a lost COMMIT kept nothing, and logs only its SQLSTATE', async () => {
    // A COMMIT can fail two ways that look identical from here: the server
    // refused it (a deferred constraint), or it committed and the reply was
    // lost. Reporting "no changes were kept" would invite a duplicate insert.
    // The refusal case can also carry row VALUES — a constraint trigger doing
    // RAISE EXCEPTION '... %', NEW.col — so nothing but the SQLSTATE is logged.
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);

    const recorded: Recorded[] = [];
    const pool: DataPool = {
      connect: async () => new FailingCommitClient(recorded, [{ rows: [{ id: 1 }] }]),
      end: async () => {},
    };
    const runner = createDataRunner({ pool, lookup: lookupOf(CUSTOMERS), capability: 'readwrite' });
    const result = await runner.run({
      kind: 'insert',
      resource: 'customers',
      values: { name: 'Ada', email: 'ada@example.com' },
    });
    spy.mockRestore();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/may or may not have been applied/i);
    expect(result.message).not.toMatch(/No changes were kept/);
    const log = written.join('');
    expect(log).toContain('sqlstate 23514');
    expect(log).not.toContain('ada@example.com');
    expect(log).not.toContain('trigger says');
  });

  it('keeps a read result when only its closing ROLLBACK fails', async () => {
    // A read has nothing to commit: its rows were already fetched inside a
    // READ ONLY transaction, so a broken connection at close time does not
    // invalidate them.
    const recorded: Recorded[] = [];
    const pool: DataPool = {
      connect: async () => new FailingCommitClient(recorded, [{ rows: [{ id: 1 }] }]),
      end: async () => {},
    };
    const runner = createDataRunner({ pool, lookup: lookupOf(CUSTOMERS), capability: 'read' });
    const result = await runner.run({ kind: 'get', resource: 'customers', id: '1' });
    expect(result).toEqual({ ok: true, status: 200, body: { id: 1 } });
  });

  it('pins the restated page-size ceiling against @kozou/api', () => {
    // main validates pageSize without importing @kozou/api (the write-capable
    // package must stay out of that bundle), so the restated constant is only
    // as good as this pin. A test file is free to import the real one.
    expect(DATA_MAX_PAGE_SIZE).toBe(MAX_PAGE_SIZE);
  });

  it('reports an unreachable database as unavailable, redacting the connection secret', async () => {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
    const pool: DataPool = {
      connect: async () => {
        throw new Error('connect ECONNREFUSED for postgresql://app:s3cr3t@localhost:5432/db');
      },
      end: async () => {},
    };
    const runner = createDataRunner({
      pool,
      lookup: lookupOf(CUSTOMERS),
      capability: 'read',
      redact: (message) => message.split('s3cr3t').join('***'),
    });
    const result = await runner.run({ kind: 'list', resource: 'customers' });
    spy.mockRestore();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.code).toBe('unavailable');
    expect(written.join('')).not.toContain('s3cr3t');
  });
});
