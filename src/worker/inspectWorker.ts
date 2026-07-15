// utilityProcess entry: one short-lived worker per inspection run (one
// profile = one short-lived process; contexts for different databases are
// never mixed in one process). The connection URL arrives via env only
// (never argv, never in the IPC message); the reply is the trimmed
// SchemaContext plus measurements. The process exits after a single request.

import processGlobal from 'node:process';
import { trimContext } from '../shared/trim.js';
import { sanitizeErrorMessage } from '../shared/url.js';
import type { InspectResult, WorkerRequest } from '../shared/types.js';
import { runInspect } from './runInspect.js';

const ENV_KEY = 'KOZOU_DESKTOP_DB_URL';

type ParentPort = {
  once(event: 'message', listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};

const parentPort = (processGlobal as unknown as { parentPort: ParentPort }).parentPort;

parentPort.once('message', (e) => {
  void handle(e.data as WorkerRequest);
});

async function handle(req: WorkerRequest): Promise<void> {
  const url = processGlobal.env[ENV_KEY];
  // Drop the secret from our own env immediately; runInspect already holds it.
  delete processGlobal.env[ENV_KEY];

  let result: InspectResult;
  if (!url) {
    result = { ok: false, error: 'worker started without a connection URL' };
  } else {
    try {
      const { context, timings } = await runInspect({
        url,
        schemas: req.schemas,
        timeoutMs: req.timeoutMs,
      });
      const fullJson = JSON.stringify(context);
      const trimmed = trimContext(context as unknown as Record<string, unknown>);
      const trimmedJson = JSON.stringify(trimmed);
      result = {
        ok: true,
        context: trimmed,
        stats: {
          introspectMs: timings.introspectMs,
          buildMs: timings.buildMs,
          fullBytes: Buffer.byteLength(fullJson),
          trimmedBytes: Buffer.byteLength(trimmedJson),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { ok: false, error: sanitizeErrorMessage(message, url) };
    }
  }

  parentPort.postMessage(result);
  // Give the message a beat to flush, then exit — the worker is single-shot.
  setTimeout(() => processGlobal.exit(0), 50);
}
