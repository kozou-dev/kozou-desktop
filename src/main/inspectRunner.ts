// Spawn one short-lived introspection worker (Electron utilityProcess) per
// request. The connection URL is passed via env only; the worker env is
// otherwise minimal (no inherited shell env — the worker needs nothing else).

import { utilityProcess } from 'electron';
import type { InspectResult, WorkerRequest } from '../shared/types.js';

const ENV_KEY = 'KOZOU_DESKTOP_DB_URL';
/** Margin on top of the introspection statement timeout before we give up
 *  on the whole worker (spawn + connect + queries + build). */
const WORKER_TIMEOUT_MARGIN_MS = 20_000;

export function runInspectWorker(
  workerPath: string,
  connection: { url: string; schemas: string[]; timeoutMs?: number },
): Promise<InspectResult> {
  return new Promise((resolve) => {
    const child = utilityProcess.fork(workerPath, [], {
      env: { [ENV_KEY]: connection.url },
      serviceName: 'kozou-desktop-inspect',
    });

    const budget = (connection.timeoutMs ?? 10_000) + WORKER_TIMEOUT_MARGIN_MS;
    let settled = false;
    const finish = (result: InspectResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: `introspection timed out after ${budget}ms` });
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
