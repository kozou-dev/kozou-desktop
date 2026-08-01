// Which of a database's views are MATERIALIZED.
//
// @kozou/introspect reports relkind 'v' and 'm' as one kind — a materialized
// view is a read-only view for every purpose the semantic model has — so the
// raw record carries no way to tell them apart. Comment DDL does care:
// `COMMENT ON VIEW` is an error against a materialized view and vice versa, so
// emitting the wrong keyword produces SQL the operator's psql run rejects.
//
// Rather than ask upstream for a field the server product has no use for, the
// desktop establishes the one bit it needs with its own catalog query (the
// zero-changes-to-kozou rule this app is built under). Read-only, one
// statement, over its own short-lived connection: introspection owns its
// connection and has already closed it by the time this runs.
//
// Failure is reported as "unknown", never as "ordinary view" — see the return
// type. An inspect must not fail over a secondary fact, and a wrong keyword is
// worse than an absent one.

import { Client } from 'pg';
import type { RelationRef2 } from '../shared/trim.js';

export type RelkindOptions = {
  /** Full connection URL (with password). Callers keep it out of argv/logs. */
  url: string;
  schemas: string[];
  /** Per-statement timeout (ms). Defaults to introspection's own 10s. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

/** Budget for getting a connection. `statement_timeout` only starts once a
 *  statement runs, so a stalled TCP connect needs its own bound. */
const CONNECT_TIMEOUT_MS = 10_000;

/** The MATERIALIZED views in `schemas`, or `undefined` when the question could
 *  not be answered. The two are different claims and the caller must keep them
 *  apart: an empty array means "none are materialized", `undefined` means "the
 *  relkind of every view here is unknown".
 *
 *  Reported as (schema, name) pairs, never as a joined `schema.name` — a dot is
 *  legal inside a quoted identifier, and joining makes two different relations
 *  indistinguishable (see RelationRef2). */
export async function fetchMaterializedViews(
  opts: RelkindOptions,
): Promise<RelationRef2[] | undefined> {
  const timeout =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? Math.floor(opts.timeoutMs)
      : DEFAULT_TIMEOUT_MS;

  const client = new Client({
    connectionString: opts.url,
    statement_timeout: timeout,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: 'kozou-desktop',
  });

  try {
    await client.connect();
    // Inside `BEGIN READ ONLY`, like every other read this app makes. The
    // statement is a fixed SELECT, so the transaction adds nothing today — but
    // "introspection always runs read-only" is a guarantee the docs state
    // unconditionally, and a read that sits outside it makes that untrue for
    // part of every inspection.
    await client.query('BEGIN READ ONLY');
    try {
      const { rows } = await client.query<{ schema: string; name: string }>(
        `SELECT n.nspname AS schema, c.relname AS name
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'm'
            AND n.nspname = ANY($1::text[])`,
        [opts.schemas],
      );
      await client.query('COMMIT');
      return rows.map((r) => ({ schema: r.schema, name: r.name }));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } catch {
    // Deliberately silent and deliberately not fatal: the error text can quote
    // connection details, the inspect itself is unaffected, and the caller
    // renders "relkind unknown" rather than guessing.
    return undefined;
  } finally {
    await client.end().catch(() => {});
  }
}
