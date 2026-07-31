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
  child: DataWorkerHandle;
  /** What the child was forked as. Compared against the store on every call. */
  capability: DataCapability;
  /** Resolves when the child reported a successful open; rejects with an
   *  already-sanitized reason when it did not. */
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

    let entry: Entry;
    try {
      entry = this.ensure(name, capability);
    } catch (err) {
      // Fork-time failures: an unknown profile, or a keychain refusal while
      // rebuilding the connection URL.
      return unavailable(err instanceof Error ? err.message : String(err));
    }

    try {
      await entry.opened;
    } catch (err) {
      return unavailable(err instanceof Error ? err.message : String(err));
    }
    if (entry.discarded) return unavailable('The row data worker was stopped.');

    const id = (this.nextRequestId += 1);
    const budget = operationBudgetMs(this.timeoutMs(name));
    return new Promise<DataResult>((resolve) => {
      const timer = setTimeout(() => {
        if (entry.pending.delete(id)) {
          resolve(unavailable(`The operation did not finish within ${budget}ms.`, 504));
        }
      }, budget);
      entry.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      const request: DataWorkerInbound = { type: 'run', id, op };
      entry.child.postMessage(request);
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

    // The URL is rebuilt (and the password decrypted) only here, at fork time.
    const connection = this.store.connectionUrl(name);
    const child = this.fork(this.workerPath(), {
      env: { [ENV_URL]: connection.url, [ENV_ROW_ACCESS]: capability },
      serviceName: 'kozou-desktop-data',
      stdio: 'pipe',
    });

    const entry: Entry = {
      child,
      capability,
      opened: Promise.resolve(),
      pending: new Map(),
      logTail: [],
      droppedLines: 0,
      discarded: false,
    };
    const openBudget = openBudgetMs(connection.timeoutMs);
    entry.opened = new Promise<void>((resolve, reject) => {
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
    // The rejection is delivered to every caller that awaits `opened`; keep the
    // promise itself from counting as unhandled before the first one arrives.
    entry.opened.catch(() => {});

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

    this.entries.set(name, entry);
    const open: DataWorkerInbound = {
      type: 'open',
      schemas: connection.schemas,
      ...(connection.timeoutMs !== undefined ? { timeoutMs: connection.timeoutMs } : {}),
    };
    child.postMessage(open);
    return entry;
  }

  private discard(name: string, reason: string): void {
    const entry = this.entries.get(name);
    if (entry === undefined) return;
    this.entries.delete(name);
    entry.discarded = true;
    this.settleAll(entry, reason);
    entry.child.kill();
  }

  private settleAll(entry: Entry, reason: string): void {
    for (const [id, pending] of [...entry.pending.entries()]) {
      entry.pending.delete(id);
      pending(unavailable(reason));
    }
  }
}
