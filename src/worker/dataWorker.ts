// utilityProcess entry: one resident row-data process per opted-in profile
// (one profile = one process, so databases are never mixed in one process and
// the env-only secret channel stays one URL per fork). The connection URL and
// the row-access capability arrive via env only — never argv, never in an IPC
// message — and both are dropped from the environment as soon as they are
// read.
//
// The capability is fixed at fork time: a worker started for 'read' refuses
// every mutation no matter what the parent later asks for, and a change to a
// profile's grant restarts the worker instead of widening this one. The parent
// owns termination; the worker never exits by itself.

import processGlobal from 'node:process';
import type { DataCapability, DataWorkerInbound, DataWorkerOutbound } from '../shared/types.js';
import { sanitizeErrorMessage } from '../shared/url.js';
import { openDataRunner, type DataRunner } from './runData.js';

const ENV_URL = 'KOZOU_DESKTOP_DB_URL';
const ENV_ROW_ACCESS = 'KOZOU_DESKTOP_ROW_ACCESS';

type ParentPort = {
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};

const parentPort = (processGlobal as unknown as { parentPort: ParentPort }).parentPort;

/** Resolves once the runner is ready (or rejects if it never will). Set by the
 *  single 'open' message; every 'run' awaits it, so a request that races the
 *  startup introspection queues instead of failing. */
let opening: Promise<DataRunner> | undefined;

function post(message: DataWorkerOutbound): void {
  parentPort.postMessage(message);
}

parentPort.on('message', (e) => {
  void handle(e.data as DataWorkerInbound);
});

async function handle(message: DataWorkerInbound): Promise<void> {
  if (message.type === 'open') {
    await open(message);
    return;
  }
  if (message.type === 'run') {
    if (opening === undefined) {
      post({
        type: 'result',
        id: message.id,
        result: {
          ok: false,
          status: 503,
          code: 'unavailable',
          message: 'The row data worker is not open.',
        },
      });
      return;
    }
    try {
      const runner = await opening;
      post({ type: 'result', id: message.id, result: await runner.run(message.op) });
    } catch {
      // The startup failure was already reported through the 'opened' message;
      // answer the pending request with a value-free failure rather than
      // leaving the parent waiting on its hang guard.
      post({
        type: 'result',
        id: message.id,
        result: {
          ok: false,
          status: 503,
          code: 'unavailable',
          message: 'The row data worker is not available.',
        },
      });
    }
  }
}

async function open(message: Extract<DataWorkerInbound, { type: 'open' }>): Promise<void> {
  if (opening !== undefined) return; // idempotent: the parent opens once
  const url = processGlobal.env[ENV_URL];
  const capability = parseCapability(processGlobal.env[ENV_ROW_ACCESS]);
  // Drop both from our own env immediately; the pool holds the URL in memory
  // for the process's lifetime, and the capability lives in the runner.
  delete processGlobal.env[ENV_URL];
  delete processGlobal.env[ENV_ROW_ACCESS];

  if (url === undefined || url === '') {
    post({ type: 'opened', ok: false, error: 'worker started without a connection URL' });
    return;
  }
  if (capability === undefined) {
    // Fail closed: an unrecognized level must never be read as a grant.
    post({ type: 'opened', ok: false, error: 'worker started without a row-access grant' });
    return;
  }

  opening = openDataRunner({
    url,
    schemas: message.schemas,
    capability,
    ...(message.timeoutMs !== undefined ? { timeoutMs: message.timeoutMs } : {}),
  });
  try {
    await opening;
    post({ type: 'opened', ok: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    post({ type: 'opened', ok: false, error: sanitizeErrorMessage(detail, url) });
  }
  // Do not self-exit on failure: the parent owns termination, and an exit
  // timer would race the flush of the report message.
}

function parseCapability(raw: string | undefined): DataCapability | undefined {
  return raw === 'read' || raw === 'readwrite' ? raw : undefined;
}
