// Registry and lifecycle for the per-profile row-data workers.
//
// Ownership rules (deliberately close to mcpServerManager.ts, which this
// follows in shape as well as in philosophy):
//   - The manager owns every child it spawns and kills them all on app quit.
//   - A worker is forked lazily, on the first row-data operation for a
//     profile, and its capability is baked into the fork environment. The
//     capability in force is read from the store at call time, never taken
//     from the caller: a stale grant cannot be replayed, and a change to the
//     grant discards the worker instead of widening it.
//   - A worker is discarded (not restarted in place) whenever what it was
//     forked with stops being true: the profile's connection changed, its
//     grant changed, it was deleted, or the app is quitting. Unlike an MCP
//     server — user-visible state with an explicit start/stop — a data worker
//     is invisible plumbing, so the next operation simply forks a fresh one.
//
// Secrets: the connection URL and the capability travel to the child via env
// only (argv stays empty; the IPC messages carry schemas, an id and the
// operation). The child's stdio is piped, buffered to line boundaries and
// filtered down to the worker's own prefixed lines, and the tail NEVER reaches
// an IPC reply — an operation failure is always one of the controlled messages
// from runData.ts. Both rules exist for the same reason: raw database text can
// carry row values (a class-22 message quotes the offending value), and row
// data must reach neither the renderer nor a log.
//
// The Electron dependency is injected as a fork function (electronFork.ts) so
// the whole state machine is unit-testable with a fake child.

import {
  DATA_LOG_PREFIX,
  type DataCapability,
  type DataOperation,
  type DataResult,
  type DataWorkerInbound,
  type DataWorkerOutbound,
} from '../shared/types.js';
import { sanitizeErrorMessage } from '../shared/url.js';
import type { ProfileStore } from './profileStore.js';

const ENV_URL = 'KOZOU_DESKTOP_DB_URL';
const ENV_ROW_ACCESS = 'KOZOU_DESKTOP_ROW_ACCESS';
const LOG_TAIL_LINES = 20;

/** Introspection at open time issues many statements and PostgreSQL applies
 *  statement_timeout per statement, so the startup budget is a hang guard, not
 *  a UX timeout (the same reasoning as inspectRunner.ts). */
const OPEN_STATEMENT_COUNT_BOUND = 16;
const OPEN_MARGIN_MS = 15_000;

/** One operation is at most a handful of statements (BEGIN, SET LOCAL, the
 *  query, ROLLBACK/COMMIT), each bounded by statement_timeout. */
const OPERATION_STATEMENT_COUNT_BOUND = 4;
const OPERATION_MARGIN_MS = 5_000;

const DEFAULT_TIMEOUT_MS = 10_000;

export function openBudgetMs(timeoutMs: number | undefined): number {
  return (timeoutMs ?? DEFAULT_TIMEOUT_MS) * OPEN_STATEMENT_COUNT_BOUND + OPEN_MARGIN_MS;
}

export function operationBudgetMs(timeoutMs: number | undefined): number {
  return (timeoutMs ?? DEFAULT_TIMEOUT_MS) * OPERATION_STATEMENT_COUNT_BOUND + OPERATION_MARGIN_MS;
}

/** The structural slice of Electron's UtilityProcess the manager needs —
 *  narrow so tests can fake it. Unlike the MCP worker this one is a
 *  request/response channel, so the message listener stays attached. */
export type DataWorkerHandle = {
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  stdout?: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
};

export type DataWorkerFork = (
  modulePath: string,
  options: { env: Record<string, string>; serviceName: string; stdio: 'pipe' },
) => DataWorkerHandle;

type Entry = {
  /** Absent until the password is decrypted and the child forked. */
  child?: DataWorkerHandle;
  /** What the child was forked as. Compared against the store on every call. */
  capability: DataCapability;
  /** Resolves when the child reported a successful open; rejects with an
   *  already-sanitized reason when it did not, or when it was never forked. */
  opened: Promise<void>;
  pending: Map<number, (result: DataResult) => void>;
  /** Value-free lines the worker wrote about itself (see DATA_LOG_PREFIX). */
  logTail: string[];
  /** How many lines were dropped for not carrying the worker's own prefix.
   *  Counted rather than kept: their content is exactly what must not be
   *  logged, but their existence is worth knowing about. */
  droppedLines: number;
  discarded: boolean;
};

function unavailable(message: string, status = 503): DataResult {
  return { ok: false, status, code: 'unavailable', message };
}

export class DataWorkerManager {
  private readonly entries = new Map<string, Entry>();
  private nextRequestId = 0;

  constructor(
    private readonly store: ProfileStore,
    private readonly workerPath: () => string,
    private readonly fork: DataWorkerFork,
  ) {}

  /** Run one operation for a profile, forking its worker if needed. Never
   *  throws for a database or worker outcome: every failure is a controlled
   *  DataResult, so the renderer has nothing to interpret. */
  async run(name: string, op: DataOperation): Promise<DataResult> {
    let capability: DataCapability | 'off';
    try {
      capability = this.store.rowAccess(name);
    } catch (err) {
      return unavailable(err instanceof Error ? err.message : String(err));
    }
    if (capability === 'off') {
      // Fail closed. Main's own gate (assertRowAccess) rejects this before we
      // are called; reaching here would mean a caller skipped it.
      return {
        ok: false,
        status: 403,
        code: 'forbidden',
        message: 'Row data access is not enabled for this profile.',
      };
    }

    const entry = this.ensure(name, capability);

    try {
      // Fork-time failures (an unknown profile, a keychain refusal while
      // rebuilding the connection URL) land here too.
      await entry.opened;
    } catch (err) {
      return unavailable(err instanceof Error ? err.message : String(err));
    }
    // `opened` resolves only after the fork, so a live entry has its child.
    const child = entry.child;
    if (entry.discarded || child === undefined) return unavailable('The row data worker was stopped.');

    const id = (this.nextRequestId += 1);
    const budget = operationBudgetMs(this.timeoutMs(name));
    return new Promise<DataResult>((resolve) => {
      // A hang guard, not a cancellation: dropping the pending entry stops main
      // waiting, but the worker's transaction keeps running under the database's
      // own statement_timeout and a write may still commit afterwards. Cancelling
      // it for real would need a second connection issuing pg_cancel_backend —
      // deliberately not built here, so the message must not imply otherwise.
      const timer = setTimeout(() => {
        if (entry.pending.delete(id)) {
          resolve(
            unavailable(
              `The operation did not finish within ${budget}ms. It may still be running on the database.`,
              504,
            ),
          );
        }
      }, budget);
      entry.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      const request: DataWorkerInbound = { type: 'run', id, op };
      child.postMessage(request);
    });
  }

  /** A connection-relevant profile edit invalidates the worker's fork-time
   *  connection — drop it rather than keep reading the old database. The
   *  caller decides relevance (URL / schemas edits only). */
  onProfileUpserted(name: string): void {
    this.discard(name, 'The profile changed while the operation was in flight.');
  }

  onProfileRemoved(name: string): void {
    this.discard(name, 'The profile was removed.');
  }

  /** A grant change must never be applied to a running worker: its capability
   *  is fixed at fork time, so revocation and escalation both mean "discard". */
  onRowAccessChanged(name: string): void {
    this.discard(name, 'The row access level changed.');
  }

  stopAll(): void {
    for (const name of [...this.entries.keys()]) {
      this.discard(name, 'The row data worker was stopped.');
    }
  }

  /** Best-effort synchronous kill sweep for before-quit. */
  killAllSync(): void {
    this.stopAll();
  }

  private timeoutMs(name: string): number | undefined {
    return this.store.list().find((p) => p.name === name)?.timeoutMs;
  }

  private ensure(name: string, capability: DataCapability): Entry {
    const existing = this.entries.get(name);
    if (existing !== undefined) {
      if (existing.capability === capability) return existing;
      this.discard(name, 'The row access level changed.');
    }

    // Registered before the password is decrypted, which is asynchronous: an
    // operation arriving in the meantime finds this entry and shares its fork
    // instead of starting a second worker, and a discard in the meantime has
    // an entry to mark (open() checks the mark before it forks).
    const entry: Entry = {
      capability,
      opened: Promise.resolve(),
      pending: new Map(),
      logTail: [],
      droppedLines: 0,
      discarded: false,
    };
    this.entries.set(name, entry);
    entry.opened = this.open(name, entry);
    // A worker that failed to open must not become a permanent tombstone: it
    // deliberately stays resident on failure (the parent owns termination), so
    // leaving the entry in the registry would make every later operation await
    // the same rejection even after the database recovers — and would leak its
    // pool. Drop it and kill the child; the next operation forks a fresh one.
    // This also handles the open-timeout case, where the worker may still be
    // introspecting: killing it is what stops a late success from stranding a
    // live pool behind a rejected entry.
    //
    // The handler doubles as the unhandled-rejection guard: `opened` must have
    // a consumer before the first caller awaits it.
    entry.opened.catch(() => {
      if (this.entries.get(name) === entry) this.entries.delete(name);
      entry.discarded = true;
      this.settleAll(entry, 'The row data worker could not start.');
      entry.child?.kill();
    });
    return entry;
  }

  /** Decrypt the password, fork, and wait for the worker to report that it
   *  opened. */
  private async open(name: string, entry: Entry): Promise<void> {
    // The URL is rebuilt (and the password decrypted) only here, at fork time.
    const connection = await this.store.connectionUrl(name);
    // A discard during the decrypt has already dropped this entry. Forking now
    // would start a worker for a connection or a grant that is no longer
    // current, with nothing left in the registry to stop it.
    if (entry.discarded) throw new Error('The row data worker was stopped.');
    const child = this.fork(this.workerPath(), {
      env: { [ENV_URL]: connection.url, [ENV_ROW_ACCESS]: entry.capability },
      serviceName: 'kozou-desktop-data',
      stdio: 'pipe',
    });
    entry.child = child;

    const openBudget = openBudgetMs(connection.timeoutMs);
    const opened = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(new Error(error));
      };
      const timer = setTimeout(() => {
        finish(`The database did not answer within ${openBudget}ms.`);
      }, openBudget);

      child.on('message', (message: unknown) => {
        const reply = message as DataWorkerOutbound;
        if (reply.type === 'opened') {
          finish(reply.ok ? undefined : reply.error);
          return;
        }
        if (reply.type === 'result') {
          const pending = entry.pending.get(reply.id);
          if (pending === undefined) return; // already timed out
          entry.pending.delete(reply.id);
          pending(reply.result);
        }
      });
      child.on('exit', (code: number) => {
        // Ignore a stale child's exit: a discard/refork may already have
        // registered a newer one under this name.
        if (this.entries.get(name) === entry) this.entries.delete(name);
        finish(`The row data worker exited before it was ready (code ${code}).`);
        if (!entry.discarded) {
          // A crash: report it on main's own stderr (never in a reply) with the
          // worker's own value-free lines, and settle whatever was in flight.
          process.stderr.write(`${DATA_LOG_PREFIX} [${name}] worker exited (code ${code})\n`);
          for (const line of entry.logTail) process.stderr.write(`${line}\n`);
          if (entry.droppedLines > 0) {
            process.stderr.write(
              `${DATA_LOG_PREFIX} [${name}] ${entry.droppedLines} unrecognized output line(s) suppressed\n`,
            );
          }
          this.settleAll(entry, `The row data worker stopped unexpectedly (code ${code}).`);
        }
      });
    });

    // Buffer each stream to line boundaries before filtering: a secret (or a
    // line) straddling a chunk boundary must not evade the scrub. Only the
    // worker's own prefixed, value-free lines are kept — anything else is
    // counted and dropped, because row data must not reach a log at all.
    const makeTail = (): ((chunk: unknown) => void) => {
      let pendingText = '';
      return (chunk: unknown): void => {
        pendingText += String(chunk);
        const lines = pendingText.split('\n');
        pendingText = lines.pop() ?? '';
        for (const raw of lines) {
          const line = sanitizeErrorMessage(raw, connection.url).trimEnd();
          if (line.length === 0) continue;
          if (!line.startsWith(DATA_LOG_PREFIX)) {
            entry.droppedLines += 1;
            continue;
          }
          entry.logTail.push(line);
        }
        if (entry.logTail.length > LOG_TAIL_LINES) {
          entry.logTail.splice(0, entry.logTail.length - LOG_TAIL_LINES);
        }
      };
    };
    child.stderr?.on('data', makeTail());
    child.stdout?.on('data', makeTail());

    const open: DataWorkerInbound = {
      type: 'open',
      schemas: connection.schemas,
      ...(connection.timeoutMs !== undefined ? { timeoutMs: connection.timeoutMs } : {}),
    };
    child.postMessage(open);
    return opened;
  }

  private discard(name: string, reason: string): void {
    const entry = this.entries.get(name);
    if (entry === undefined) return;
    this.entries.delete(name);
    entry.discarded = true;
    this.settleAll(entry, reason);
    // No child yet means open() is still decrypting; it sees `discarded` and
    // does not fork.
    entry.child?.kill();
  }

  private settleAll(entry: Entry, reason: string): void {
    for (const [id, pending] of [...entry.pending.entries()]) {
      entry.pending.delete(id);
      pending(unavailable(reason));
    }
  }
}
