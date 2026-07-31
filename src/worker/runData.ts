// The row-data core: one resident process per opted-in profile owns a small
// connection pool and answers a closed set of operations by delegating to
// @kozou/api's framework-agnostic request handler. Kept free of Electron so
// the integration test can drive it in plain Node — the same philosophy as
// runMcpServer.ts.
//
// Four disciplines live here, each load-bearing (see EGRESS.md items 8 and 12):
//
//   1. The transaction is ours. handleApiRequest opens none, so every
//      operation runs inside an explicit BEGIN — and every read path uses
//      `BEGIN READ ONLY`, which makes read-only a database-enforced property
//      rather than a promise about our SQL (a writable view or a volatile
//      function cannot sneak a write in). `SET LOCAL ROLE` is deliberately
//      never issued: the desktop is a one-credential model with no JWT or
//      claims surface.
//   2. COMMIT/ROLLBACK follows the RESULT STATUS, not exceptions. The handler
//      absorbs database errors into a 4xx *return value*, which leaves the
//      transaction aborted — so `status >= 400` is an explicit ROLLBACK, and
//      the connection is usable again for the next operation.
//   3. The handler writes the raw database message to process.stderr before
//      mapping it, and a class-22 error (an invalid date, say) carries the
//      offending row VALUE. Every handler call therefore runs with stderr
//      silenced; only a fixed, value-free breadcrumb is written instead.
//   4. Error bodies are re-authored. The handler's own 404/405 bodies name the
//      resource and the primary key it was given, so every failure except a
//      400 becomes a fixed sentence. A 400 is passed through: it is either a
//      pre-flight/constraint message or a description of the input the user
//      just typed.

import {
  buildResourceLookup,
  handleApiRequest,
  type ApiHttpRequest,
  type ApiHttpResult,
  type Queryable,
  type ResourceLookup,
} from '@kozou/api';
import { Pool } from 'pg';
import {
  DATA_LOG_PREFIX,
  type DataCapability,
  type DataErrorCode,
  type DataListParams,
  type DataOperation,
  type DataResult,
} from '../shared/types.js';
import { sanitizeErrorMessage } from '../shared/url.js';
import { runInspect } from './runInspect.js';

const LOG_PREFIX = DATA_LOG_PREFIX;

/** Default per-statement timeout for a data transaction. Matches the
 *  introspection default in @kozou/introspect; a profile's own timeoutMs
 *  overrides it. */
export const DEFAULT_DATA_TIMEOUT_MS = 10_000;

/** Ceiling for the per-statement timeout, mirroring the profile store's
 *  MAX_TIMEOUT_MS. A value outside the range falls back to the default rather
 *  than reaching the database. */
export const MAX_DATA_TIMEOUT_MS = 300_000;

/** Two connections: one for the operation in flight, one so a browse request
 *  arriving during a slow one is not serialized behind it. More would only
 *  multiply the credential's footprint on the server. */
const POOL_MAX = 2;

/** Budget for acquiring a connection. PostgreSQL's `statement_timeout` starts
 *  once a statement runs, so connect has to be bounded separately or a stalled
 *  network path hangs an operation with nothing to cut it short. */
const CONNECT_TIMEOUT_MS = 10_000;

/** A pooled client: queryable and returnable. A pg PoolClient satisfies it. */
export type DataClient = Queryable & { release(err?: boolean | Error): void };

/** The structural slice of a connection pool the runner needs — narrow so
 *  tests can drive the transaction envelope with a fake. */
export type DataPool = {
  connect(): Promise<DataClient>;
  end(): Promise<void>;
};

export type DataRunnerOptions = {
  pool: DataPool;
  lookup: ResourceLookup;
  capability: DataCapability;
  /** Per-statement timeout (ms) applied inside every data transaction. */
  timeoutMs?: number;
  /** Masks connection secrets in a message before it is logged. Identity by
   *  default; openDataRunner supplies the profile's URL-aware scrubber. */
  redact?: (message: string) => string;
};

export type DataRunnerConfig = {
  /** Full connection URL (with password). Callers keep it out of argv/logs. */
  url: string;
  schemas: string[];
  capability: DataCapability;
  timeoutMs?: number;
};

export type DataRunner = {
  readonly capability: DataCapability;
  run(op: DataOperation): Promise<DataResult>;
  close(): Promise<void>;
};

/** Controlled replacement for every failure status except 400. The handler's
 *  own message is discarded here: 403 must not confirm what exists, 404 must
 *  not distinguish "no row" from "hidden by a row-level security policy", and
 *  405/409 bodies echo identifiers. */
const FIXED_FAILURE: Record<number, { code: DataErrorCode; message: string }> = {
  403: { code: 'forbidden', message: 'The database denied permission for this operation.' },
  404: {
    code: 'not_found',
    message: 'No matching row. It may not exist, or a row-level security policy may hide it.',
  },
  405: { code: 'read_only', message: 'This resource does not accept that operation.' },
  409: {
    code: 'conflict',
    message: 'The change conflicts with existing data (a unique or foreign-key constraint).',
  },
};

const GENERIC_FAILURE = 'The operation failed. No changes were kept.';

/** Used only where "no changes were kept" would be a claim we cannot make: if
 *  the COMMIT acknowledgment is lost, the server may well have committed. */
const COMMIT_UNKNOWN =
  'The connection was lost while committing. The change may or may not have been applied — reload the rows before retrying.';

type StderrWrite = typeof process.stderr.write;

let silenceDepth = 0;
let realStderrWrite: StderrWrite | undefined;
const noopWrite = ((): boolean => true) as unknown as StderrWrite;

/** Silence process.stderr for the duration of `fn`.
 *
 *  @kozou/api logs the raw database message before mapping it (handler.ts),
 *  and an unclassified error — every class-22 data exception, for instance —
 *  carries the offending value. Depth-counted so concurrent operations in one
 *  process cannot restore the real writer while another is still inside. */
export async function withSilencedStderr<T>(fn: () => Promise<T>): Promise<T> {
  if (silenceDepth === 0) {
    realStderrWrite = process.stderr.write;
    process.stderr.write = noopWrite;
  }
  silenceDepth += 1;
  try {
    return await fn();
  } finally {
    silenceDepth -= 1;
    if (silenceDepth === 0 && realStderrWrite !== undefined) {
      process.stderr.write = realStderrWrite;
      realStderrWrite = undefined;
    }
  }
}

/** Log a breadcrumb that carries no row data: what happened, and nothing the
 *  database said about the values involved. Every line written from this
 *  process carries LOG_PREFIX, which is also main's allowlist for what may
 *  reach the app log — so a caller must not hand this a raw database message. */
function breadcrumb(detail: string): void {
  process.stderr.write(`${LOG_PREFIX} ${detail}\n`);
}

/** The SQLSTATE of a database error, or 'unknown'. This is the ONLY part of a
 *  statement-phase error that is safe to log: a message raised at COMMIT time —
 *  a DEFERRABLE INITIALLY DEFERRED constraint, or a constraint trigger doing
 *  `RAISE EXCEPTION '... %', NEW.col` — can quote the row's own values, and
 *  those must reach neither a log nor the UI. A five-character SQLSTATE cannot. */
function sqlstateOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
}

function isWrite(op: DataOperation): boolean {
  return op.kind === 'insert' || op.kind === 'update' || op.kind === 'delete';
}

/** Clamp the per-statement timeout to a plain integer. `SET LOCAL` has no
 *  bound-parameter form, so the value is interpolated into the statement — it
 *  must be, and is, an integer this function produced. */
export function statementTimeoutMs(raw: number | undefined): number {
  if (raw === undefined || !Number.isInteger(raw) || raw <= 0 || raw > MAX_DATA_TIMEOUT_MS) {
    return DEFAULT_DATA_TIMEOUT_MS;
  }
  return raw;
}

/** Turn list controls into the REST layer's query grammar. `count=none` is
 *  unconditional: a COUNT(*) is an unbounded cost on a browse surface, and the
 *  UI pages with keyset cursors instead. */
function listQuery(params: DataListParams | undefined): URLSearchParams {
  const query = new URLSearchParams();
  query.set('count', 'none');
  if (params?.pageSize !== undefined) query.set('pageSize', String(params.pageSize));
  if (params?.sort !== undefined) query.set('sort', params.sort);
  if (params?.after !== undefined) query.set('after', params.after);
  if (params?.before !== undefined) query.set('before', params.before);
  if (params?.search !== undefined) query.set('search', params.search);
  for (const [column, expression] of params?.filters ?? []) query.append(column, expression);
  return query;
}

/** Build the handler's pure-data request. Path segments are passed already
 *  decoded (there is no URL to parse), so an identifier containing a slash or
 *  a percent sign needs no escaping to travel safely. */
function buildRequest(op: DataOperation): ApiHttpRequest {
  switch (op.kind) {
    case 'list':
      return { method: 'GET', segments: [op.resource], query: listQuery(op.params) };
    case 'get':
      return { method: 'GET', segments: [op.resource, op.id], query: new URLSearchParams() };
    case 'insert':
      return {
        method: 'POST',
        segments: [op.resource],
        query: new URLSearchParams(),
        body: op.values,
      };
    case 'update':
      return {
        method: 'PATCH',
        segments: [op.resource, op.id],
        query: new URLSearchParams(),
        body: op.values,
      };
    case 'delete':
      return { method: 'DELETE', segments: [op.resource, op.id], query: new URLSearchParams() };
  }
}

/** The 400 case is the only one whose message survives: it describes the
 *  input, not the database's internals. */
function messageFromBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

function toResult(result: ApiHttpResult): DataResult {
  if (result.status < 400) return { ok: true, status: result.status, body: result.body };
  if (result.status === 400) {
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: messageFromBody(result.body) ?? GENERIC_FAILURE,
    };
  }
  const fixed = FIXED_FAILURE[result.status];
  return fixed !== undefined
    ? { ok: false, status: result.status, code: fixed.code, message: fixed.message }
    : { ok: false, status: result.status, code: 'failed', message: GENERIC_FAILURE };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Wire a runner onto an existing pool and resource lookup. The app path goes
 *  through openDataRunner; this entry point exists so the transaction envelope
 *  can be unit-tested without a database. */
export function createDataRunner(options: DataRunnerOptions): DataRunner {
  const { pool, lookup, capability } = options;
  const timeout = statementTimeoutMs(options.timeoutMs);
  const redact = options.redact ?? ((message: string): string => message);

  return {
    capability,

    async run(op: DataOperation): Promise<DataResult> {
      const write = isWrite(op);
      // Second half of a deliberate double check: main refuses a mutation on a
      // profile that is not opted in, and a worker forked for 'read' refuses it
      // again — its capability cannot be widened by any message.
      if (write && capability !== 'readwrite') {
        return {
          ok: false,
          status: 403,
          code: 'forbidden',
          message: 'Row editing is not enabled for this profile.',
        };
      }

      const request = buildRequest(op);
      let client: DataClient;
      try {
        client = await pool.connect();
      } catch (err) {
        // No statement has run yet, so this message cannot quote a row value —
        // it can quote the connection URL, which is what `redact` removes. It
        // is kept in full because "why can't it connect" is the one failure an
        // operator can actually act on.
        breadcrumb(`could not open a connection: ${redact(errorText(err))}`);
        return { ok: false, status: 503, code: 'unavailable', message: GENERIC_FAILURE };
      }

      try {
        // READ ONLY for every read path — including a read issued by a
        // readwrite worker, which is the common case in a browse-then-edit
        // session.
        await client.query(write ? 'BEGIN' : 'BEGIN READ ONLY');
        await client.query(`SET LOCAL statement_timeout = ${timeout}`);
        const result = await withSilencedStderr(() =>
          handleApiRequest({ db: client, lookup, logPrefix: LOG_PREFIX }, request),
        );
        if (result.status >= 400) {
          // The transaction is either aborted (a database error) or holds a
          // change that must not land (a 4xx we authored) — roll back
          // explicitly rather than rely on COMMIT-on-aborted behaving like one.
          await client.query('ROLLBACK');
          if (result.status >= 500) breadcrumb(`operation failed with status ${result.status}`);
          return toResult(result);
        }
        // A read never commits: there is nothing to commit, and "reads do not
        // commit" is then a property of this code rather than of the SQL.
        try {
          await client.query(write ? 'COMMIT' : 'ROLLBACK');
        } catch (err) {
          breadcrumb(`${write ? 'commit' : 'read rollback'} failed (sqlstate ${sqlstateOf(err)})`);
          // A failing COMMIT is its own outcome, not a generic failure. Two
          // cases hide here and the client side cannot tell them apart: the
          // server refused the commit (a deferred constraint fired), or it
          // committed and the acknowledgment was lost with the connection.
          // Claiming "no changes were kept" would be a guess that invites the
          // operator to repeat an insert that already landed.
          if (write) return { ok: false, status: 500, code: 'failed', message: COMMIT_UNKNOWN };
          // A read has nothing to commit: its rows were already fetched inside
          // a READ ONLY transaction, so a failing close does not invalidate
          // them. Report the rows, not a failure.
        }
        return toResult(result);
      } catch (err) {
        // The envelope's own statements land here (the handler maps its own
        // failures into a status). A statement-phase message may quote row
        // values — a constraint trigger can raise one — so only the SQLSTATE is
        // logged, never the text.
        breadcrumb(`transaction failed (sqlstate ${sqlstateOf(err)})`);
        try {
          await client.query('ROLLBACK');
        } catch {
          // The connection is already gone; releasing it below is enough.
        }
        return { ok: false, status: 500, code: 'failed', message: GENERIC_FAILURE };
      } finally {
        client.release();
      }
    },

    close(): Promise<void> {
      return pool.end();
    },
  };
}

/** Open a runner against a real database: introspect once to build the
 *  identifier allowlist, then hold a small pool for the process's lifetime.
 *
 *  The lookup is derived from the database itself, never from anything the
 *  renderer sent: only resources and columns that exist are addressable, and
 *  every value travels as a bound parameter (@kozou/api's guarantee, inherited
 *  here unchanged). */
export async function openDataRunner(config: DataRunnerConfig): Promise<DataRunner> {
  const { context } = await runInspect({
    url: config.url,
    schemas: config.schemas,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  });
  const lookup = buildResourceLookup(context);
  const pool = new Pool({
    connectionString: config.url,
    max: POOL_MAX,
    // Acquiring a connection is outside `statement_timeout`, so without this a
    // stalled network path would block an operation indefinitely — the parent's
    // hang guard would fire while the worker stayed stuck on connect.
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  // A pool whose idle client is dropped by the server emits 'error' on the
  // pool itself; without a listener that is an unhandled error event and takes
  // the worker down mid-session. An idle-connection error carries no row values
  // (no statement is in flight), only possibly the connection URL.
  pool.on('error', (err) => {
    breadcrumb(`idle connection error: ${sanitizeErrorMessage(errorText(err), config.url)}`);
  });
  return createDataRunner({
    pool,
    lookup,
    capability: config.capability,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    redact: (message) => sanitizeErrorMessage(message, config.url),
  });
}
