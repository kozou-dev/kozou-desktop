// Spawn one short-lived introspection worker (Electron utilityProcess) per
// request. The connection URL is passed via env only; the worker env is
// otherwise minimal (no inherited shell env — the worker needs nothing else).
//
// Termination is event-driven: the parent kills the worker after receiving
// its single reply (no flush timers inside the worker — a timer would race
// large payloads).

import { utilityProcess } from 'electron';
import type { InspectResult, WorkerRequest } from '../shared/types.js';

const ENV_KEY = 'KOZOU_DESKTOP_DB_URL';

/** Introspection issues many statements (typically 10-15), and PostgreSQL's
 *  statement_timeout applies per statement — so a slow-but-alive database can
 *  legitimately take several multiples of `timeoutMs`. The overall budget is
 *  a hang guard, not a UX timeout: per-statement budget times a generous
 *  statement-count bound, plus connect/build margin. */
const STATEMENT_COUNT_BOUND = 16;
const CONNECT_BUILD_MARGIN_MS = 15_000;

export function workerBudgetMs(timeoutMs: number | undefined): number {
  return (timeoutMs ?? 10_000) * STATEMENT_COUNT_BOUND + CONNECT_BUILD_MARGIN_MS;
}

export function runInspectWorker(
  workerPath: string,
  connection: { url: string; schemas: string[]; timeoutMs?: number },
): Promise<InspectResult> {
  return new Promise((resolve) => {
    const child = utilityProcess.fork(workerPath, [], {
      env: { [ENV_KEY]: connection.url },
      serviceName: 'kozou-desktop-inspect',
    });

    const budget = workerBudgetMs(connection.timeoutMs);
    let settled = false;
    const finish = (result: InspectResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
      // Single-shot worker: the parent owns termination (safe if already dead).
      child.kill();
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: `introspection did not finish within ${budget}ms (hang guard)` });
    }, budget);

    child.once('message', (message: unknown) => {
      finish(message as InspectResult);
    });
    child.once('exit', (code: number) => {
      finish({ ok: false, error: `worker exited before replying (code ${code})` });
    });

    const request: WorkerRequest = {
      schemas: connection.schemas,
      ...(connection.timeoutMs !== undefined ? { timeoutMs: connection.timeoutMs } : {}),
    };
    child.postMessage(request);
  });
}
